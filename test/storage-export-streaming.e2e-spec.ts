import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { ConfigService } from '@nestjs/config';
import { StorageWalkRefusedError } from '../src/common/storage/storage-local-files';
import { createExportStream, ExportFileSource, importFromStream } from '../src/common/storage/storage-transfer';
import { StorageService } from '../src/common/storage/storage.service';

describe('Local storage export completeness', () => {
  let localPath: string;
  let storage: StorageService;

  beforeEach(() => {
    localPath = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-export-'));
    storage = new StorageService({
      get: (key: string) => ({ 'storage.type': 'local', 'storage.localPath': localPath })[key],
    } as unknown as ConfigService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    storage.onModuleDestroy();
    fs.rmSync(localPath, { recursive: true, force: true });
  });

  // A permission failure is one the operator can fix, so it is refused with a typed error that names the cause and
  // keeps the host's own error for the log.
  it.each(['EACCES', 'EPERM'])('refuses an export and count when a directory is unreadable (%s)', async code => {
    await storage.putFile('nested/media.bin', Buffer.from('preserve this file'));
    const error = Object.assign(new Error(`Cannot enumerate storage: ${code}`), { code });
    jest.spyOn(fs.promises, 'readdir').mockRejectedValue(error);

    const refusals = [
      await storage.createExportStream().catch((e: unknown) => e),
      await storage.getFileCount().catch((e: unknown) => e),
    ];
    for (const refusal of refusals) {
      expect(refusal).toBeInstanceOf(StorageWalkRefusedError);
      expect(refusal).toMatchObject({ message: `Storage directory cannot be read: . (${code})`, cause: error });
    }
    expect((await storage.getFile('nested/media.bin')).toString()).toBe('preserve this file');
  });

  it('refuses an export and count when enumeration fails with an error that is not a refusal, as it came', async () => {
    await storage.putFile('nested/media.bin', Buffer.from('preserve this file'));
    const error = Object.assign(new Error('Cannot enumerate storage: EIO'), { code: 'EIO' });
    jest.spyOn(fs.promises, 'readdir').mockRejectedValue(error);

    await expect(storage.createExportStream()).rejects.toBe(error);
    await expect(storage.getFileCount()).rejects.toBe(error);
  });

  it('refuses an export and count when an accepted key exceeds the traversal depth', async () => {
    const key = [...Array<string>(20).fill('nested'), 'media.bin'].join('/');
    await storage.putFile(key, Buffer.from('deep media'));

    expect((await storage.getFile(key)).toString()).toBe('deep media');
    await expect(storage.createExportStream()).rejects.toBeInstanceOf(StorageWalkRefusedError);
    await expect(storage.createExportStream()).rejects.toThrow(/maximum traversal depth/);
    await expect(storage.getFileCount()).rejects.toThrow(/maximum traversal depth/);
  });

  it('still treats a missing local fallback directory as empty', async () => {
    fs.rmSync(localPath, { recursive: true });
    const logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn(), debug: jest.fn() };

    expect(await storage.getFileCount()).toEqual({ count: 0, sizeBytes: 0 });
    const output = await storage.createExportStream();
    await expect(importFromStream(output, jest.fn(), logger as never)).resolves.toEqual({ imported: 0, failed: 0 });
  });

  it('exports every readable file with its original bytes', async () => {
    const source = new Map([
      ['root.bin', Buffer.from('root media')],
      ['nested/media.bin', Buffer.from('nested media')],
    ]);
    for (const [key, bytes] of source) await storage.putFile(key, bytes);
    const imported = new Map<string, Buffer>();
    const logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn(), debug: jest.fn() };

    const output = await storage.createExportStream();
    await expect(
      importFromStream(
        output,
        (key, bytes) => {
          imported.set(key, bytes);
          return Promise.resolve();
        },
        logger as never,
      ),
    ).resolves.toEqual({ imported: source.size, failed: 0 });
    expect(imported).toEqual(source);
  });
});

/**
 * An export of a large media store must not read every file into memory before anything consumes the
 * archive: files are opened one at a time, each only after the previous entry was written through.
 */
