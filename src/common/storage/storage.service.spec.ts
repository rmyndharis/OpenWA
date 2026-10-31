import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar-stream';
import { createGzip } from 'zlib';
import { PassThrough, Readable } from 'stream';
import { ConfigService } from '@nestjs/config';

import { StorageService } from './storage.service';
import * as transfer from './storage-transfer';

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

  it('deletes a file within the storage root', async () => {
    await service.putFile('sub/gone.txt', Buffer.from('bye'));
    await service.deleteFile('sub/gone.txt');
    expect(fs.existsSync(path.join(localPath, 'sub/gone.txt'))).toBe(false);
  });

  it('deleting an already-missing file resolves without throwing', async () => {
    await expect(service.deleteFile('never-existed.txt')).resolves.toBeUndefined();
  });

  it('rejects deleting a file outside the storage root', async () => {
    fs.writeFileSync(path.join(baseDir, 'secret.txt'), 'topsecret');
    await expect(service.deleteFile('../secret.txt')).rejects.toThrow();
    expect(fs.existsSync(path.join(baseDir, 'secret.txt'))).toBe(true);
  });

  it('imports safe entries but refuses tar entries that escape the storage root', async () => {
    const gz = await makeTarGz([
      { name: 'safe.txt', data: 'good' },
      { name: '../evil.txt', data: 'bad' },
    ]);

    const result = await service.importFromStream(Readable.from(gz));

    expect(fs.readFileSync(path.join(localPath, 'safe.txt'), 'utf8')).toBe('good');
    expect(fs.existsSync(path.join(baseDir, 'evil.txt'))).toBe(false);
    expect(result).toEqual({ imported: 1, failed: 1 });
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

  it('deleteFile rejects an unsafe key before reaching the S3 backend', async () => {
    const { service, baseDir } = makeLocalService();
    const sendMock = s3Stub(service);

    await expect(service.deleteFile('../evil')).rejects.toThrow(/unsafe storage key/);
    expect(sendMock).not.toHaveBeenCalled();

    fs.rmSync(baseDir, { recursive: true, force: true });
  });
});

describe('StorageService.openFile (the export read path)', () => {
  const readAll = async (stream: Readable): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  };

  it('streams a local file with its size, and rejects a missing file before any stream exists', async () => {
    const { service, baseDir, localPath } = makeLocalService();
    fs.mkdirSync(path.join(localPath, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(localPath, 'sub/a.bin'), 'local-bytes');

    const { stream, size } = await service.openFile('sub/a.bin');
    expect(size).toBe(11);
    expect((await readAll(stream)).toString()).toBe('local-bytes');
    expect((await service.getFile('sub/a.bin')).toString()).toBe('local-bytes');
    await expect(service.openFile('sub/missing.bin')).rejects.toThrow(/ENOENT/);
    await expect(service.openFile('../../etc/passwd')).rejects.toThrow(/unsafe storage key/);

    fs.rmSync(baseDir, { recursive: true, force: true });
  });
});

describe('StorageService getFileCount (S3 size)', () => {
  it('sums the real Size of each S3 object instead of estimating', async () => {
    const { service, baseDir } = makeLocalService();
    const sendMock = jest.fn().mockResolvedValue({
      Contents: [
        { Key: 'media/a.jpg', Size: 1000 },
        { Key: 'media/b.jpg', Size: 2500 },
      ],
    });
    const internal = service as unknown as {
      storageType: string;
      s3Client: unknown;
      s3Bucket: string;
      s3Available: boolean;
    };
    internal.storageType = 's3';
    internal.s3Client = { send: sendMock };
    internal.s3Bucket = 'test-bucket';
    internal.s3Available = true;

    const result = await service.getFileCount();

    expect(result.count).toBe(2);
    expect(result.sizeBytes).toBe(3500); // real object sizes, not files.length * 100000

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

    await expect(service.importFromStream(Readable.from(gz))).rejects.toThrow(
      /8-byte per-entry cap \(STORAGE_IMPORT_MAX_BYTES\)/,
    );
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
    const result = await service.importFromStream(Readable.from(gz));
    expect(result).toEqual({ imported: 1, failed: 0 });
  });
});

