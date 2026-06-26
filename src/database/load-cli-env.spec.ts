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
});
