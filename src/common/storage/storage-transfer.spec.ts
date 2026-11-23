import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { PassThrough, Readable } from 'stream';
import * as tar from 'tar-stream';
import { createGzip, gzipSync } from 'zlib';

import {
  createExportStream,
  DEFAULT_IMPORT_MAX_BYTES,
  DEFAULT_IMPORT_MAX_ENTRIES,
  DEFAULT_IMPORT_MAX_TOTAL_BYTES,
  ExportFileSource,
  importFromStream,
} from './storage-transfer';
import { waitUntil } from '../../../test/helpers/wait-until';

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
function trackingOpener(failing: Record<string, 'gone' | 'bucket' | 'open' | 'read'> = {}, withSize = true) {
  const stats = { opened: 0, open: 0, maxOpen: 0 };
  const openFile = (name: string): Promise<ExportFileSource> => {
    if (failing[name] === 'gone')
      return Promise.reject(Object.assign(new Error(`ENOENT: ${name}`), { code: 'ENOENT' }));
    if (failing[name] === 'bucket')
      return Promise.reject(
        Object.assign(new Error('The specified bucket does not exist'), {
          name: 'NoSuchBucket',
          $metadata: { httpStatusCode: 404 },
        }),
      );
    if (failing[name] === 'open') return Promise.reject(new Error(`SlowDown: ${name}`));
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

  it('holds one file stream open at a time, skips a file deleted since the listing, and round-trips the rest', async () => {
    const { stats, openFile } = trackingOpener({ 'media/file-c.bin': 'gone' });
    const logger = makeLogger();
    const output = await createExportStream(() => Promise.resolve(files), openFile, logger as never);

    const imported = await importAll(output, logger);

    expect(stats.maxOpen).toBe(1);
    expect(stats.open).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith('Failed to export file: media/file-c.bin', expect.anything());
    expect([...imported.keys()].sort()).toEqual(files.filter(f => f !== 'media/file-c.bin'));
    for (const [name, data] of imported) expect(data.equals(contentFor(name))).toBe(true);
  });

  it('fails the output when a listed file cannot be opened for any other reason', async () => {
    const { stats, openFile } = trackingOpener({ 'media/file-c.bin': 'open' });
    const output = await createExportStream(() => Promise.resolve(files), openFile, makeLogger() as never);

    const error = await new Promise<Error>(resolve => {
      output.on('error', resolve);
      output.resume();
    });
    await settle(20);

    expect(error.message).toBe('SlowDown: media/file-c.bin');
    expect(stats.opened).toBe(2);
  });

  it('fails the output when the bucket itself is gone, not only one object', async () => {
    const { stats, openFile } = trackingOpener({ 'media/file-c.bin': 'bucket' });
    const logger = makeLogger();
    const output = await createExportStream(() => Promise.resolve(files), openFile, logger as never);

    const error = await new Promise<Error>(resolve => {
      output.on('error', resolve);
      output.resume();
    });
    await settle(20);

    expect(error.name).toBe('NoSuchBucket');
    expect(stats.opened).toBe(2);
    expect(logger.warn).not.toHaveBeenCalledWith('Failed to export file: media/file-c.bin', expect.anything());
  });

  it('still exports a file whose size the backend did not report', async () => {
    const { openFile } = trackingOpener({}, false);
    const logger = makeLogger();
    const output = await createExportStream(() => Promise.resolve(files.slice(0, 2)), openFile, logger as never);

    const imported = await importAll(output, logger);

    expect(imported.get(files[1])?.equals(contentFor(files[1]))).toBe(true);
  });

  // A key is an opaque name. A backslash, a doubled slash or a leading `word:` belongs to it, and an archive that
  // rewrites any of them restores the file under a different key.
  it.each([true, false])(
    'writes every key under exactly the name it is stored by (size reported: %s)',
    async withSize => {
      const names = [
        'media/back\\slash.bin',
        'media/dir//double.bin',
        '628123:4@s.whatsapp.net/c.jpg',
        'status:x/y.bin',
      ];
      const { openFile } = trackingOpener({}, withSize);
      const logger = makeLogger();
      const output = await createExportStream(() => Promise.resolve(names), openFile, logger as never);

      const imported = await importAll(output, logger);

      expect([...imported.keys()]).toEqual(names);
      expect(imported.get(names[0])?.equals(contentFor(names[0]))).toBe(true);
    },
  );

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

describe('createExportStream releases the archive streams', () => {
  // The tar and gzip streams hold whatever the consumer had not read yet, and zlib a native handle. Destroying
  // the output has to release them at once, not leave them to the garbage collector. Nothing else fails when it
  // does not: the export stops opening files either way, so only the two streams themselves can show it.
  it('destroys the tar and gzip streams when the consumer destroys the output mid-entry', async () => {
    const realZlib = jest.requireActual<typeof import('zlib')>('zlib');
    const realCreateGzip = realZlib.createGzip;
    const readOnlyExport = { configurable: true, enumerable: true, writable: false };
    const gzips: Array<{ destroyed: boolean }> = [];
    // createGzip is a read-only export. jest.spyOn cannot wrap it, and the failed attempt makes the suite fail
    // when the mocks are restored, so the export is replaced by hand for the length of the test.
    Object.defineProperty(realZlib, 'createGzip', {
      ...readOnlyExport,
      value: (...args: Parameters<typeof realCreateGzip>) => {
        const gzip = realCreateGzip(...args);
        gzips.push(gzip);
        return gzip;
      },
    });
    const pack = jest.spyOn(jest.requireActual<typeof tar>('tar-stream'), 'pack');
    try {
      let reading = false;
      // An entry that never ends, so the export is parked inside it when the consumer goes away.
      const stuck = new Readable({
        read() {
          reading = true;
        },
      });
      const output = await createExportStream(
        () => Promise.resolve(['media/stuck.bin']),
        () => Promise.resolve({ stream: stuck, size: FILE_BYTES }),
        makeLogger() as never,
      );
      await waitUntil(() => reading);
      expect(reading).toBe(true);
      expect(pack).toHaveBeenCalledTimes(1);
      expect(gzips).toHaveLength(1);
      const tarPack = pack.mock.results[0].value as { destroyed: boolean };
      const gzip = gzips[0];
      expect(tarPack.destroyed).toBe(false);
      expect(gzip.destroyed).toBe(false);

      output.destroy();
      // Destroying a stream finishes on a later tick; a missing teardown shows here as a stream still open.
      await waitUntil(() => tarPack.destroyed && gzip.destroyed);

      expect(tarPack.destroyed).toBe(true);
      expect(gzip.destroyed).toBe(true);
    } finally {
      pack.mockRestore();
      Object.defineProperty(realZlib, 'createGzip', { ...readOnlyExport, value: realCreateGzip });
    }
  }, 60_000);
});

describe('importFromStream reports refused writes', () => {
  it('counts every entry putFile rejects as failed, and none as imported', async () => {
    const { openFile } = trackingOpener();
    const names = files.slice(0, 3);
    const output = await createExportStream(() => Promise.resolve(names), openFile, makeLogger() as never);

    const result = await importFromStream(
      output,
      () => Promise.reject(new Error('AccessDenied')),
      makeLogger() as never,
    );

    expect(result).toEqual({ imported: 0, failed: names.length });
  });
});

describe('importFromStream writes regular files only', () => {
  it('skips directory and link entries and drops a leading ./ from the key', async () => {
    const pack = tar.pack();
    pack.entry({ name: './', type: 'directory' });
    pack.entry({ name: './status/', type: 'directory' });
    pack.entry({ name: './status/link.jpg', type: 'symlink', linkname: 'a.jpg' });
    pack.entry({ name: './status/hard.jpg', type: 'link', linkname: './status/a.jpg' });
    pack.entry({ name: './status/a.jpg' }, Buffer.from('jpeg!!'));
    pack.finalize();
    const written = new Map<string, Buffer>();

    const result = await importFromStream(
      pack.pipe(createGzip()),
      (name, data) => {
        written.set(name, data);
        return Promise.resolve();
      },
      makeLogger() as never,
    );

    expect([...written.keys()]).toEqual(['status/a.jpg']);
    expect(written.get('status/a.jpg')?.toString()).toBe('jpeg!!');
    expect(result).toEqual({ imported: 1, failed: 0 });
  });
});

describe('importFromStream reports partial counts on an abort', () => {
  it('carries the entries already written on an entry-cap rejection', async () => {
    const prev = process.env.STORAGE_IMPORT_MAX_ENTRIES;
    process.env.STORAGE_IMPORT_MAX_ENTRIES = '2';
    const pack = tar.pack();
    for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) pack.entry({ name }, Buffer.from(name));
    pack.finalize();
    const written: string[] = [];
    try {
      const rejection = await importFromStream(
        pack.pipe(createGzip()),
        name => {
          written.push(name);
          return Promise.resolve();
        },
        makeLogger() as never,
      ).catch((err: unknown) => err);

      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toMatch(/2-entry limit \(STORAGE_IMPORT_MAX_ENTRIES\)/);
      expect(rejection).toMatchObject({ imported: 2, failed: 0 });
      expect(written).toEqual(['a.jpg', 'b.jpg']);
    } finally {
      if (prev === undefined) delete process.env.STORAGE_IMPORT_MAX_ENTRIES;
      else process.env.STORAGE_IMPORT_MAX_ENTRIES = prev;
    }
  });
});

describe('importFromStream caps the total bytes one import extracts', () => {
  const withTotalCap = async <T>(cap: string, run: () => Promise<T>): Promise<T> => {
    const prev = process.env.STORAGE_IMPORT_MAX_TOTAL_BYTES;
    process.env.STORAGE_IMPORT_MAX_TOTAL_BYTES = cap;
    try {
      return await run();
    } finally {
      if (prev === undefined) delete process.env.STORAGE_IMPORT_MAX_TOTAL_BYTES;
      else process.env.STORAGE_IMPORT_MAX_TOTAL_BYTES = prev;
    }
  };
  const importEntries = (written: Map<string, Buffer>, sizes: number[]) => {
    const pack = tar.pack();
    sizes.forEach((size, i) => pack.entry({ name: `e${i}.bin` }, Buffer.alloc(size, 0x61)));
    pack.finalize();
    return importFromStream(
      pack.pipe(createGzip()),
      (name, data) => {
        written.set(name, data);
        return Promise.resolve();
      },
      makeLogger() as never,
    );
  };
  const bytesIn = (written: Map<string, Buffer>): number => [...written.values()].reduce((n, b) => n + b.length, 0);

  it('aborts when entries that each fit the per-entry cap add up past the total cap', async () => {
    const written = new Map<string, Buffer>();
    const rejection = await withTotalCap('10000', () => importEntries(written, [4000, 4000, 4000, 4000])).catch(
      (err: unknown) => err,
    );

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toMatch(/10000-byte total cap \(STORAGE_IMPORT_MAX_TOTAL_BYTES\)/);
    expect(rejection).toMatchObject({ imported: 2, failed: 0 });
    expect([...written.keys()]).toEqual(['e0.bin', 'e1.bin']);
    expect(bytesIn(written)).toBeLessThanOrEqual(10000);
  });

  it('imports an archive whose total is exactly the cap', async () => {
    const written = new Map<string, Buffer>();
    const result = await withTotalCap('8000', () => importEntries(written, [4000, 4000]));

    expect(result).toEqual({ imported: 2, failed: 0 });
    expect(bytesIn(written)).toBe(8000);
  });

  it('warns at export time when the archive holds more bytes than the import accepts', async () => {
    const exportWith = async (cap: string) => {
      const logger = makeLogger();
      await withTotalCap(cap, async () => {
        const { openFile } = trackingOpener();
        const output = await createExportStream(() => Promise.resolve(files.slice(0, 3)), openFile, logger as never);
        await new Promise<void>(resolve => output.on('end', resolve).resume());
      });
      return logger.warn;
    };

    expect(await exportWith(String(3 * FILE_BYTES))).not.toHaveBeenCalled();
    expect(await exportWith(String(3 * FILE_BYTES - 1))).toHaveBeenCalledWith(
      expect.stringContaining('Raise STORAGE_IMPORT_MAX_TOTAL_BYTES'),
    );
  });
});

describe('createExportStream and the per-entry import cap', () => {
  it('warns at export time when one file is larger than the import accepts', async () => {
    const exportWith = async (cap: string) => {
      const logger = makeLogger();
      const prev = process.env.STORAGE_IMPORT_MAX_BYTES;
      process.env.STORAGE_IMPORT_MAX_BYTES = cap;
      try {
        const { openFile } = trackingOpener();
        const output = await createExportStream(() => Promise.resolve(files.slice(0, 3)), openFile, logger as never);
        await new Promise<void>(resolve => output.on('end', resolve).resume());
      } finally {
        if (prev === undefined) delete process.env.STORAGE_IMPORT_MAX_BYTES;
        else process.env.STORAGE_IMPORT_MAX_BYTES = prev;
      }
      return logger.warn;
    };

    expect(await exportWith(String(FILE_BYTES))).not.toHaveBeenCalled();
    const warn = await exportWith(String(FILE_BYTES - 1));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Raise STORAGE_IMPORT_MAX_BYTES'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`(${FILE_BYTES} bytes)`));
  });
});

describe('the per-entry import cap boundary', () => {
  const importOne = async (cap: string, size: number) => {
    const prev = process.env.STORAGE_IMPORT_MAX_BYTES;
    process.env.STORAGE_IMPORT_MAX_BYTES = cap;
    const pack = tar.pack();
    pack.entry({ name: 'only.bin' }, Buffer.alloc(size, 0x61));
    pack.finalize();
    try {
      return await importFromStream(pack.pipe(createGzip()), () => Promise.resolve(), makeLogger() as never).catch(
        (err: unknown) => err,
      );
    } finally {
      if (prev === undefined) delete process.env.STORAGE_IMPORT_MAX_BYTES;
      else process.env.STORAGE_IMPORT_MAX_BYTES = prev;
    }
  };

  it('imports an entry of exactly the cap and aborts on one byte more', async () => {
    expect(await importOne('10', 10)).toEqual({ imported: 1, failed: 0 });
    const over = await importOne('10', 11);
    expect(over).toBeInstanceOf(Error);
    expect((over as Error).message).toMatch(/10-byte per-entry cap \(STORAGE_IMPORT_MAX_BYTES\)/);
  });
});

describe('createExportStream and the entry-count limit this deployment lowered', () => {
  it('warns above the lower limit, though the shipped default would not', async () => {
    const prev = process.env.STORAGE_IMPORT_MAX_ENTRIES;
    process.env.STORAGE_IMPORT_MAX_ENTRIES = '2';
    const logger = makeLogger();
    try {
      const { openFile } = trackingOpener();
      const output = await createExportStream(() => Promise.resolve(files.slice(0, 3)), openFile, logger as never);
      await new Promise<void>(resolve => output.on('end', resolve).resume());
    } finally {
      if (prev === undefined) delete process.env.STORAGE_IMPORT_MAX_ENTRIES;
      else process.env.STORAGE_IMPORT_MAX_ENTRIES = prev;
    }
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('above the import limit of 2'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Raise STORAGE_IMPORT_MAX_ENTRIES'));
  });
});

// A backend that does not report a length (ExportFileSource.size is optional) still exports a file the
// destination may refuse, so the warning is worked out from the bytes actually read.
describe('createExportStream warns about import limits for files of unreported size', () => {
  const exportWithLimits = async (limits: Record<string, string>, sizes: number[]) => {
    const previous = Object.fromEntries(Object.keys(limits).map(key => [key, process.env[key]]));
    Object.assign(process.env, limits);
    const logger = makeLogger();
    try {
      const names = sizes.map((_, index) => `media/unknown-${index}.bin`);
      const output = await createExportStream(
        () => Promise.resolve(names),
        name => Promise.resolve({ stream: Readable.from([Buffer.alloc(sizes[names.indexOf(name)], 0x61)]) }),
        logger as never,
      );
      await new Promise<void>(resolve => output.on('end', resolve).resume());
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    return logger;
  };

  it('warns when one file is above the per-entry limit', async () => {
    const logger = await exportWithLimits({ STORAGE_IMPORT_MAX_BYTES: '5' }, [6]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Raise STORAGE_IMPORT_MAX_BYTES'));
  });

  it('warns when the files together are above the total limit', async () => {
    const logger = await exportWithLimits({ STORAGE_IMPORT_MAX_TOTAL_BYTES: '5' }, [3, 3]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Raise STORAGE_IMPORT_MAX_TOTAL_BYTES'));
  });

  it('stays quiet at exactly the limits', async () => {
    const logger = await exportWithLimits(
      { STORAGE_IMPORT_MAX_BYTES: '3', STORAGE_IMPORT_MAX_TOTAL_BYTES: '6' },
      [3, 3],
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// docs/14, .env.example and the upgrade notes state these figures, and an operator sizes an import
// against them: a drifted default changes what an import is allowed to extract without a word.
describe('storage import caps', () => {
  it('ship at the documented defaults', () => {
    expect(DEFAULT_IMPORT_MAX_BYTES).toBe(209_715_200);
    expect(DEFAULT_IMPORT_MAX_ENTRIES).toBe(100_000);
    expect(DEFAULT_IMPORT_MAX_TOTAL_BYTES).toBe(10_737_418_240);
  });
});

describe('streaming tar transfer avoids large heap buffering', () => {
  it('spills unsized export streams cleanly and streams tar entries during import via putStream without Buffer.concat of whole payloads', async () => {
    const payload = randomBytes(512 * 1024);
    const largeConcatSizes: number[] = [];
    const realConcat = Buffer.concat.bind(Buffer);
    const concatSpy = jest
      .spyOn(Buffer, 'concat')
      .mockImplementation((list: readonly Uint8Array[], totalLength?: number) => {
        const out = realConcat(list, totalLength);
        if (out.length >= 256 * 1024) largeConcatSizes.push(out.length);
        return out;
      });

    try {
      const openUnsized = (): Promise<ExportFileSource> =>
        Promise.resolve({
          size: undefined,
          stream: Readable.from(
            Array.from({ length: payload.length / 4096 }, (_, i) => payload.subarray(i * 4096, (i + 1) * 4096)),
          ),
        });

      const exported = await createExportStream(
        () => Promise.resolve(['media/unsized.bin']),
        openUnsized,
        makeLogger() as never,
      );

      const streamed = new Map<string, { bytes: Buffer; reportedSize: number }>();
      const putStream = async (filePath: string, stream: Readable, sizeBytes: number) => {
        const chunks: Buffer[] = [];
        for await (const c of stream as AsyncIterable<Buffer | Uint8Array | string>) {
          chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        }
        streamed.set(filePath, { bytes: realConcat(chunks), reportedSize: sizeBytes });
      };

      const res = await importFromStream(
        exported,
        () => Promise.reject(new Error('should prefer streaming putStream over buffering putFile')),
        makeLogger() as never,
        { putStream },
      );

      expect(res).toEqual({ imported: 1, failed: 0 });
      expect(largeConcatSizes).toEqual([]);
      expect(streamed.get('media/unsized.bin')?.reportedSize).toBe(payload.length);
      expect(streamed.get('media/unsized.bin')?.bytes.equals(payload)).toBe(true);
    } finally {
      concatSpy.mockRestore();
    }
  });

  it('destroys output and cleans up spill files when an unsized export stream fails or output closes early', async () => {
    const logger = makeLogger();
    const failing = await createExportStream(
      () => Promise.resolve(['media/fail.bin']),
      () =>
        Promise.resolve({
          size: undefined,
          stream: new Readable({
            read() {
              this.destroy(new Error('unsized read boom'));
            },
          }),
        }),
      logger as never,
    );
    await expect(
      new Promise<void>((resolve, reject) => {
        failing.on('error', reject);
        failing.on('end', resolve);
        failing.resume();
      }),
    ).rejects.toThrow('unsized read boom');
    expect(logger.error).toHaveBeenCalledWith('Export failed reading file: media/fail.bin', 'Error: unsized read boom');

    const slowSrc = new PassThrough();
    const closedEarly = await createExportStream(
      () => Promise.resolve(['media/slow.bin']),
      () => Promise.resolve({ size: undefined, stream: slowSrc }),
      logger as never,
    );
    await new Promise(resolve => setTimeout(resolve, 15));
    closedEarly.destroy();
    slowSrc.end(Buffer.alloc(32, 0x42));
    await new Promise(resolve => setTimeout(resolve, 25));

    // putStream error counts against failed imports without aborting the archive.
    const validTarGz = await createExportStream(
      () => Promise.resolve(['media/ok.bin']),
      () => Promise.resolve({ size: 4, stream: Readable.from([Buffer.from('abcd')]) }),
      logger as never,
    );
    const failedRes = await importFromStream(validTarGz, () => Promise.resolve(), logger as never, {
      putStream: () => Promise.reject(new Error('stream upload failed')),
    });
    expect(failedRes).toEqual({ imported: 0, failed: 1 });

    // Corrupt tar bytes inside valid gzip surface through extract.on('error').
    await expect(
      importFromStream(Readable.from([gzipSync(Buffer.alloc(1024, 0x78))]), () => Promise.resolve(), logger as never),
    ).rejects.toThrow();
  });

  it('destroys output cleanly without rm(undefined) if mkdtemp rejects for an unsized export entry', async () => {
    const logger = makeLogger();
    const mkdtempErr = Object.assign(new Error('ENOSPC: tmp full'), { code: 'ENOSPC' });
    const mkdtempSpy = jest.spyOn(fs.promises, 'mkdtemp').mockRejectedValueOnce(mkdtempErr);
    const rmSpy = jest.spyOn(fs.promises, 'rm');

    try {
      const output = await createExportStream(
        () => Promise.resolve(['media/unsized.bin']),
        () => Promise.resolve({ size: undefined, stream: Readable.from([Buffer.from('hello')]) }),
        logger as never,
      );
      await expect(
        new Promise<void>((resolve, reject) => {
          output.on('error', reject);
          output.on('end', resolve);
          output.resume();
        }),
      ).rejects.toThrow('ENOSPC: tmp full');
      expect(rmSpy).not.toHaveBeenCalled();
    } finally {
      mkdtempSpy.mockRestore();
      rmSpy.mockRestore();
    }
  });

  it('keeps temp files alive for in-flight putStream until upload settles and removes tmpDir afterward on mid-import abort', async () => {
    const logger = makeLogger();
    let createdTmpDir = '';

    const pack = tar.pack();
    pack.entry({ name: 'first.bin' }, Buffer.from('first-payload'));
    pack.entry({ name: 'second.bin' }, Buffer.from('second-payload'));
    pack.finalize();
    const archiveBytes = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      pack
        .pipe(createGzip())
        .on('data', (c: Buffer) => chunks.push(c))
        .on('end', () => resolve(Buffer.concat(chunks)))
        .on('error', reject);
    });

    const input = new PassThrough();
    let releaseUpload!: () => void;
    let uploadStarted!: () => void;
    const uploadStartedP = new Promise<void>(resolve => (uploadStarted = resolve));
    const readChunks: Buffer[] = [];

    const importP = importFromStream(input, () => Promise.resolve(), logger as never, {
      putStream: async (_key, stream) => {
        const entryPath = String((stream as unknown as { path?: string }).path ?? '');
        createdTmpDir = path.dirname(entryPath);
        uploadStarted();
        await new Promise<void>(resolve => (releaseUpload = resolve));
        for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) {
          readChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
      },
    });

    // Feed enough bytes to deliver first.bin while leaving gzip incomplete, then fail input mid-import.
    input.write(archiveBytes.subarray(0, archiveBytes.length - 4));
    await uploadStartedP;

    input.destroy(new Error('mid-import network drop'));
    await expect(importP).rejects.toThrow('mid-import network drop');

    // In-flight putStream must still be able to read its temp file without ENOENT from premature rm -rf.
    expect(createdTmpDir).not.toBe('');
    expect(fs.existsSync(createdTmpDir)).toBe(true);
    releaseUpload();
    await waitUntil(() => !fs.existsSync(createdTmpDir));
    expect(Buffer.concat(readChunks).toString()).toBe('first-payload');
  });
});
