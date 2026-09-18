// test/__mocks__/archiver.ts replaces archiver in every suite under test/; this one needs the real one.
jest.unmock('archiver');

import { randomBytes } from 'crypto';
import { Readable } from 'stream';
import { createExportStream, ExportFileSource, importFromStream } from '../src/common/storage/storage-transfer';

/**
 * The storage export runs against the real archiver here (the unit config stubs it). An export of a
 * large media store must not read every file into memory before anything consumes the archive:
 * files are opened one at a time, each only after the previous entry was written through.
 */
describe('Storage export streams one file at a time (e2e, real archiver)', () => {
  const FILE_BYTES = 1024 * 1024;

  const makeLogger = () => ({ warn: jest.fn(), error: jest.fn(), log: jest.fn(), debug: jest.fn() });

  // Random bytes do not compress, so gzip cannot hide a file inside a few kilobytes of stream buffer.
  const contents = new Map<string, Buffer>();
  const contentFor = (name: string): Buffer => {
    if (!contents.has(name)) contents.set(name, randomBytes(FILE_BYTES));
    return contents.get(name)!;
  };

  /** An openFile that tracks how many file streams are open at once and how many were ever opened. */
  function trackingOpener(failing: Record<string, 'open' | 'read'> = {}) {
    const stats = { opened: 0, open: 0, maxOpen: 0 };
    const openFile = (name: string): Promise<ExportFileSource> => {
      if (failing[name] === 'open') return Promise.reject(new Error(`ENOENT: ${name}`));
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

    // Let the background loop run as far as it can without a reader. The pipeline's own buffers (about
    // a megabyte in archiver) absorb a file or two; everything past that has to wait for the reader.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(stats.opened).toBeLessThanOrEqual(3);
    output.destroy();
  });

  it('never holds more than one file stream open, and the archive round-trips through the importer', async () => {
    const { stats, openFile } = trackingOpener({ 'media/file-c.bin': 'open' });
    const logger = makeLogger();
    const output = await createExportStream(() => Promise.resolve(files), openFile, logger as never);

    const imported = new Map<string, Buffer>();
    const count = await importFromStream(
      output,
      (name, data) => {
        imported.set(name, data);
        return Promise.resolve();
      },
      logger as never,
    );

    expect(stats.maxOpen).toBe(1);
    expect(stats.open).toBe(0);
    // The unopenable file is skipped with a warning, as before; every other file arrives intact.
    expect(logger.warn).toHaveBeenCalledWith('Failed to export file: media/file-c.bin', expect.anything());
    expect(count).toBe(files.length - 1);
    for (const name of files.filter(f => f !== 'media/file-c.bin')) {
      expect(imported.get(name)?.equals(contentFor(name))).toBe(true);
    }
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
