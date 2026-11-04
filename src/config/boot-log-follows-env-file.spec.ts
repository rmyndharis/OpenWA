import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The env loader's own boot lines are written with the log settings the env files configure.
 *
 * A bare-metal install keeps NODE_ENV, LOG_LEVEL and LOG_FORMAT in the project `.env` (the shipped
 * `.env.example` sets NODE_ENV=production there). Every later line then follows them: JSON in
 * production, nothing below the configured level. The loader's lines must too, or a JSON log
 * pipeline receives a text line at the top of every boot, and LOG_LEVEL=error still prints info.
 */
describe('env loader boot lines', () => {
  let envBackup: NodeJS.ProcessEnv;
  const tempDirs: string[] = [];
  let written: string[];

  const makeTempCwd = (files: Record<string, string>): void => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-bootlog-'));
    tempDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    jest.spyOn(process, 'cwd').mockReturnValue(dir);
  };

  const runLoader = (): void => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./load-env');
  };

  /** Each written line as its level, or the line itself when it is not JSON. */
  const levels = (): string[] =>
    written.map(line => {
      try {
        return (JSON.parse(line) as { level?: string }).level ?? 'unparsed';
      } catch {
        return `not JSON: ${line}`;
      }
    });

  const messages = (): string[] =>
    written.map(line => {
      try {
        return (JSON.parse(line) as { message?: string }).message ?? line;
      } catch {
        return line;
      }
    });

  beforeEach(() => {
    envBackup = { ...process.env };
    for (const key of ['NODE_ENV', 'LOG_LEVEL', 'LOG_FORMAT', 'NO_COLOR', 'FORCE_COLOR', 'DATABASE_SSL']) {
      delete process.env[key];
    }
    written = [];
    for (const method of ['log', 'warn', 'error'] as const) {
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(' '));
      });
    }
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envBackup)) delete process.env[key];
    }
    Object.assign(process.env, envBackup);
    jest.restoreAllMocks();
    jest.dontMock('../common/utils/secret-file');
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('follows the NODE_ENV and LOG_LEVEL set in the project .env', () => {
    makeTempCwd({
      '.env': 'NODE_ENV=production\nLOG_LEVEL=warn\n',
      'data/.env.generated': 'DATABASE_TYPE=sqlite\n',
    });

    runLoader();

    // Every line is JSON (production), and none sits below the configured warn level.
    expect(levels().filter(level => level !== 'warn' && level !== 'error')).toEqual([]);
  });

  it('writes no info line when the process env sets LOG_LEVEL=error, as the image does', () => {
    process.env.NODE_ENV = 'production';
    process.env.LOG_LEVEL = 'error';
    makeTempCwd({ 'data/.env.generated': 'DATABASE_TYPE=sqlite\n' });

    runLoader();

    expect(levels()).toEqual([]);
  });

  it('honours a LOG_LEVEL saved only in data/.env.generated', () => {
    process.env.NODE_ENV = 'production';
    makeTempCwd({ 'data/.env.generated': 'LOG_LEVEL=warn\n' });

    runLoader();

    expect(levels().filter(level => level !== 'warn' && level !== 'error')).toEqual([]);
  });

  it('keeps writing its lines at info when LOG_LEVEL is misspelt, leaving the refusal to validation', () => {
    process.env.NODE_ENV = 'production';
    makeTempCwd({ '.env': 'LOG_LEVEL=loud\n', 'data/.env.generated': 'DATABASE_TYPE=sqlite\n' });

    expect(() => runLoader()).not.toThrow();

    expect(levels()).toEqual(['info', 'info']);
    expect(messages()[0]).toContain('Loading .env from');
  });

  it('still writes the database TLS override warning under LOG_LEVEL=warn', () => {
    process.env.NODE_ENV = 'production';
    makeTempCwd({
      '.env': 'DATABASE_SSL=false\nLOG_LEVEL=warn\n',
      'data/.env.generated': 'DATABASE_SSL=true\n',
    });

    runLoader();

    expect(levels()).toEqual(['warn']);
    expect(messages()[0]).toContain('DATABASE_SSL=false from the environment or .env overrides DATABASE_SSL=true');
  });

  it('writes the lines that led up to a failed first-run write before the error propagates', () => {
    process.env.NODE_ENV = 'production';
    makeTempCwd({ '.env': 'REDIS_HOST=redis.internal\n' });
    jest.doMock('../common/utils/secret-file', () => ({
      writeSecretFile: () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
    }));

    expect(() => runLoader()).toThrow('EACCES');

    expect(levels()).toEqual(['info', 'info']);
    expect(messages()).toEqual([
      expect.stringContaining('Loading .env from'),
      'First run detected, creating default configuration...',
    ]);
  });
});
