import * as os from 'os';
import * as path from 'path';
import type { ConfigService } from '@nestjs/config';

// The module namespace of fs cannot be spied on, so chmodSync is a passthrough the specs below can make refuse.
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return { ...actual, chmodSync: jest.fn(actual.chmodSync), statSync: jest.fn(actual.statSync) };
});

import * as fs from 'fs';
import { LoggerService } from '../services/logger.service';
import { StorageService } from './storage.service';

const realFs = jest.requireActual<typeof import('fs')>('fs');
const chmodSync = fs.chmodSync as jest.Mock;
const statSync = fs.statSync as jest.Mock;

// Making the root owner-only is best effort: a volume or bind mount owned by another user refuses the chmod. The
// gateway then keeps what it found, so it says so once at boot instead of leaving the operator to assume 0700.
describe('StorageService (local) root it cannot make owner-only', () => {
  const dirs: string[] = [];
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    chmodSync.mockReset().mockImplementation(realFs.chmodSync);
    statSync.mockReset().mockImplementation(realFs.statSync);
    for (const dir of dirs.splice(0)) realFs.rmSync(dir, { recursive: true, force: true });
  });

  const modeOf = (target: string): number => realFs.statSync(target).mode & 0o7777;
  const warnings = (): string[] => warn.mock.calls.map(([message]) => String(message));

  /** A root that exists with the given mode, as a directory mounted from elsewhere does. */
  const rootWithMode = (mode: number): string => {
    const baseDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'owa-storage-'));
    dirs.push(baseDir);
    const localPath = path.join(baseDir, 'media');
    realFs.mkdirSync(localPath);
    realFs.chmodSync(localPath, mode);
    return localPath;
  };

  const build = (localPath: string, type = 'local'): StorageService =>
    new StorageService({
      get: (key: string) => (key === 'storage.type' ? type : key === 'storage.localPath' ? localPath : undefined),
    } as unknown as ConfigService);

  /** What a directory owned by another user answers to the owner-only chmod. */
  const refuseChmodAt = (localPath: string): void => {
    chmodSync.mockImplementation((target: fs.PathLike, mode: fs.Mode) => {
      if (String(target) === localPath) {
        throw Object.assign(new Error(`EPERM: operation not permitted, chmod '${localPath}'`), { code: 'EPERM' });
      }
      realFs.chmodSync(target, mode);
    });
  };

  // The warning is a diagnostic: a directory that cannot be read back is no reason to stop the boot.
  it('starts without a warning when the root cannot be read back', () => {
    const localPath = rootWithMode(0o755);
    refuseChmodAt(localPath);
    statSync.mockImplementation((target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target) === localPath) {
        throw Object.assign(new Error(`EACCES: permission denied, stat '${localPath}'`), { code: 'EACCES' });
      }
      return (realFs.statSync as (...args: unknown[]) => fs.Stats)(target, ...rest);
    });

    expect(() => build(localPath)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs one warning naming the path, its mode and what to do, and starts anyway', () => {
    const localPath = rootWithMode(0o755);
    refuseChmodAt(localPath);

    expect(() => build(localPath)).not.toThrow();

    // The refusal really kept the root open, so the warning is about a root that stayed open.
    expect(chmodSync).toHaveBeenCalledWith(localPath, 0o700);
    expect(modeOf(localPath)).toBe(0o755);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warnings()[0];
    expect(message).toContain(`'${localPath}'`);
    expect(message).toContain('mode 0755');
    expect(message).toContain('could not be made owner-only (0700)');
    expect(message).toContain(`gateway runs as uid ${String(process.getuid?.())}`);
    expect(message).toContain('Own the directory as the gateway');
    expect(message).toContain('restrict it from outside');
  });

  it('shows a special bit of the mode as it is', () => {
    const localPath = rootWithMode(0o1777);
    refuseChmodAt(localPath);

    build(localPath);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warnings()[0]).toContain('mode 1777');
  });

  it('warns for a group-only root too: the group can still read it', () => {
    const localPath = rootWithMode(0o750);
    refuseChmodAt(localPath);

    build(localPath);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warnings()[0]).toContain('mode 0750');
  });

  it('does not warn about a root it makes owner-only', () => {
    const localPath = rootWithMode(0o755);

    build(localPath);

    expect(chmodSync).toHaveBeenCalledWith(localPath, 0o700);
    expect(modeOf(localPath)).toBe(0o700);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn about a root it creates or one that is already owner-only', () => {
    const baseDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'owa-storage-'));
    dirs.push(baseDir);

    build(path.join(baseDir, 'created'));
    build(rootWithMode(0o700));

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once under STORAGE_TYPE=s3 as well, where the same directory is the fallback', () => {
    const localPath = rootWithMode(0o755);
    refuseChmodAt(localPath);
    const env = { ...process.env };
    for (const key of ['S3_ACCESS_KEY_ID', 'S3_ACCESS_KEY', 'S3_SECRET_ACCESS_KEY', 'S3_SECRET_KEY']) {
      delete process.env[key];
    }

    try {
      build(localPath, 's3');
    } finally {
      process.env = env;
    }

    // The other warning of this configuration says the credentials are missing; this one is about the directory.
    const about = warnings().filter(message => message.includes('could not be made owner-only'));
    expect(about).toHaveLength(1);
  });

  it('does not warn on Windows, which reports no POSIX modes', () => {
    const localPath = rootWithMode(0o755);
    refuseChmodAt(localPath);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    Object.defineProperty(process, 'platform', { value: 'win32' });

    try {
      build(localPath);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }

    expect(warn).not.toHaveBeenCalled();
  });
});
