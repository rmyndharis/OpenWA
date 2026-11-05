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
  // require() (not dynamic import()) so the relative specifier doesn't trip TS2835 under
  // moduleResolution:nodenext; jest.resetModules() above still forces a fresh module evaluation.
  const runLoader = (): void => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./load-env');
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

  it('lets a dashboard-saved engine apply over the blank value a stock compose forwards', () => {
    process.env.ENGINE_TYPE = '';
    makeTempCwd({ 'data/.env.generated': 'ENGINE_TYPE=baileys\n' });

    runLoader();

    expect(process.env.ENGINE_TYPE).toBe('baileys');
    // Not pinned: the host supplied nothing, so the Infrastructure page offers the setting for edit.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect((require('./env-precedence') as typeof import('./env-precedence')).isEnvPinned('ENGINE_TYPE')).toBe(false);
  });

  it('loads REDIS_HOST from a .env file so it reaches the webhook worker connection', () => {
    delete process.env.REDIS_HOST;
    makeTempCwd({ '.env': 'REDIS_HOST=redis.internal\n', 'data/.env.generated': '' });

    runLoader();

    expect(process.env.REDIS_HOST).toBe('redis.internal');
    expect(workerConnectionOptions().host).toBe('redis.internal');
  });

  // dotenv reports a read failure in its result instead of throwing. A skipped read would boot on the saved
  // configuration and the defaults, with another database and a freshly seeded admin key, so a .env that exists but
  // cannot be read stops the boot.
  it('fails the load, naming the file, when .env is a directory', () => {
    const dir = makeTempCwd({ 'data/.env.generated': 'REDIS_HOST=redis.saved\n' });
    fs.mkdirSync(path.join(dir, '.env'));
    delete process.env.REDIS_HOST;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(runLoader).toThrow(`Cannot read ${path.join(dir, '.env')}`);
    expect(process.env.REDIS_HOST).toBeUndefined();
  });

  // The saved configuration is read by the same loader and fails the same way: a single-file bind mount of a host file
  // that does not exist leaves a directory at this path, and skipping it would boot on the defaults, with another database.
  it('fails the load, naming the file, when data/.env.generated is a directory', () => {
    const dir = makeTempCwd({});
    fs.mkdirSync(path.join(dir, 'data', '.env.generated'), { recursive: true });
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(runLoader).toThrow(`Cannot read ${path.join(dir, 'data', '.env.generated')}`);
  });

  // Root bypasses permission bits and Windows has no read bit to clear, so the refusal is unprovable on either.
  const readCanBeDenied = process.getuid?.() !== 0 && process.platform !== 'win32';
  (readCanBeDenied ? it : it.skip)('fails the load, naming the file, when .env has no read permission', () => {
    const dir = makeTempCwd({ '.env': 'REDIS_HOST=redis.internal\n', 'data/.env.generated': '' });
    const file = path.join(dir, '.env');
    fs.chmodSync(file, 0o000);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    delete process.env.REDIS_HOST;

    try {
      expect(runLoader).toThrow(file);
    } finally {
      fs.chmodSync(file, 0o600);
    }
    expect(process.env.REDIS_HOST).toBeUndefined();
  });

  it('lets a real process env value win over the .env file (precedence preserved)', () => {
    process.env.REDIS_HOST = 'host-from-process-env';
    makeTempCwd({
      '.env': 'REDIS_HOST=host-from-dotenv\n',
      'data/.env.generated': 'REDIS_HOST=host-from-generated\n',
    });

    runLoader();

    expect(process.env.REDIS_HOST).toBe('host-from-process-env');
    expect(workerConnectionOptions().host).toBe('host-from-process-env');
  });

  // dotenv prints an "injected env" line on every load unless told to be quiet: to stdout up to dotenv 17,
  // to stderr (console.error) from 18. It bypasses the logger, so in production it lands as plain text in
  // the JSON log stream. Every console channel is watched, so the guard does not depend on which one the
  // installed version writes to.
  it.each<[string, Record<string, string>]>([
    [
      'a saved configuration',
      { '.env': 'REDIS_HOST=redis.internal\n', 'data/.env.generated': 'QUEUE_ENABLED=false\n' },
    ],
    ['a first run', { '.env': 'REDIS_HOST=redis.internal\n' }],
  ])('keeps dotenv from printing its own load banner on %s', (_case, files) => {
    delete process.env.DOTENV_QUIET;
    delete process.env.DOTENV_CONFIG_QUIET;
    makeTempCwd(files);
    const lines: string[] = [];
    for (const channel of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(console, channel).mockImplementation((...args: unknown[]) => void lines.push(args.join(' ')));
    }

    runLoader();

    expect(lines).not.toContainEqual(expect.stringContaining('injected env'));
  });

  // The image runs with NODE_ENV=production, where the logger emits JSON. A raw console line from the
  // loader would land in that stream as plain text, with no level for an aggregator to filter on.
  it.each<[string, Record<string, string>]>([
    ['a saved configuration', { '.env': 'DATABASE_SSL=false\n', 'data/.env.generated': 'DATABASE_SSL=true\n' }],
    ['a first run', { '.env': 'REDIS_HOST=redis.internal\n' }],
  ])('writes its boot lines through the structured logger on %s', (_case, files) => {
    delete process.env.DATABASE_SSL;
    process.env.LOG_FORMAT = 'json';
    makeTempCwd(files);
    const lines: string[] = [];
    const capture = (line: unknown): void => void lines.push(String(line));
    jest.spyOn(console, 'log').mockImplementation(capture);
    jest.spyOn(console, 'warn').mockImplementation(capture);

    runLoader();

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const entry = JSON.parse(line) as { context?: string; level?: string };
      expect(entry.context).toBe('Bootstrap');
      expect(['info', 'warn']).toContain(entry.level);
    }
  });

  // Older .env templates shipped DATABASE_SSL=false, and compose forwards it, so it silently outranks
  // TLS turned on in the dashboard. The override stands, but the boot log names both values.
  it('warns when a pinned database TLS setting differs from the one saved in the dashboard', () => {
    delete process.env.DATABASE_SSL;
    process.env.DATABASE_SSL_REJECT_UNAUTHORIZED = 'true';
    makeTempCwd({
      '.env': 'DATABASE_SSL=false\n',
      'data/.env.generated': 'DATABASE_SSL=true\nDATABASE_SSL_REJECT_UNAUTHORIZED=false\n',
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    runLoader();

    expect(process.env.DATABASE_SSL).toBe('false');
    expect(warn.mock.calls.map(([line]) => line as string)).toEqual([
      expect.stringMatching(/DATABASE_SSL=false .*DATABASE_SSL=true /),
      expect.stringMatching(/DATABASE_SSL_REJECT_UNAUTHORIZED=true .*DATABASE_SSL_REJECT_UNAUTHORIZED=false /),
    ]);
  });

  it('stays quiet when the pinned TLS setting matches the saved one or nothing pins it', () => {
    process.env.DATABASE_SSL = 'true';
    delete process.env.DATABASE_SSL_REJECT_UNAUTHORIZED;
    makeTempCwd({ 'data/.env.generated': 'DATABASE_SSL=true\nDATABASE_SSL_REJECT_UNAUTHORIZED=false\n' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    runLoader();

    expect(process.env.DATABASE_SSL_REJECT_UNAUTHORIZED).toBe('false');
    expect(warn).not.toHaveBeenCalled();
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
