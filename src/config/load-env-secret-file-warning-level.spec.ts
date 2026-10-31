import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return { ...actual, chmodSync: jest.fn(actual.chmodSync) };
});

/**
 * The first boot writes data/.env.generated through writeSecretFile, whose chmod failure on a filesystem
 * that cannot chmod is reported as a warning. That warning is written while the env loader runs, so it
 * must follow the LOG_LEVEL the environment sets, like the loader's own lines do.
 */
describe('first-run secret file warning under the configured log level', () => {
  let envBackup: NodeJS.ProcessEnv;
  let dir: string;
  let written: string[];

  beforeEach(() => {
    envBackup = { ...process.env };
    for (const key of ['NODE_ENV', 'LOG_LEVEL', 'LOG_FORMAT', 'NO_COLOR', 'FORCE_COLOR']) delete process.env[key];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-secretwarn-'));
    jest.spyOn(process, 'cwd').mockReturnValue(dir);
    written = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => void written.push(args.join(' ')));
    }
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in envBackup)) delete process.env[key];
    Object.assign(process.env, envBackup);
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Run the loader on a filesystem that refuses chmod; the pre-write call on the absent file reports ENOENT. */
  const runLoaderRefusingChmod = (): Array<{ level: string; message: string }> => {
    jest.resetModules();
    // The registry reset hands load-env and secret-file a fresh fs mock, so the refusal goes on that one.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const freshFs = require('fs') as typeof import('fs');
    const actual = jest.requireActual<typeof import('fs')>('fs');
    jest.mocked(freshFs.chmodSync).mockImplementation(target => {
      const code = actual.existsSync(target) ? 'EPERM' : 'ENOENT';
      throw Object.assign(new Error(`${code}: chmod refused`), { code });
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./load-env');
    expect(fs.existsSync(path.join(dir, 'data', '.env.generated'))).toBe(true);
    return written.map(line => JSON.parse(line) as { level: string; message: string });
  };

  it('writes no warning when the process env sets LOG_LEVEL=error', () => {
    process.env.NODE_ENV = 'production';
    process.env.LOG_LEVEL = 'error';

    const levels = runLoaderRefusingChmod().map(entry => entry.level);
    expect(levels.filter(level => level !== 'error')).toEqual([]);
  });

  it('writes the warning between the first-run lines when the level lets it through', () => {
    process.env.NODE_ENV = 'production';

    const messages = runLoaderRefusingChmod().map(entry => entry.message);
    const firstRun = messages.findIndex(message => message.startsWith('First run detected'));
    const chmod = messages.findIndex(message => message.startsWith('post-write chmod 0o600 failed'));
    const created = messages.findIndex(message => message.startsWith('Created default configuration'));
    expect(firstRun).toBeGreaterThanOrEqual(0);
    expect([firstRun, chmod, created]).toEqual([firstRun, firstRun + 1, firstRun + 2]);
  });
});
