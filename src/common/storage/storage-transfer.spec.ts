import { randomBytes } from 'crypto';
import { PassThrough, Readable } from 'stream';

// archiver v8 is ESM-only and ts-jest cannot load it here. This stand-in keeps the parts of its
// TarArchive contract the export relies on: a stream entry with a known size is piped straight into
// the tar pack (without one it is collected first), 'entry' fires once the entry is written, and an
// entry failure is emitted as 'error'. The real archiver runs in test/storage-export-streaming.e2e-spec.ts.
jest.mock('archiver', () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { EventEmitter } = require('events') as typeof import('events');
  const tar = require('tar-stream') as typeof import('tar-stream');
  const { createGzip } = require('zlib') as typeof import('zlib');
  /* eslint-enable @typescript-eslint/no-require-imports */
  class TarArchive extends EventEmitter {
    private readonly pack = tar.pack();
    private readonly gzip = createGzip();
    constructor() {
      super();
      this.pack.pipe(this.gzip);
    }
    pipe(destination: NodeJS.WritableStream): NodeJS.WritableStream {
      return this.gzip.pipe(destination);
    }
    append(source: Readable, data: { name: string; stats?: { size: number } }): void {
      const done = (err?: Error | null): void => void (err ? this.emit('error', err) : this.emit('entry', data));
      if (data.stats) {
        source.pipe(this.pack.entry({ name: data.name, size: data.stats.size }, done));
        return;
      }
      const chunks: Buffer[] = [];
      source.on('data', (chunk: Buffer) => chunks.push(chunk));
      source.on('end', () => this.pack.entry({ name: data.name }, Buffer.concat(chunks), done));
    }
    finalize(): Promise<void> {
      this.pack.finalize();
      return Promise.resolve();
    }
    abort(): void {
      this.pack.destroy();
    }
  }
  return { TarArchive };
});

import { createExportStream, ExportFileSource, importFromStream } from './storage-transfer';

const FILE_BYTES = 256 * 1024;
const files = Array.from({ length: 12 }, (_, i) => `media/file-${String.fromCharCode(97 + i)}.bin`);

const makeLogger = () => ({ warn: jest.fn(), error: jest.fn(), log: jest.fn(), debug: jest.fn() });

// Random bytes do not compress, so gzip cannot hide a file inside a few kilobytes of stream buffer.
const contents = new Map<string, Buffer>();
const contentFor = (name: string): Buffer => {
  if (!contents.has(name)) contents.set(name, randomBytes(FILE_BYTES));
  return contents.get(name)!;
};

/** An openFile that counts the file streams open at once and the files ever opened. */
function trackingOpener(failing: Record<string, 'open' | 'read'> = {}, withSize = true) {
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
    return Promise.resolve({ stream, size: withSize ? data.length : undefined });
  };
  return { stats, openFile };
}

const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function importAll(output: PassThrough, logger: object): Promise<Map<string, Buffer>> {
  const imported = new Map<string, Buffer>();
  await importFromStream(
    output,
    (name, data) => {
      imported.set(name, data);
      return Promise.resolve();
    },
    logger as never,
  );
  return imported;
}

describe('createExportStream streams one file at a time', () => {
  it('returns before reading the store and opens no further files while nothing consumes the output', async () => {
    const { stats, openFile } = trackingOpener();
    const output = await createExportStream(() => Promise.resolve(files), openFile, makeLogger() as never);

    await settle(100);
    // Stream buffers absorb a file or so; every file past that waits for a reader.
    expect(stats.opened).toBeLessThanOrEqual(2);
    output.destroy();
  });

  it('holds one file stream open at a time, skips an unopenable file, and round-trips the rest', async () => {
    const { stats, openFile } = trackingOpener({ 'media/file-c.bin': 'open' });
    const logger = makeLogger();
    const output = await createExportStream(() => Promise.resolve(files), openFile, logger as never);

    const imported = await importAll(output, logger);

    expect(stats.maxOpen).toBe(1);
    expect(stats.open).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith('Failed to export file: media/file-c.bin', expect.anything());
    expect([...imported.keys()].sort()).toEqual(files.filter(f => f !== 'media/file-c.bin'));
    for (const [name, data] of imported) expect(data.equals(contentFor(name))).toBe(true);
  });

  it('still exports a file whose size the backend did not report', async () => {
    const { openFile } = trackingOpener({}, false);
    const logger = makeLogger();
    const output = await createExportStream(() => Promise.resolve(files.slice(0, 2)), openFile, logger as never);

    const imported = await importAll(output, logger);

    expect(imported.get(files[1])?.equals(contentFor(files[1]))).toBe(true);
  });

  it('fails the output with a read error part-way through a file and stops opening files', async () => {
    const { stats, openFile } = trackingOpener({ 'media/file-b.bin': 'read' });
    const output = await createExportStream(() => Promise.resolve(files), openFile, makeLogger() as never);

    const error = await new Promise<Error>(resolve => {
      output.on('error', resolve);
      output.resume();
    });
    await settle(20);

    expect(error.message).toBe('read failed: media/file-b.bin');
    expect(stats.opened).toBe(2);
    expect(stats.open).toBe(0);
  });

  it('stops and releases the open file when the consumer destroys the output', async () => {
    const { stats, openFile } = trackingOpener();
    const output = await createExportStream(() => Promise.resolve(files), openFile, makeLogger() as never);
    await settle(50);
    const openedBefore = stats.opened;

    output.destroy();
    await settle(50);

    expect(stats.open).toBe(0);
    expect(stats.opened).toBe(openedBefore);
  });
});