describe('StorageService import stream error handling (request fails, process survives)', () => {
  let baseDir: string;
  let service: StorageService;

  beforeEach(() => {
    ({ service, baseDir } = makeLocalService());
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("rejects on a non-gzip input instead of crashing on gunzip's unhandled error event", async () => {
    // zlib emits 'error' on the gunzip stream for a corrupt/non-gzip payload; pipe() does not forward
    // it, so without a listener on gunzip this would take down the whole process.
    const notGzip = Readable.from([Buffer.from('this is definitely not a gzip stream')]);
    await expect(service.importFromStream(notGzip)).rejects.toThrow();
  });

  it('rejects when the input stream itself errors mid-read', async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error('read boom'));
      },
    });
    await expect(service.importFromStream(failing)).rejects.toThrow(/read boom/);
  });
});

describe('StorageService local traversal (async + bounded)', () => {
  let baseDir: string;
  let service: StorageService;

  beforeEach(() => {
    ({ service, baseDir } = makeLocalService());
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('enumerates files across nested subdirectories (async traversal)', async () => {
    await service.putFile('a.txt', Buffer.from('a'));
    await service.putFile('sub/b.txt', Buffer.from('b'));
    await service.putFile('sub/deep/c.txt', Buffer.from('c'));

    const files: string[] = [];
    for await (const file of service.iterateFiles()) files.push(file);
    expect(files.sort()).toEqual(['a.txt', 'sub/b.txt', 'sub/deep/c.txt']);
  });

  it('iterateFiles enumerates every file of a wide directory', async () => {
    for (let i = 0; i < 20; i++) {
      await service.putFile(`file${i}.txt`, Buffer.from('x'));
    }

    const seen: string[] = [];
    for await (const file of service.iterateFiles()) seen.push(file);
    expect(seen.length).toBe(20);
  });
});

/**
 * The export and the files/count pre-check both walk the whole store through iterateFiles(), so the
 * documented local→S3 migration (export, repoint STORAGE_TYPE, import) cannot silently leave media
 * behind on the old backend.
 */
describe('StorageService.createExportStream enumerates the whole store', () => {
  const baseDirs: string[] = [];
  const makeService = (): ReturnType<typeof makeLocalService> => {
    const made = makeLocalService();
    baseDirs.push(made.baseDir);
    return made;
  };

  afterEach(() => {
    for (const dir of baseDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('walks the whole store through iterateFiles', async () => {
    const { service } = makeService();
    const iterateFiles = jest.spyOn(service, 'iterateFiles').mockImplementation(async function* () {
      yield await Promise.resolve('media/a.bin');
    });
    // No read stub: the file does not exist, so the export skips it with a warning. Which enumeration
    // was used is settled before that, and that is the whole claim here.
    const output = await service.createExportStream();
    output.destroy();

    expect(iterateFiles).toHaveBeenCalled();
  });

  // The export fails on any open error other than a missing object, so a listed key openFile always
  // refuses (an S3 object at the bare key root, or one with a `..` segment) must not reach it.
  it('leaves out a listed key that openFile would refuse', async () => {
    const { service } = makeService();
    jest.spyOn(service, 'iterateFiles').mockImplementation(async function* () {
      yield await Promise.resolve('media/a.bin');
      yield '';
      yield 'media/../x.bin';
    });
    const create = jest.spyOn(transfer, 'createExportStream').mockResolvedValue(new PassThrough());

    await service.createExportStream();

    expect(await create.mock.calls[0][0]()).toEqual(['media/a.bin']);
    create.mockRestore();
  });

  // An S3 console "Create folder" leaves a zero-byte object whose key ends in "/". It holds no file, and as an
  // archive entry of file type it would fail the import that restores the archive onto a local store.
  it('leaves out an S3 folder placeholder, which holds no file', async () => {
    const { service } = makeService();
    jest.spyOn(service, 'iterateFiles').mockImplementation(async function* () {
      yield await Promise.resolve('sess1/');
      yield 'sess1/a.bin';
      yield 'sess1/deep/';
    });
    const create = jest.spyOn(transfer, 'createExportStream').mockResolvedValue(new PassThrough());

    await service.createExportStream();

    expect(await create.mock.calls[0][0]()).toEqual(['sess1/a.bin']);
    create.mockRestore();
  });

  /**
   * The count is the pre-check an operator runs before that migration, so it has to see every file
   * the export will carry.
   */
  it('counts through iterateFiles too, so the pre-check sees what the export carries', async () => {
    const { service } = makeService();
    const iterateFiles = jest.spyOn(service, 'iterateFiles').mockImplementation(async function* () {
      yield await Promise.resolve('media/a.bin');
      yield await Promise.resolve('media/b.bin');
    });

    const { count } = await service.getFileCount();

    expect(iterateFiles).toHaveBeenCalled();
    expect(count).toBe(2); // the iterator's items are what was counted, not an unrelated walk
  });

  it('counts only what the export carries: a folder placeholder and an unsafe key are left out', async () => {
    const { service } = makeService();
    jest.spyOn(service, 'iterateFiles').mockImplementation(async function* () {
      yield await Promise.resolve('sess1/');
      yield 'sess1/a.bin';
      yield 'media/../x.bin';
    });
    jest.spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});

    const { count } = await service.getFileCount();

    expect(count).toBe(1);
  });

  /**
   * The size loop under the whole-store walk must not stat every file synchronously: on a large store
   * that holds the event loop for the whole walk, and health checks, webhooks and every in-flight
   * request wait behind a count.
   *
   * Measured, not asserted structurally. A single "did something run during the call?" flag is NOT
   * discriminating here — the enumeration awaits before the stat loop begins, so that flag flips
   * either way. Counting how many times the loop yields WHILE the call is pending does discriminate:
   * measured at 1 tick for 2000 files with the synchronous loop, and it rises with the file count
   * once each stat yields.
   */
  it('does not hold the event loop for the whole walk', async () => {
    const { service, localPath } = makeService();
    fs.mkdirSync(localPath, { recursive: true });
    const FILES = 2000;
    for (let i = 0; i < FILES; i++) {
      fs.writeFileSync(path.join(localPath, `f${i}.bin`), 'x');
    }

    let ticks = 0;
    let finished = false;
    const tick = (): void => {
      if (finished) return;
      ticks += 1;
      setImmediate(tick);
    };
    setImmediate(tick);

    const { count } = await service.getFileCount();
    finished = true;

    expect(count).toBe(FILES); // the walk really did the work being measured
    expect(ticks).toBeGreaterThan(100);
  }, 30000);
});

describe('StorageService local store holding a symbolic link', () => {
  let baseDir: string;
  let localPath: string;
  let service: StorageService;

  beforeEach(() => {
    ({ service, baseDir, localPath } = makeLocalService());
    fs.mkdirSync(path.join(baseDir, 'bigdisk'), { recursive: true });
    fs.writeFileSync(path.join(baseDir, 'bigdisk', 'archived.bin'), 'archived');
    fs.mkdirSync(localPath, { recursive: true });
    fs.writeFileSync(path.join(localPath, 'real.bin'), 'real');
    fs.symlinkSync(path.join(baseDir, 'bigdisk'), path.join(localPath, 'chat-media'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  // The file count is the pre-check before the export that moves the store to another backend. Both must
  // fail on a link rather than answer for a store that is missing the media behind it.
  it('refuses a file count and an export, which would otherwise leave that media behind', async () => {
    await expect(service.getFileCount()).rejects.toThrow(/symbolic link.*chat-media/);
    await expect(service.createExportStream()).rejects.toThrow(/symbolic link.*chat-media/);
  });

  it('still serves the linked file and lets a sweep of the linked prefix list it', async () => {
    expect((await service.getFile('chat-media/archived.bin')).toString()).toBe('archived');
    const listed: string[] = [];
    for await (const file of service.iterateFiles('chat-media/', { skipUnreadable: true })) listed.push(file);
    expect(listed).toEqual(['chat-media/archived.bin']);
  });
});

describe('StorageService local store on a volume whose lost+found it cannot read', () => {
  let baseDir: string;
  let service: StorageService;

  beforeEach(() => {
    let localPath: string;
    ({ service, baseDir, localPath } = makeLocalService());
    fs.mkdirSync(path.join(localPath, 'lost+found'), { recursive: true });
    fs.writeFileSync(path.join(localPath, 'real.bin'), 'real');
    // A mode-000 directory is still readable by root, so the failure is injected for that one path.
    const readdir = fs.promises.readdir.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    jest
      .spyOn(fs.promises, 'readdir')
      .mockImplementation(((target: fs.PathLike, ...rest: unknown[]) =>
        String(target).endsWith('lost+found')
          ? Promise.reject(Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' }))
          : readdir(target, ...rest)) as never);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('counts the media around it, as it did before directories were required to be readable', async () => {
    expect(await service.getFileCount()).toEqual({ count: 1, sizeBytes: 4 });
    const listed: string[] = [];
    for await (const file of service.iterateFiles()) listed.push(file);
    expect(listed).toEqual(['real.bin']);
  });
});
