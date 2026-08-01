import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { clearBlankEnv, BLANK_SHADOWED_ENV_KEYS } from './env-precedence';
import { computeFeatureFlags } from './feature-flags';

describe('clearBlankEnv', () => {
  it('deletes a key whose value is empty or whitespace-only', () => {
    const env: NodeJS.ProcessEnv = { A: '', B: '   ', C: 'keep' };
    clearBlankEnv(env, ['A', 'B', 'C']);
    expect('A' in env).toBe(false);
    expect('B' in env).toBe(false);
    expect(env.C).toBe('keep');
  });

  it('leaves an unset key untouched and does not create it', () => {
    const env: NodeJS.ProcessEnv = {};
    clearBlankEnv(env, ['MISSING']);
    expect('MISSING' in env).toBe(false);
  });
});

describe('engine-selection env precedence (ENGINE_TYPE)', () => {
  // Mirrors main.ts: process.env > .env > data/.env.generated. A compose `- ENGINE_TYPE=${ENGINE_TYPE:-}`
  // line forwards a blank value when the operator sets nothing; that blank must be treated as unset so
  // the dashboard's .env.generated selection is honoured, while a real operator value still wins.
  const KEY = 'ENGINE_TYPE';
  let saved: string | undefined;
  let genDir: string;
  let genPath: string;

  beforeEach(() => {
    saved = process.env[KEY];
    genDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-env-'));
    genPath = path.join(genDir, '.env.generated');
    fs.writeFileSync(genPath, 'ENGINE_TYPE=baileys\n');
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
    fs.rmSync(genDir, { recursive: true, force: true });
  });

  it('lets .env.generated select the engine when the forwarded ENGINE_TYPE is blank', () => {
    process.env[KEY] = ''; // compose `${ENGINE_TYPE:-}` with nothing set on the host
    clearBlankEnv(process.env, [KEY]);
    dotenv.config({ path: genPath, override: false });
    expect(process.env[KEY]).toBe('baileys');
  });

  it('keeps a real operator ENGINE_TYPE and ignores the .env.generated default', () => {
    process.env[KEY] = 'whatsapp-web.js'; // real operator/host value forwarded by compose
    clearBlankEnv(process.env, [KEY]);
    dotenv.config({ path: genPath, override: false });
    expect(process.env[KEY]).toBe('whatsapp-web.js');
  });
});

