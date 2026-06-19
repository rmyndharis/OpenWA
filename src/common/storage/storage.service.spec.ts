import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar-stream';
import { createGzip } from 'zlib';
import { Readable } from 'stream';
import { ConfigService } from '@nestjs/config';

// `archiver` v8 ships as ESM only, which ts-jest cannot parse when StorageService
// is imported transitively. These tests never exercise the export path (which is
// the only consumer of archiver), so a lightweight stub is sufficient.
jest.mock('archiver', () => ({ default: jest.fn() }));

import { StorageService } from './storage.service';

/** Build an in-memory gzipped tar archive from the given entries. */
function makeTarGz(entries: { name: string; data: string }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    let i = 0;
    const writeNext = (): void => {
      if (i >= entries.length) {
        pack.finalize();
        return;
      }
      const entry = entries[i++];
      pack.entry({ name: entry.name }, Buffer.from(entry.data), err => (err ? reject(err) : writeNext()));
    };
    const gzip = createGzip();
    const chunks: Buffer[] = [];
    pack.pipe(gzip);
    gzip.on('data', (c: Buffer) => chunks.push(c));
    gzip.on('end', () => resolve(Buffer.concat(chunks)));
    gzip.on('error', reject);
    writeNext();
  });
}

describe('StorageService (local) path traversal protection', () => {
  let baseDir: string;
  let localPath: string;
  let service: StorageService;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-storage-'));
    localPath = path.join(baseDir, 'media');
    const configService = {
      get: (key: string) => {
        if (key === 'storage.type') return 'local';
        if (key === 'storage.localPath') return localPath;
        return undefined;
      },
    } as unknown as ConfigService;
    service = new StorageService(configService);
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('writes a file within the storage root', async () => {
    await service.putFile('sub/ok.txt', Buffer.from('hi'));
    expect(fs.readFileSync(path.join(localPath, 'sub/ok.txt'), 'utf8')).toBe('hi');
  });

  it('rejects writing a file outside the storage root', async () => {
    await expect(service.putFile('../escape.txt', Buffer.from('x'))).rejects.toThrow();
    expect(fs.existsSync(path.join(baseDir, 'escape.txt'))).toBe(false);
  });

  it('rejects reading a file outside the storage root', async () => {
    // A real file that exists OUTSIDE the storage root; without containment the
    // service would happily read it via "..".
    fs.writeFileSync(path.join(baseDir, 'secret.txt'), 'topsecret');
    await expect(service.getFile('../secret.txt')).rejects.toThrow();
  });

  it('imports safe entries but refuses tar entries that escape the storage root', async () => {
    const gz = await makeTarGz([
      { name: 'safe.txt', data: 'good' },
      { name: '../evil.txt', data: 'bad' },
    ]);

    const count = await service.importFromStream(Readable.from(gz));

    expect(fs.readFileSync(path.join(localPath, 'safe.txt'), 'utf8')).toBe('good');
    expect(fs.existsSync(path.join(baseDir, 'evil.txt'))).toBe(false);
    expect(count).toBe(1);
  });
});

function makeLocalService(): { service: StorageService; baseDir: string; localPath: string } {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-storage-'));
  const localPath = path.join(baseDir, 'media');
  const configService = {
    get: (key: string) => (key === 'storage.type' ? 'local' : key === 'storage.localPath' ? localPath : undefined),
  } as unknown as ConfigService;
  return { service: new StorageService(configService), baseDir, localPath };
}

describe('StorageService put/getFile containment is backend-agnostic', () => {
  // Force S3 routing with a stub client so the assertion proves the guard runs BEFORE any S3 call
  // (i.e. it lives in put/getFile, so the otherwise-unguarded S3 backend is contained too).
  function s3Stub(service: StorageService): jest.Mock {
    const sendMock = jest.fn();
    const internal = service as unknown as { storageType: string; s3Client: unknown; s3Available: boolean };
    internal.storageType = 's3';
    internal.s3Client = { send: sendMock };
    internal.s3Available = true;
    return sendMock;
  }

  it('putFile rejects an unsafe key before reaching the S3 backend', async () => {
    const { service, baseDir } = makeLocalService();
    const sendMock = s3Stub(service);

    await expect(service.putFile('../evil', Buffer.from('x'))).rejects.toThrow();
    expect(sendMock).not.toHaveBeenCalled();

    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('getFile rejects an unsafe key before reaching the S3 backend', async () => {
    const { service, baseDir } = makeLocalService();
    const sendMock = s3Stub(service);

    await expect(service.getFile('../../etc/passwd')).rejects.toThrow();
    expect(sendMock).not.toHaveBeenCalled();

    fs.rmSync(baseDir, { recursive: true, force: true });
  });
});

describe('StorageService import resource caps (decompression-bomb defense)', () => {
  let baseDir: string;
  let localPath: string;
  let service: StorageService;

  beforeEach(() => {
    ({ service, baseDir, localPath } = makeLocalService());
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
    delete process.env.STORAGE_IMPORT_MAX_BYTES;
    delete process.env.STORAGE_IMPORT_MAX_ENTRIES;
  });

  it('aborts an entry that exceeds the per-entry byte cap, writing nothing', async () => {
    process.env.STORAGE_IMPORT_MAX_BYTES = '8';
    const gz = await makeTarGz([{ name: 'bomb.bin', data: 'far-more-than-eight-bytes' }]);

    await expect(service.importFromStream(Readable.from(gz))).rejects.toThrow(/byte|cap|exceed|large/i);
    expect(fs.existsSync(path.join(localPath, 'bomb.bin'))).toBe(false);
  });

  it('aborts when the archive exceeds the max entry count', async () => {
    process.env.STORAGE_IMPORT_MAX_ENTRIES = '1';
    const gz = await makeTarGz([
      { name: 'a.txt', data: 'a' },
      { name: 'b.txt', data: 'b' },
    ]);

    await expect(service.importFromStream(Readable.from(gz))).rejects.toThrow(/entr/i);
  });

  it('aborts a large multi-chunk entry mid-stream (the payload spans several stream chunks)', async () => {
    process.env.STORAGE_IMPORT_MAX_BYTES = '1024';
    // 256 KiB easily spans multiple 64 KiB stream chunks, so this proves the running accumulator
    // aborts mid-stream rather than only after the whole entry is buffered.
    const gz = await makeTarGz([{ name: 'big.bin', data: 'x'.repeat(256 * 1024) }]);

    await expect(service.importFromStream(Readable.from(gz))).rejects.toThrow(/byte|cap|exceed|large/i);
    expect(fs.existsSync(path.join(localPath, 'big.bin'))).toBe(false);
  });

  it('imports normally within the (generous default) caps', async () => {
    const gz = await makeTarGz([{ name: 'ok.txt', data: 'fine' }]);
    const count = await service.importFromStream(Readable.from(gz));
    expect(count).toBe(1);
  });
});