describe('Storage export streams one file at a time (e2e)', () => {
  const FILE_BYTES = 1024 * 1024;

  const makeLogger = () => ({ warn: jest.fn(), error: jest.fn(), log: jest.fn(), debug: jest.fn() });

  // Random bytes do not compress, so gzip cannot hide a file inside a few kilobytes of stream buffer.
  const contents = new Map<string, Buffer>();
  const contentFor = (name: string): Buffer => {
    if (!contents.has(name)) contents.set(name, randomBytes(FILE_BYTES));
    return contents.get(name)!;
  };

  /** An openFile that tracks how many file streams are open at once and how many were ever opened. */
  function trackingOpener(failing: Record<string, 'gone' | 'broken' | 'read'> = {}) {
    const stats = { opened: 0, open: 0, maxOpen: 0 };
    const openFile = (name: string): Promise<ExportFileSource> => {
      // 'gone' is a file deleted since the listing (what local storage and S3 report as missing);
      // 'broken' is any other open failure, such as a throttle or a reset connection.
      if (failing[name] === 'gone')
        return Promise.reject(Object.assign(new Error(`ENOENT: ${name}`), { code: 'ENOENT' }));
      if (failing[name] === 'broken') return Promise.reject(new Error(`EACCES: ${name}`));
      const data = contentFor(name);
      stats.opened++;
      stats.open++;
      stats.maxOpen = Math.max(stats.maxOpen, stats.open);
      let offset = 0;
      const stream = new Readable({
        highWaterMark: 16 * 1024,
        read() {
          if (failing[name] === 'read' && offset > 0) {
            this.destroy(new Error(`read failed: ${name}`));
            return;
          }
          const chunk = data.subarray(offset, offset + 16 * 1024);
          offset += chunk.length;
          this.push(chunk.length ? chunk : null);
        },
      });
      stream.once('close', () => stats.open--);
      return Promise.resolve({ stream, size: data.length });
    };
    return { stats, openFile };
  }

  const files = Array.from({ length: 12 }, (_, i) => `media/file-${String.fromCharCode(97 + i)}.bin`);

  it('returns before reading the store and opens no further files while nothing consumes the output', async () => {
    const { stats, openFile } = trackingOpener();
    const output = await createExportStream(() => Promise.resolve(files), openFile, makeLogger() as never);

    // Let the background loop run as far as it can without a reader. The pipeline's own buffers absorb
    // a file or two; everything past that has to wait for the reader.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(stats.opened).toBeLessThanOrEqual(3);
    output.destroy();
  });

  it('never holds more than one file stream open, and the archive round-trips through the importer', async () => {
    const { stats, openFile } = trackingOpener({ 'media/file-c.bin': 'gone' });
    const logger = makeLogger();
    const output = await createExportStream(() => Promise.resolve(files), openFile, logger as never);

    const imported = new Map<string, Buffer>();
    const { imported: count } = await importFromStream(
      output,
      (name, data) => {
        imported.set(name, data);
        return Promise.resolve();
      },
      logger as never,
    );

    expect(stats.maxOpen).toBe(1);
    expect(stats.open).toBe(0);
    // A file deleted since the listing is skipped with a warning; every other file arrives intact.
    expect(logger.warn).toHaveBeenCalledWith('Failed to export file: media/file-c.bin', expect.anything());
    expect(count).toBe(files.length - 1);
    for (const name of files.filter(f => f !== 'media/file-c.bin')) {
      expect(imported.get(name)?.equals(contentFor(name))).toBe(true);
    }
  });

  it('fails the output when a file cannot be opened for a reason other than being gone', async () => {
    const { stats, openFile } = trackingOpener({ 'media/file-b.bin': 'broken' });
    const output = await createExportStream(() => Promise.resolve(files), openFile, makeLogger() as never);

    const error = await new Promise<Error>(resolve => {
      output.on('error', resolve);
      output.resume();
    });

    expect(error.message).toBe('EACCES: media/file-b.bin');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(stats.opened).toBe(1);
    expect(stats.open).toBe(0);
  });

  it('fails the output with the read error when a file fails part-way, and stops opening files', async () => {
    const { stats, openFile } = trackingOpener({ 'media/file-b.bin': 'read' });
    const output = await createExportStream(() => Promise.resolve(files), openFile, makeLogger() as never);

    const error = await new Promise<Error>(resolve => {
      output.on('error', resolve);
      output.resume();
    });

    expect(error.message).toBe('read failed: media/file-b.bin');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(stats.opened).toBe(2);
    expect(stats.open).toBe(0);
  });

  // The tar entry declares the size seen at open time. A file that is rewritten before it is read
  // yields a different length, and handing that to the tar sink raises an error nothing can catch.
  it.each([
    ['longer', 2 * FILE_BYTES],
    ['shorter', FILE_BYTES / 2],
  ])('fails the output, without an uncaught exception, when a file reads %s than its size', async (_, length) => {
    const uncaught: Error[] = [];
    const onUncaught = (err: Error): void => void uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    try {
      const openFile = (name: string): Promise<ExportFileSource> =>
        Promise.resolve({
          stream: Readable.from([randomBytes(length)]),
          size: name === 'media/file-b.bin' ? FILE_BYTES : length,
        });
      const output = await createExportStream(() => Promise.resolve(files), openFile, makeLogger() as never);

      const error = await new Promise<Error>(resolve => {
        output.on('error', resolve);
        output.resume();
      });
      expect(error.message).toMatch(/media\/file-b\.bin/);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(uncaught).toEqual([]);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }
  });
});
