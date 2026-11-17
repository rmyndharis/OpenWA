import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generatedEnvPath } from './generated-env';
import { InfraConfigController } from './infra-config.controller';

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return { ...actual, writeFileSync: jest.fn(actual.writeFileSync) };
});

const actualFs = jest.requireActual<typeof import('fs')>('fs');

/**
 * A save that fails answers 200 with `saved: false` and a message the dashboard shows. The success answer takes care
 * not to disclose the host's filesystem layout (`envPath` is relative to the working directory, and the storage path
 * refusal names the submitted value only), so the failure answer must not put an absolute path back: the error text a
 * failed write carries names the file it was asked to open. The answer carries the overlay's relative path and the
 * error code instead, and the log keeps the whole error.
 */
describe('a save that fails', () => {
  let dir: string;
  let other: string;
  let controller: InfraConfigController;
  let logError: jest.SpyInstance;

  beforeEach(() => {
    dir = actualFs.mkdtempSync(path.join(os.tmpdir(), 'openwa-save-failure-'));
    other = actualFs.mkdtempSync(path.join(os.tmpdir(), 'openwa-save-target-'));
    actualFs.mkdirSync(path.join(dir, 'data'));
    jest.spyOn(process, 'cwd').mockReturnValue(dir);
    jest.mocked(fs.writeFileSync).mockImplementation(actualFs.writeFileSync);
    controller = new InfraConfigController(
      { getAvailableEngines: () => [{ id: 'baileys' }] } as never,
      {} as never,
      {} as never,
    );
    logError = jest.spyOn(controller['logger'], 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    actualFs.rmSync(dir, { recursive: true, force: true });
    actualFs.rmSync(other, { recursive: true, force: true });
  });

  const overlay = (): string => path.relative(dir, generatedEnvPath());

  /** The text Node gives a failed open, which names the path it was asked to open. */
  function refuseWrites(): Error {
    const refused = new Error('placeholder') as NodeJS.ErrnoException;
    jest.mocked(fs.writeFileSync).mockImplementation((target: unknown) => {
      refused.message = `EROFS: read-only file system, open '${String(target)}'`;
      refused.code = 'EROFS';
      throw refused;
    });
    return refused;
  }

  it('saves the same payload when the filesystem takes the write', () => {
    const result = controller.saveConfig({ engine: { headless: false } });

    expect(result.saved).toBe(true);
    expect(result.envPath).toBe(overlay());
    expect(actualFs.existsSync(path.join(dir, 'data', '.env.generated'))).toBe(true);
    expect(logError).not.toHaveBeenCalled();
  });

  it('names the overlay by its relative path and the error code, and logs the whole error', () => {
    const refused = refuseWrites();

    const result = controller.saveConfig({ engine: { headless: false } });

    expect(result).toEqual({
      message: `Failed to save configuration: ${overlay()} could not be written (EROFS). The server log has the cause.`,
      saved: false,
      envPath: '',
      profiles: [],
    });
    expect(result.message).not.toContain(dir);
    expect(logError).toHaveBeenCalledWith('Failed to save configuration', refused);
    expect(refused.message).toContain(dir);
  });

  it('does not name where a symlinked overlay leads', () => {
    const real = path.join(other, 'real.env');
    actualFs.writeFileSync(real, 'ENGINE_TYPE=baileys\n');
    actualFs.symlinkSync(real, path.join(dir, 'data', '.env.generated'));
    const refused = refuseWrites();

    const result = controller.saveConfig({ engine: { headless: false } });

    expect(result.saved).toBe(false);
    expect(result.message).not.toContain(other);
    expect(result.message).not.toContain(dir);
    expect(refused.message).toContain(other);
    expect(logError).toHaveBeenCalledWith('Failed to save configuration', refused);
  });

  it('keeps any other failure of the save out of the answer too, and does not claim a failed write', () => {
    const failing = new InfraConfigController(
      {
        getAvailableEngines: () => {
          throw new Error(`cannot read the engine list at ${dir}/engines.json`);
        },
      } as never,
      {} as never,
      {} as never,
    );
    const logged = jest.spyOn(failing['logger'], 'error').mockImplementation(() => undefined);

    const result = failing.saveConfig({ engine: { type: 'baileys' } });

    expect(result.saved).toBe(false);
    expect(result.message).toBe('Failed to save configuration. The server log has the cause.');
    expect(result.message).not.toContain(dir);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('says the same when the saved overlay cannot be read, before any write is tried', () => {
    actualFs.mkdirSync(path.join(dir, 'data', '.env.generated'));
    const written = jest.mocked(fs.writeFileSync);
    written.mockClear();

    const result = controller.saveConfig({ engine: { headless: false } });

    expect(result).toEqual({
      message: 'Failed to save configuration. The server log has the cause.',
      saved: false,
      envPath: '',
      profiles: [],
    });
    expect(written).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
