import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';

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
  };
});

import { BadRequestException } from '@nestjs/common';
import { InfraStorageController } from './infra-storage.controller';
import { AuditAction } from '../audit/entities/audit-log.entity';

describe('InfraStorageController.importStorage filePath validation (Vuln 3)', () => {
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
      importFromStream: jest.fn().mockResolvedValue(3),
      getCurrentStorageType: jest.fn(() => 'local'),
    };
    try {
      const result = await buildController(storage).importStorage({ filePath: 'data/exports/export.tar.gz' });
      expect(fs.createReadStream).toHaveBeenCalledWith('/srv/openwa/data/exports/export.tar.gz');
      expect(storage.importFromStream).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ imported: true, count: 3, storageType: 'local' });
    } finally {
      cwdSpy.mockRestore();
      (fs.existsSync as jest.Mock).mockReturnValue(false);
    }
  });
});

describe('InfraStorageController.exportStorage keeps the export import-able and sweeps it', () => {
  function buildController(storage: Partial<{ createExportStream: jest.Mock }>) {
    return new InfraStorageController(storage as never);
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
      const storage = { createExportStream: jest.fn().mockResolvedValue(errStream) };
      const controller = new InfraStorageController(storage as never);
      await expect(controller.exportStorage()).rejects.toThrow(/archive boom/);
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// C002: the infra module exposed sensitive ADMIN operations (credential config write, restart/Docker
// orchestration, full-DB + storage export/import) with no audit trail. Each now emits an AuditAction.
describe('InfraStorageController C002 audit trail (light-dependency handlers)', () => {
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
      const storageService = { importFromStream: jest.fn().mockResolvedValue(5), getCurrentStorageType: () => 'local' };
      await build(audit, { storageService }).importStorage({ filePath: 'data/exports/x.tar.gz' });
      const calls = audit.logInfo.mock.calls as Array<
        [AuditAction, { metadata: { count: number; storageType: string } }]
      >;
      expect(calls[0][0]).toBe(AuditAction.INFRA_STORAGE_IMPORTED);
      expect(calls[0][1].metadata).toEqual({ count: 5, storageType: 'local' });
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
      const storageService = { createExportStream: jest.fn().mockResolvedValue(Readable.from([Buffer.from('x')])) };
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
