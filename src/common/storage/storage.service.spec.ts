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
