import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadCliEnv } from './load-cli-env';

describe('loadCliEnv (migration CLI env precedence)', () => {
  let dir: string;
  const KEY = 'DATABASE_TYPE';
  let original: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-cli-env-'));
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    original = process.env[KEY];
    delete process.env[KEY];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it('reads data/.env.generated (the dashboard-written config) when the var is unset', () => {
    fs.writeFileSync(path.join(dir, 'data', '.env.generated'), 'DATABASE_TYPE=postgres\n');

    loadCliEnv(dir);

    // Without this load the CLI would default to sqlite and migrate the wrong database.
    expect(process.env[KEY]).toBe('postgres');
  });

  it('does not let .env.generated override an explicit process.env value (precedence holds)', () => {
    process.env[KEY] = 'postgres';
    fs.writeFileSync(path.join(dir, 'data', '.env.generated'), 'DATABASE_TYPE=sqlite\n');

    loadCliEnv(dir);

    expect(process.env[KEY]).toBe('postgres');
  });

  it('lets .env win over data/.env.generated (the middle layer), matching main.ts ordering', () => {
    // Guards against a future edit that reorders the two loads or flips override — .env must win.
    fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_TYPE=postgres\n');
    fs.writeFileSync(path.join(dir, 'data', '.env.generated'), 'DATABASE_TYPE=sqlite\n');

    loadCliEnv(dir);

    expect(process.env[KEY]).toBe('postgres');
  });

  // The app refuses to boot on a file it cannot read, and this loader reads the same two. A directory where a bind mount
  // found no file would otherwise send the migration to the default SQLite database while the deployment runs on another.
  it.each([
    ['.env', ['.env']],
    ['data/.env.generated', ['data', '.env.generated']],
  ])('fails, naming the file, when %s is a directory', (_name, parts) => {
    const file = path.join(dir, ...parts);
    fs.mkdirSync(file, { recursive: true });

    expect(() => loadCliEnv(dir)).toThrow(`Cannot read ${file}`);
  });

  // Root bypasses permission bits and Windows has no read bit to clear, so a refused read is unprovable on either. This
  // loader, unlike the app's, does not tighten the file first, so the refusal can be provoked here.
  const readCanBeDenied = process.getuid?.() !== 0 && process.platform !== 'win32';
  (readCanBeDenied ? it.each : it.skip.each)([
    ['.env', ['.env']],
    ['data/.env.generated', ['data', '.env.generated']],
  ])('fails, naming the file, when %s has no read permission', (_name, parts) => {
    const file = path.join(dir, ...parts);
    fs.writeFileSync(file, 'DATABASE_TYPE=postgres\n');
    fs.chmodSync(file, 0o000);

    try {
      expect(() => loadCliEnv(dir)).toThrow(`Cannot read ${file}`);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });

  // dotenv writes its "injected env" banner to stdout up to dotenv 17 and to stderr (console.error) from 18,
  // so every console channel is watched, not the one the installed version happens to use.
  it("loads both files without printing dotenv's banner", () => {
    delete process.env.DOTENV_QUIET;
    delete process.env.DOTENV_CONFIG_QUIET;
    fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_TYPE=postgres\n');
    fs.writeFileSync(path.join(dir, 'data', '.env.generated'), 'DATABASE_TYPE=sqlite\n');
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(channel =>
      jest.spyOn(console, channel).mockImplementation((...args: unknown[]) => void lines.push(args.join(' '))),
    );

    try {
      loadCliEnv(dir);
      expect(lines).not.toContainEqual(expect.stringContaining('injected env'));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
