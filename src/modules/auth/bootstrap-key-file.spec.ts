import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { bootstrapKeyFilePath, readBootstrapKey, writeBootstrapKey, removeBootstrapKey } from './bootstrap-key-file';

const logger = { log: jest.fn(), warn: jest.fn() };

describe('bootstrap key file', () => {
  let dir: string;
  const original = process.env.BOOTSTRAP_KEY_FILE;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'owa-bootkey-'));
    process.env.BOOTSTRAP_KEY_FILE = join(dir, '.api-key');
    logger.log.mockClear();
    logger.warn.mockClear();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.BOOTSTRAP_KEY_FILE;
    else process.env.BOOTSTRAP_KEY_FILE = original;
    rmSync(dir, { recursive: true, force: true });
  });

  describe('bootstrapKeyFilePath', () => {
    it('honours BOOTSTRAP_KEY_FILE', () => {
      expect(bootstrapKeyFilePath()).toBe(join(dir, '.api-key'));
    });

    it('falls back to data/.api-key under the working directory', () => {
      delete process.env.BOOTSTRAP_KEY_FILE;

      expect(bootstrapKeyFilePath()).toBe(join(process.cwd(), 'data', '.api-key'));
    });

    it('re-reads the env on every call, so a redirect set after import still takes effect', () => {
      // This is the whole point: it used to be a module const evaluated at import from process.cwd(),
      // so an e2e setup that redirects it could not — and an e2e boot rewrote the developer's file.
      const moved = join(dir, 'moved.key');
      process.env.BOOTSTRAP_KEY_FILE = moved;

      expect(bootstrapKeyFilePath()).toBe(moved);
    });
  });

  describe('readBootstrapKey', () => {
    it('returns null when the file is absent', () => {
      expect(readBootstrapKey(logger)).toBeNull();
    });

    it('returns null for an empty or whitespace-only file rather than a blank key', () => {
      writeFileSync(join(dir, '.api-key'), '   \n');

      expect(readBootstrapKey(logger)).toBeNull();
    });

    it('returns the trimmed key', () => {
      writeFileSync(join(dir, '.api-key'), '  owa_k1_abc \n');

      expect(readBootstrapKey(logger)).toBe('owa_k1_abc');
    });
  });

  describe('writeBootstrapKey', () => {
    it('writes to the resolved path', () => {
      writeBootstrapKey('owa_k1_written');

      expect(readFileSync(join(dir, '.api-key'), 'utf-8')).toContain('owa_k1_written');
    });
  });

  describe('removeBootstrapKey', () => {
    it('removes the file and says why', () => {
      writeFileSync(join(dir, '.api-key'), 'owa_k1_abc');

      removeBootstrapKey('its key was revoked or deleted', logger);

      expect(existsSync(join(dir, '.api-key'))).toBe(false);
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('revoked or deleted'));
    });

    it('treats an already-absent file as success, not a failure to report', () => {
      removeBootstrapKey('gone anyway', logger);

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
});
