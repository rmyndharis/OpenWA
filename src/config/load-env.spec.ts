import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { workerConnectionOptions } from '../modules/queue/redis-connection';

describe('loadEnvironment', () => {
  let envBackup: NodeJS.ProcessEnv;
  const tempDirs: string[] = [];

  // Create an isolated working directory, write the given files into it (paths relative to the dir),
  // and point process.cwd() at it. The loader reads `.env` / `data/.env.generated` from process.cwd(),
  // so this drives it without touching the real project tree.
  const makeTempCwd = (files: Record<string, string>): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-loadenv-'));
    tempDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    jest.spyOn(process, 'cwd').mockReturnValue(dir);
    return dir;
  };

  // The loader runs as a side effect on import; resetModules forces a fresh evaluation each call so a
  // test's mocked cwd/env is in effect when it runs (the spec never imports it statically, so it never
  // runs against the real project tree).
  const runLoader = async (): Promise<void> => {
    jest.resetModules();
    await import('./load-env');
  };

  beforeEach(() => {
    envBackup = { ...process.env };
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envBackup)) delete process.env[key];
    }
    Object.assign(process.env, envBackup);
    jest.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads REDIS_HOST from a .env file so it reaches the webhook worker connection', async () => {
    delete process.env.REDIS_HOST;
    makeTempCwd({ '.env': 'REDIS_HOST=redis.internal\n', 'data/.env.generated': '' });

    await runLoader();

    expect(process.env.REDIS_HOST).toBe('redis.internal');
    expect(workerConnectionOptions().host).toBe('redis.internal');
  });

  it('lets a real process env value win over the .env file (precedence preserved)', async () => {
    process.env.REDIS_HOST = 'host-from-process-env';
    makeTempCwd({
      '.env': 'REDIS_HOST=host-from-dotenv\n',
      'data/.env.generated': 'REDIS_HOST=host-from-generated\n',
    });

    await runLoader();

    expect(process.env.REDIS_HOST).toBe('host-from-process-env');
    expect(workerConnectionOptions().host).toBe('host-from-process-env');
  });
});

describe('main.ts bootstrap order', () => {
  // The webhook Worker's @Processor connection/concurrency are read at module-import time. main.ts must
  // import the env loader FIRST so .env / .env.generated are populated before the module graph (which
  // includes that decorator) is evaluated — otherwise the worker freezes a pre-dotenv localhost Redis.
  // ES imports are hoisted, so this is an ordering invariant that a future reorder could silently break.
  it('imports ./config/load-env as its very first import', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../main.ts'), 'utf8');
    const firstImport = source.split('\n').find(line => /^\s*import\b/.test(line));

    expect(firstImport).toContain('./config/load-env');
  });
});
