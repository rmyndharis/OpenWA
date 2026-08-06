import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_STORAGE_ROOT, isStorageRootWritable, resolveStorageRoot } from './storage-root';

describe('resolveStorageRoot', () => {
  const writableAlways = (): boolean => true;
  const writableNever = (): boolean => false;

  it('returns the configured root unchanged when it is writable', () => {
    expect(resolveStorageRoot({ configured: './data/media', isWritable: writableAlways })).toBe('./data/media');
  });

  it('returns the default when nothing is configured', () => {
    expect(resolveStorageRoot({ configured: undefined, isWritable: writableAlways })).toBe(DEFAULT_STORAGE_ROOT);
  });

  it('leaves a WRITABLE ./uploads alone — a healthy bare-metal install must not be relocated', () => {
    expect(resolveStorageRoot({ configured: './uploads', isWritable: writableAlways })).toBe('./uploads');
  });

  it('migrates an UNWRITABLE ./uploads fossil to the default and warns', () => {
    const warnings: string[] = [];
    const effective = resolveStorageRoot({
      configured: './uploads',
      isWritable: (p: string): boolean => p !== './uploads',
      logger: { warn: (m: string): void => void warnings.push(m) },
    });

    expect(effective).toBe(DEFAULT_STORAGE_ROOT);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('STORAGE_LOCAL_PATH');
    expect(warnings[0]).toContain('./uploads');
  });

  it('migrates the bare "uploads" spelling too — path.join normalises ./uploads to it', () => {
    expect(resolveStorageRoot({ configured: 'uploads', isWritable: (p: string): boolean => p !== 'uploads' })).toBe(
      DEFAULT_STORAGE_ROOT,
    );
  });

  it('throws an actionable error naming STORAGE_LOCAL_PATH when a non-fossil root is unwritable', () => {
    expect(() => resolveStorageRoot({ configured: '/mnt/readonly', isWritable: writableNever })).toThrow(
      /STORAGE_LOCAL_PATH/,
    );
    expect(() => resolveStorageRoot({ configured: '/mnt/readonly', isWritable: writableNever })).toThrow(
      /\/mnt\/readonly/,
    );
  });

  it('throws rather than silently continuing when the fossil AND the migration target are both unwritable', () => {
    expect(() => resolveStorageRoot({ configured: './uploads', isWritable: writableNever })).toThrow(
      /STORAGE_LOCAL_PATH/,
    );
  });
});

describe('isStorageRootWritable', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-storage-root-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates a missing root and reports it writable', () => {
    const root = path.join(tmp, 'media');

    expect(isStorageRootWritable(root)).toBe(true);
    expect(fs.existsSync(root)).toBe(true);
  });

  it('reports an EXISTING but unwritable root as not writable (the #1065 case existsSync misses)', () => {
    // Running as root bypasses permission bits entirely, so the negative case is unprovable there.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;

    const root = path.join(tmp, 'locked');
    fs.mkdirSync(root);
    fs.chmodSync(root, 0o555);

    try {
      expect(isStorageRootWritable(root)).toBe(false);
    } finally {
      fs.chmodSync(root, 0o755);
    }
  });
});