describe('blank-shadowed env keys (compose ${VAR:-} forwards the dashboard manages)', () => {
  const withGenerated = (line: string, run: (genPath: string) => void): void => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-env-pw-'));
    try {
      const genPath = path.join(dir, '.env.generated');
      fs.writeFileSync(genPath, `${line}\n`);
      run(genPath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const KEY = 'DATABASE_PASSWORD';
  let saved: string | undefined;
  beforeEach(() => (saved = process.env[KEY]));
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('covers DATABASE_PASSWORD (its compose forward renders blank and the dashboard saves it)', () => {
    expect(BLANK_SHADOWED_ENV_KEYS).toContain('ENGINE_TYPE');
    expect(BLANK_SHADOWED_ENV_KEYS).toContain('DATABASE_PASSWORD');
  });

  it('covers every dashboard-switchable infra key so a blank compose forward lets .env.generated win (#488)', () => {
    // Database / storage / redis selection + their detail fields. With these blank-forwarded by
    // compose, a dashboard switch saved to .env.generated actually applies at runtime (like ENGINE_TYPE),
    // while a real host value still pins.
    for (const key of [
      'DATABASE_TYPE',
      'DATABASE_HOST',
      'DATABASE_PORT',
      'DATABASE_USERNAME',
      'DATABASE_NAME',
      'STORAGE_TYPE',
      'STORAGE_LOCAL_PATH',
      'S3_BUCKET',
      'S3_ENDPOINT',
      'S3_REGION',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      // legacy S3 names forwarded blank for backward compat — must also be cleared when blank
      'S3_ACCESS_KEY',
      'S3_SECRET_KEY',
      'REDIS_ENABLED',
      'REDIS_HOST',
      'REDIS_PORT',
      // Engine launch options the dashboard saves — compose blank-forwards these too, so a dashboard
      // edit isn't shadowed by a pinned container default; the app layer (configuration.ts) supplies
      // the sane default when nothing is set.
      'PUPPETEER_HEADLESS',
      'SESSION_DATA_PATH',
      'PUPPETEER_ARGS',
    ]) {
      expect(BLANK_SHADOWED_ENV_KEYS).toContain(key);
    }
  });

  it.each([
    ['DATABASE_TYPE', 'postgres'],
    ['STORAGE_TYPE', 's3'],
    ['REDIS_ENABLED', 'true'],
    ['PUPPETEER_HEADLESS', 'false'],
  ])('lets .env.generated supply %s when the forwarded value is blank, but a host value pins', (key, fileValue) => {
    const prev = process.env[key];
    try {
      withGenerated(`${key}=${fileValue}`, genPath => {
        // blank forward (operator set nothing) → cleared → file wins
        process.env[key] = '';
        clearBlankEnv(process.env, BLANK_SHADOWED_ENV_KEYS);
        dotenv.config({ path: genPath, override: false });
        expect(process.env[key]).toBe(fileValue);
      });
      // real host value → survives → pins (ignores the file)
      withGenerated(`${key}=${fileValue}`, genPath => {
        process.env[key] = 'host-pinned';
        clearBlankEnv(process.env, BLANK_SHADOWED_ENV_KEYS);
        dotenv.config({ path: genPath, override: false });
        expect(process.env[key]).toBe('host-pinned');
      });
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  // #981: compose gained the AUTO_START_SESSIONS forward in v0.12.0 but the key was never added to
  // BLANK_SHADOWED_ENV_KEYS, so the blank forward shadowed data/.env.generated and auto-start stayed
  // off with no error — sessions sat at `disconnected` with `engineLoaded:false`. Assert the FLAG,
  // not just the raw variable: that is the behaviour the operator loses.
  it('keeps auto-start enabled when the forward is blank and .env.generated turns it on (#981)', () => {
    const key = 'AUTO_START_SESSIONS';
    const prev = process.env[key];
    try {
      withGenerated(`${key}=true`, genPath => {
        process.env[key] = ''; // compose `${AUTO_START_SESSIONS:-}` with nothing set on the host
        clearBlankEnv(process.env, BLANK_SHADOWED_ENV_KEYS);
        dotenv.config({ path: genPath, override: false });
        expect(computeFeatureFlags(process.env).autoStartSessions).toBe(true);
      });
    } finally {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  });

  it('lets .env.generated supply the password when the forwarded DATABASE_PASSWORD is blank', () => {
    withGenerated('DATABASE_PASSWORD=s3cret', genPath => {
      process.env[KEY] = ''; // compose `${DATABASE_PASSWORD:-}` with nothing set on the host
      clearBlankEnv(process.env, BLANK_SHADOWED_ENV_KEYS);
      dotenv.config({ path: genPath, override: false });
      expect(process.env[KEY]).toBe('s3cret');
    });
  });

  it('keeps a real host DATABASE_PASSWORD and ignores the .env.generated value', () => {
    withGenerated('DATABASE_PASSWORD=from-file', genPath => {
      process.env[KEY] = 'from-host';
      clearBlankEnv(process.env, BLANK_SHADOWED_ENV_KEYS);
      dotenv.config({ path: genPath, override: false });
      expect(process.env[KEY]).toBe('from-host');
    });
  });
});

// The list above is only correct while it covers EVERY `- KEY=${KEY:-}` line in the bundled compose:
// a forward without a clear entry renders blank, and dotenv's override:false then refuses to let
// .env / data/.env.generated supply a value — the operator's setting is ignored with no error. Derive
// the expectation from the compose file rather than restating a list, so a forward added without its
// clear entry fails here instead of shipping inert (#981).
describe.each(['docker-compose.yml', 'docker-compose.dev.yml'])('every blank forward in %s is cleared', file => {
  const blankForwards = (): string[] => {
    const compose = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
    const found = new Set<string>();
    for (const line of compose.split('\n')) {
      const match = /^\s*-\s*([A-Z0-9_]+)=\$\{([A-Z0-9_]+):-\}\s*$/.exec(line);
      if (match && match[1] === match[2]) found.add(match[1]);
    }
    return [...found].sort();
  };

  // Guards the assertion below: a pattern that silently matches nothing would make it vacuously pass.
  it('parses the compose forwards', () => {
    expect(blankForwards()).toContain('ENGINE_TYPE');
  });

  it('has a BLANK_SHADOWED_ENV_KEYS entry for each one', () => {
    expect(blankForwards().filter(key => !BLANK_SHADOWED_ENV_KEYS.includes(key))).toEqual([]);
  });
});
