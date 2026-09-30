import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable, Writable } from 'stream';

// StorageService (imported transitively by the infra controllers) pulls in `archiver`
// v8, which is ESM-only and cannot be parsed by ts-jest. The controller logic
// under test never touches archiver, so a lightweight stub is sufficient.
jest.mock('archiver', () => ({ default: jest.fn() }));

// saveConfig writes the generated env via fs.writeFileSync and reads the existing file
// via fs.existsSync/readFileSync; mock those so tests assert produced content without
// touching the filesystem. existsSync defaults to false (no prior config).
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    writeFileSync: jest.fn(),
    // saveConfig now writes the generated env via writeSecretFile, which chmods 0600 — mock it
    // so the secret-hygiene path never touches the real filesystem.
    chmodSync: jest.fn(),
    existsSync: jest.fn().mockReturnValue(false),
    readFileSync: jest.fn().mockReturnValue(''),
    createReadStream: jest.fn(() => jest.requireActual<typeof import('stream')>('stream').Readable.from([])),
    createWriteStream: jest.fn(actual.createWriteStream),
  };
});

import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { InfraStorageController } from './infra-storage.controller';
import { AuditAction } from '../audit/entities/audit-log.entity';

describe('InfraStorageController.importStorage filePath validation', () => {
  function buildController(storage: Partial<{ importFromStream: jest.Mock; getCurrentStorageType: jest.Mock }>) {
    return new InfraStorageController(storage as never);
  }

  it('rejects a filePath that escapes the data directory before touching the filesystem', async () => {
    const storage = { importFromStream: jest.fn(), getCurrentStorageType: jest.fn(() => 'local') };
    const controller = buildController(storage);

    await expect(controller.importStorage({ filePath: '../../../../etc/passwd' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(storage.importFromStream).not.toHaveBeenCalled();
  });

  it('guards and opens the same cwd-resolved path returned by storage export', async () => {
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/srv/openwa');
    (fs.existsSync as jest.Mock).mockImplementation((p: string) => p === '/srv/openwa/data/exports/export.tar.gz');
    (fs.createReadStream as jest.Mock).mockClear();
    const storage = {
      importFromStream: jest.fn().mockResolvedValue({ imported: 3, failed: 0 }),
      getCurrentStorageType: jest.fn(() => 'local'),
    };
    try {
      const result = await buildController(storage).importStorage({ filePath: 'data/exports/export.tar.gz' });
      expect(fs.createReadStream).toHaveBeenCalledWith('/srv/openwa/data/exports/export.tar.gz');
      expect(storage.importFromStream).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ imported: true, count: 3, failed: 0, storageType: 'local' });
    } finally {
      cwdSpy.mockRestore();
      (fs.existsSync as jest.Mock).mockReturnValue(false);
    }
  });
});

describe('InfraStorageController.exportStorage keeps the export import-able and sweeps it', () => {
  function buildController(storage: Partial<{ createExportStream: jest.Mock }>) {
    return new InfraStorageController({ getCurrentStorageType: () => 'local', ...storage } as never);
  }

  // fs.existsSync is globally mocked in this file, so probe the real filesystem via fs.promises.access.
  const exists = (p: string): Promise<boolean> =>
    fs.promises
      .access(p)
      .then(() => true)
      .catch(() => false);

  // Poll (don't sleep a fixed time) so the sweep assertion isn't flaky under CI load.
  const waitForGone = async (p: string, timeoutMs = 3000): Promise<void> => {
    const start = Date.now();
    while (await exists(p)) {
      if (Date.now() - start > timeoutMs) throw new Error(`file was not swept in time: ${p}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };

  let cwdSpy: jest.SpyInstance | undefined;
  let cwd: string | undefined;

  afterEach(() => {
    cwdSpy?.mockRestore();
    if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
    cwdSpy = undefined;
    cwd = undefined;
    delete process.env.STORAGE_EXPORT_TTL_MS;
  });

  it('writes under data/exports (so it stays import-able + survives restart) and TTL-sweeps it', async () => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-cwd-'));
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(cwd);
    process.env.STORAGE_EXPORT_TTL_MS = '30';
    const createExportStream = jest.fn().mockResolvedValue(Readable.from([Buffer.from('archive-bytes')]));
    const controller = buildController({ createExportStream });

    const result = await controller.exportStorage();

    // download is cwd-relative (no absolute host path leak) and stays under data/exports so the import
    // handler — which only accepts paths inside data/ — can still consume it.
    expect(path.isAbsolute(result.download)).toBe(false);
    expect(result.download.startsWith(path.join('data', 'exports'))).toBe(true);
    // Resolve against the (mocked) cwd to check on-disk existence; fs itself uses the real cwd.
    const abs = path.join(cwd, result.download);
    expect(await exists(abs)).toBe(true);

    await waitForGone(abs);
    expect(await exists(abs)).toBe(false);
  });
});

describe('InfraStorageController.sweepStaleExportArchives (boot orphan sweep)', () => {
  function buildController() {
    return new InfraStorageController({} as never);
  }

  // A name in exactly the shape exportStorage writes: storage-export-<epochMs>-<uuid>.tar.gz.
  const archiveName = (epochMs: number): string =>
    `storage-export-${epochMs}-3b241101-e2bb-4255-8caf-4136c566a962.tar.gz`;

  const exists = (p: string): Promise<boolean> =>
    fs.promises
      .access(p)
      .then(() => true)
      .catch(() => false);

  let dir: string | undefined;
  let cwdSpy: jest.SpyInstance | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-exports-'));
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    cwdSpy = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    delete process.env.STORAGE_EXPORT_SWEEP_MAX_AGE_MS;
  });

  const touch = async (name: string): Promise<string> => {
    const p = path.join(dir!, name);
    await fs.promises.writeFile(p, 'archive-bytes');
    return p;
  };

  it('deletes export archives older than the default 24h but keeps young archives and non-export files', async () => {
    const stale = await touch(archiveName(Date.now() - 25 * 60 * 60 * 1000));
    const young = await touch(archiveName(Date.now() - 60 * 1000));
    const operatorImportCandidate = await touch('to-import.tar.gz');
    // Near-miss names are NOT ours: no uuid / wrong extension / different prefix.
    const noUuid = await touch(`storage-export-${Date.now() - 48 * 60 * 60 * 1000}.tar.gz`);
    const wrongExt = await touch(archiveName(Date.now() - 48 * 60 * 60 * 1000).replace(/\.tar\.gz$/, '.zip'));
    const otherPrefix = await touch(`backup-${Date.now() - 48 * 60 * 60 * 1000}.tar.gz`);

    await buildController().sweepStaleExportArchives(dir);

    expect(await exists(stale)).toBe(false);
    expect(await exists(young)).toBe(true);
    expect(await exists(operatorImportCandidate)).toBe(true);
    expect(await exists(noUuid)).toBe(true);
    expect(await exists(wrongExt)).toBe(true);
    expect(await exists(otherPrefix)).toBe(true);
  });

  it('takes the max age from STORAGE_EXPORT_SWEEP_MAX_AGE_MS', async () => {
    const oneHourOld = archiveName(Date.now() - 60 * 60 * 1000);

    // A 30-minute cap sweeps a 1-hour-old archive...
    process.env.STORAGE_EXPORT_SWEEP_MAX_AGE_MS = '1800000';
    const swept = await touch(oneHourOld);
    await buildController().sweepStaleExportArchives(dir);
    expect(await exists(swept)).toBe(false);

    // ...while a 2-hour cap keeps it.
    process.env.STORAGE_EXPORT_SWEEP_MAX_AGE_MS = '7200000';
    const kept = await touch(oneHourOld);
    await buildController().sweepStaleExportArchives(dir);
    expect(await exists(kept)).toBe(true);
  });

  it('resolves quietly when the exports directory does not exist yet', async () => {
    await expect(buildController().sweepStaleExportArchives(path.join(dir!, 'never-created'))).resolves.toBeUndefined();
  });

  it('runs the sweep against <cwd>/data/exports at application bootstrap', async () => {
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(dir!);
    const exportDir = path.join(dir!, 'data', 'exports');
    await fs.promises.mkdir(exportDir, { recursive: true });
    const stale = path.join(exportDir, archiveName(Date.now() - 25 * 60 * 60 * 1000));
    await fs.promises.writeFile(stale, 'archive-bytes');

    await buildController().onApplicationBootstrap();

    expect(await exists(stale)).toBe(false);
  });
});

describe('InfraStorageController storage stream failures surface as request errors, not process crashes', () => {
  it('importStorage maps an archive/stream failure to a 400 with the real reason', async () => {
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/srv/openwa');
    (fs.existsSync as jest.Mock).mockImplementation((p: string) => p === '/srv/openwa/data/exports/bad.tar.gz');
    try {
      const storage = {
        importFromStream: jest.fn().mockRejectedValue(new Error('incorrect header check')),
        getCurrentStorageType: () => 'local',
      };
      const controller = new InfraStorageController(storage as never);
      const err = await controller.importStorage({ filePath: 'data/exports/bad.tar.gz' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toContain('incorrect header check');
    } finally {
      cwdSpy.mockRestore();
      (fs.existsSync as jest.Mock).mockReturnValue(false);
    }
  });

  it('exportStorage destroys the export stream when the archive file cannot be written', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-export-sink-'));
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(cwd);
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('disk full'));
      },
    });
    (fs.createWriteStream as jest.Mock).mockReturnValueOnce(sink);
    try {
      // The export fills the archive while it is being written; a failed sink must stop it, or it
      // keeps a file open waiting for a reader that is gone.
      const source = new Readable({
        read() {
          this.push(Buffer.alloc(1024));
        },
      });
      const storage = { createExportStream: jest.fn().mockResolvedValue(source), getCurrentStorageType: () => 'local' };
      await expect(new InfraStorageController(storage as never).exportStorage()).rejects.toThrow(/disk full/);
      expect(source.destroyed).toBe(true);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('exportStorage rejects (and the process lives) when the export source stream errors', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-export-err-'));
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(cwd);
    try {
      // pipe() never forwards source errors: without a listener on the source this would be an
      // unhandled 'error' event and kill the process instead of failing the request.
      const errStream = new Readable({
        read() {
          this.destroy(new Error('archive boom'));
        },
      });
      const storage = {
        createExportStream: jest.fn().mockResolvedValue(errStream),
        getCurrentStorageType: () => 'local',
      };
      const controller = new InfraStorageController(storage as never);
      await expect(controller.exportStorage()).rejects.toThrow(/archive boom/);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// The infra module's sensitive ADMIN operations (credential config write, restart/Docker
// orchestration, full-DB + storage export/import) must leave an audit trail — each emits an AuditAction.
describe('InfraStorageController audit trail (light-dependency handlers)', () => {
  const makeAudit = (): { logInfo: jest.Mock } => ({ logInfo: jest.fn().mockResolvedValue(null) });

  // Positional constructor: (storageService, auditService?). auditService is the last @Optional arg.
  const build = (
    audit: { logInfo: jest.Mock },
    overrides: Partial<{
      storageService: unknown;
    }> = {},
  ): InfraStorageController => new InfraStorageController((overrides.storageService ?? {}) as never, audit as never);

  it('importStorage emits INFRA_STORAGE_IMPORTED with the imported file count', async () => {
    const audit = makeAudit();
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/srv/openwa');
    (fs.existsSync as jest.Mock).mockImplementation((p: string) => p === '/srv/openwa/data/exports/x.tar.gz');
    try {
      const storageService = {
        importFromStream: jest.fn().mockResolvedValue({ imported: 5, failed: 0 }),
        getCurrentStorageType: () => 'local',
      };
      await build(audit, { storageService }).importStorage({ filePath: 'data/exports/x.tar.gz' });
      const calls = audit.logInfo.mock.calls as Array<
        [AuditAction, { metadata: { count: number; storageType: string } }]
      >;
      expect(calls[0][0]).toBe(AuditAction.INFRA_STORAGE_IMPORTED);
      expect(calls[0][1].metadata).toEqual({ count: 5, failed: 0, storageType: 'local' });
    } finally {
      cwdSpy.mockRestore();
      (fs.existsSync as jest.Mock).mockReturnValue(false);
    }
  });

  it('importStorage records an import that wrote nothing as a warning, with its failed count', async () => {
    const audit = { logInfo: jest.fn().mockResolvedValue(null), logWarn: jest.fn().mockResolvedValue(null) };
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/srv/openwa');
    (fs.existsSync as jest.Mock).mockImplementation((p: string) => p === '/srv/openwa/data/exports/x.tar.gz');
    try {
      const storageService = {
        importFromStream: jest.fn().mockResolvedValue({ imported: 0, failed: 4 }),
        getCurrentStorageType: () => 'local',
      };
      await new InfraStorageController(storageService as never, audit as never).importStorage({
        filePath: 'data/exports/x.tar.gz',
      });
      expect(audit.logInfo).not.toHaveBeenCalled();
      expect(audit.logWarn).toHaveBeenCalledWith(AuditAction.INFRA_STORAGE_IMPORTED, {
        metadata: { count: 0, failed: 4, storageType: 'local' },
      });
    } finally {
      cwdSpy.mockRestore();
      (fs.existsSync as jest.Mock).mockReturnValue(false);
    }
  });

  it('exportStorage emits INFRA_STORAGE_EXPORTED', async () => {
    const audit = makeAudit();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-audit-'));
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(cwd);
    process.env.STORAGE_EXPORT_TTL_MS = '30';
    try {
      const storageService = {
        createExportStream: jest.fn().mockResolvedValue(Readable.from([Buffer.from('x')])),
        getCurrentStorageType: () => 'local',
      };
      await build(audit, { storageService }).exportStorage();
      const calls = audit.logInfo.mock.calls as Array<[AuditAction, { metadata: { download: string } }]>;
      expect(calls[0][0]).toBe(AuditAction.INFRA_STORAGE_EXPORTED);
      expect(typeof calls[0][1].metadata.download).toBe('string');
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(cwd, { recursive: true, force: true });
      delete process.env.STORAGE_EXPORT_TTL_MS;
    }
  });
});

describe('InfraStorageController refuses to run a storage migration against the local fallback', () => {
  function unavailableS3() {
    return {
      getCurrentStorageType: jest.fn(() => 's3'),
      refreshS3Availability: jest.fn().mockResolvedValue(false),
      getFileCount: jest.fn(),
      createExportStream: jest.fn(),
      importFromStream: jest.fn(),
    };
  }

  it('answers 503 for the file count, the export and the import when the configured bucket is unusable', async () => {
    const storage = unavailableS3();
    const controller = new InfraStorageController(storage as never);

    await expect(controller.getStorageFileCount()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(controller.exportStorage()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(controller.importStorage({ filePath: 'data/exports/x.tar.gz' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(storage.refreshS3Availability).toHaveBeenCalledTimes(3);
    expect(storage.getFileCount).not.toHaveBeenCalled();
    expect(storage.createExportStream).not.toHaveBeenCalled();
    expect(storage.importFromStream).not.toHaveBeenCalled();
  });

  it('proceeds once the re-probe finds the bucket', async () => {
    const storage = unavailableS3();
    storage.refreshS3Availability.mockResolvedValue(true);
    storage.getFileCount.mockResolvedValue({ count: 2, sizeBytes: 0 });

    await expect(new InfraStorageController(storage as never).getStorageFileCount()).resolves.toMatchObject({
      storageType: 's3',
      count: 2,
    });
  });

  it('never probes S3 for a local backend', async () => {
    const storage = { ...unavailableS3(), getCurrentStorageType: jest.fn(() => 'local') };
    storage.getFileCount.mockResolvedValue({ count: 0, sizeBytes: 0 });

    await new InfraStorageController(storage as never).getStorageFileCount();

    expect(storage.refreshS3Availability).not.toHaveBeenCalled();
  });
});

describe('InfraStorageController.importStorage reports an import that wrote nothing', () => {
  async function importWith(result: { imported: number; failed: number }) {
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/srv/openwa');
    (fs.existsSync as jest.Mock).mockImplementation((p: string) => p === '/srv/openwa/data/exports/x.tar.gz');
    try {
      const storage = { importFromStream: jest.fn().mockResolvedValue(result), getCurrentStorageType: () => 'local' };
      return await new InfraStorageController(storage as never).importStorage({ filePath: 'data/exports/x.tar.gz' });
    } finally {
      cwdSpy.mockRestore();
      (fs.existsSync as jest.Mock).mockReturnValue(false);
    }
  }

  it('answers imported:false when every entry was refused', async () => {
    await expect(importWith({ imported: 0, failed: 4 })).resolves.toEqual({
      imported: false,
      count: 0,
      failed: 4,
      storageType: 'local',
    });
  });

  it('keeps imported:true when only some entries were skipped', async () => {
    await expect(importWith({ imported: 3, failed: 1 })).resolves.toMatchObject({ imported: true, failed: 1 });
  });

  it('keeps imported:true for an empty archive', async () => {
    await expect(importWith({ imported: 0, failed: 0 })).resolves.toMatchObject({ imported: true, count: 0 });
  });
});
