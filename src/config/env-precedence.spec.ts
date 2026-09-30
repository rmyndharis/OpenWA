import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { clearBlankEnv, BLANK_SHADOWED_ENV_KEYS, recordPinnedEnvKeys, isEnvPinned } from './env-precedence';
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

// #1082: the dashboard used to INFER an environment pin from "running value != saved value", which is
// also true right after a save that has not been restarted yet. This snapshot is the real signal.
describe('isEnvPinned — does a layer above data/.env.generated supply this key?', () => {
  it('counts a key present before the saved file is merged, and not one the file supplies', () => {
    // Mirrors load-env's order: the snapshot is taken after process.env and .env, before the file.
    const env: NodeJS.ProcessEnv = { ENGINE_TYPE: 'whatsapp-web.js' };
    recordPinnedEnvKeys(env);
    env.REDIS_ENABLED = 'true'; // supplied by data/.env.generated afterwards

    expect(isEnvPinned('ENGINE_TYPE')).toBe(true);
    expect(isEnvPinned('REDIS_ENABLED')).toBe(false);
  });

  // The load-bearing case: the bundled compose forwards `- ENGINE_TYPE=${ENGINE_TYPE:-}`, which renders
  // blank when the operator sets nothing. clearBlankEnv deletes it BEFORE the snapshot, so a stock stack
  // must not be told an environment variable is pinning anything.
  it('does not count a blank compose forward as a pin', () => {
    const env: NodeJS.ProcessEnv = { ENGINE_TYPE: '', REDIS_ENABLED: '   ' };
    clearBlankEnv(env, BLANK_SHADOWED_ENV_KEYS);
    recordPinnedEnvKeys(env);

    expect(isEnvPinned('ENGINE_TYPE')).toBe(false);
    expect(isEnvPinned('REDIS_ENABLED')).toBe(false);
  });

  it('counts a real value that merely repeats the default — the case BLANK_SHADOWED_ENV_KEYS cannot cover', () => {
    const env: NodeJS.ProcessEnv = { ENGINE_TYPE: 'whatsapp-web.js' };
    clearBlankEnv(env, BLANK_SHADOWED_ENV_KEYS);
    recordPinnedEnvKeys(env);

    expect(isEnvPinned('ENGINE_TYPE')).toBe(true);
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

  // Clearing a blank forward only lets data/.env.generated win when nothing ABOVE it supplies a
  // value. `.env` sits above it and is loaded at load-env.ts:60 — after clearBlankEnv has already
  // run at :50 — so a value shipped uncommented in `.env.example` survives `cp .env.example .env`
  // as a permanent pin that the clear list structurally cannot reach. An empty assignment pins just
  // as hard: dotenv treats `KEY=` as present, so `DATABASE_PASSWORD=` shadows a dashboard-provisioned
  // password and the next production boot refuses to start.
  it('ships none of them uncommented in .env.example', () => {
    const example = fs.readFileSync(path.join(__dirname, '../../.env.example'), 'utf8');
    const uncommented = example
      .split('\n')
      .map(line => /^([A-Z0-9_]+)=/.exec(line)?.[1])
      .filter((key): key is string => key !== undefined);
    expect(uncommented).toContain('NODE_ENV'); // the file really does ship some keys uncommented
    expect(uncommented.filter(key => blankForwards().includes(key))).toEqual([]);
  });
});

/**
 * The rule above binds only the keys compose forwards blank. `.env.example`'s own header promises
 * something wider — "every setting the dashboard owns is commented out" — and the dashboard owns
 * keys that have no blank forward at all (POSTGRES_BUILTIN, REDIS_BUILTIN, MINIO_BUILTIN). Those slipped
 * past the compose-derived check and shipped uncommented, pinning the matching Infrastructure control
 * for anyone who ran the documented `cp .env.example .env`.
 *
 * Derived from the appliers that write data/.env.generated, plus the controller's own queue write, so
 * a key added to a section is covered without anyone remembering this file exists.
 */
describe('every key the dashboard writes is commented out in .env.example', () => {
  const sectionsSource = ['config-sections.ts', 'infra-config.controller.ts']
    .map(file => fs.readFileSync(path.join(__dirname, '../modules/infra', file), 'utf8'))
    .join('\n');

  /** `updates.KEY = …` */
  const directlyAssigned = (): string[] => [...sectionsSource.matchAll(/updates\.([A-Z0-9_]+)\s*=/g)].map(m => m[1]);
  /** `setSecret(updates, 'KEY', …)` — an indirection the direct form cannot see. */
  const viaSecretHelper = (): string[] =>
    [...sectionsSource.matchAll(/setSecret\(\s*updates\s*,\s*'([A-Z0-9_]+)'/g)].map(m => m[1]);

  const dashboardOwned = (): string[] => [...new Set([...directlyAssigned(), ...viaSecretHelper()])].sort();

  // Guard both extractors independently. The direct form alone finds 28 keys and silently misses
  // every key routed through setSecret, so a single combined count would look healthy while the
  // secret keys went unchecked.
  it('extracts keys from both write forms', () => {
    expect(directlyAssigned()).toContain('DATABASE_SSL');
    expect(directlyAssigned()).toContain('QUEUE_ENABLED'); // written by the controller, not a section applier
    expect(viaSecretHelper()).toContain('REDIS_PASSWORD');
  });

  const assignedKeys = (text: string): string[] =>
    text
      .split('\n')
      .map(line => /^([A-Z0-9_]+)=/.exec(line)?.[1])
      .filter((key): key is string => key !== undefined);
  const uncommentedKeys = (file: string): string[] =>
    assignedKeys(fs.readFileSync(path.join(__dirname, '../..', file), 'utf8'));

  it('ships none of them uncommented in .env.example', () => {
    const uncommented = uncommentedKeys('.env.example');
    expect(uncommented).toContain('NODE_ENV'); // the file really does ship some keys uncommented
    expect(uncommented.filter(key => dashboardOwned().includes(key))).toEqual([]);
  });

  // docs/10 section 10.5 presents its .env block as an excerpt of .env.example, so operators copy it
  // the same way and it has to follow the same rule. A published pepper is no secret either.
  it('ships none of them uncommented in the docs/10 environment excerpt', () => {
    const docs = fs.readFileSync(path.join(__dirname, '../../docs/10-devops-infrastructure.md'), 'utf8');
    const section = docs.slice(docs.indexOf('## 10.5 Environment Configuration'));
    const uncommented = assignedKeys(/```bash\n([\s\S]*?)```/.exec(section)?.[1] ?? '');
    expect(uncommented).toContain('NODE_ENV'); // the block was found and does ship some keys uncommented
    expect(uncommented.filter(key => dashboardOwned().includes(key))).toEqual([]);
    expect(uncommented).not.toContain('API_KEY_PEPPER');
  });

  // The docs/08 and docs/03 env profiles are pasted into .env the same way.
  it.each([
    ['docs/08-development-guidelines.md', '### Environment Variables', '## 8.9', 2],
    ['docs/03-system-architecture.md', '### Configuration Examples', '### Choosing a Profile', 3],
  ])('ships none of them uncommented in the %s profiles', (file, from, to, blocks) => {
    const docs = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
    const start = docs.indexOf(from);
    const section = docs.slice(start, docs.indexOf(to, start));
    const bodies = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1]);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(bodies).toHaveLength(blocks); // the profiles were found
    const uncommented = bodies.flatMap(assignedKeys);
    expect(uncommented.filter(key => dashboardOwned().includes(key))).toEqual([]);
    expect(uncommented).not.toContain('API_KEY_PEPPER');
  });

  /**
   * `.env.minimal` is also copied to `.env` by the docs (docs/README.md), but its rule is NARROWER on
   * purpose: it describes itself as a development/personal config and deliberately pins the choices an
   * operator makes by hand there — DATABASE_TYPE, ENGINE_TYPE, the puppeteer flags. Those pins are the
   * file's reason to exist.
   *
   * The built-in datastore toggles are different: they are pure Dashboard > Infrastructure switches, so
   * pinning them makes the UI control move, save, report success and change nothing — the same trap the
   * .env.example rule exists for.
   */
  it('ships the built-in datastore toggles commented out in .env.minimal', () => {
    const toggles = ['POSTGRES_BUILTIN', 'REDIS_BUILTIN', 'MINIO_BUILTIN'];
    expect(toggles.every(t => dashboardOwned().includes(t))).toBe(true); // control: they ARE dashboard-owned

    // Non-vacuity control on the OTHER side. The assertion below is a `.filter(...).toEqual([])`,
    // which an empty parse satisfies just as well as a correct file — a renamed template, a parser
    // that stops matching, or a file that became all comments would all read as "no pins found" and
    // pass while binding nothing. Anchor on a key this template exists to pin.
    const uncommented = uncommentedKeys('.env.minimal');
    expect(uncommented.length).toBeGreaterThan(0);
    expect(uncommented).toContain('REDIS_ENABLED');

    expect(uncommented.filter(key => toggles.includes(key))).toEqual([]);
  });
});

/**
 * The inbound-media knobs must reach the container.
 *
 * `MEDIA_DOWNLOAD_ENABLED` turns off what env.validation.ts itself calls "the most expensive
 * behaviour the gateway has" — decrypting every inbound media blob and base64-inlining it into every
 * message row at up to 50 MiB apiece. Neither compose file forwarded it, nor the cap, the timeout or
 * the concurrency, so an operator running the bundled stack set the value in `.env`, saw no error and
 * no log line, and kept paying for the behaviour. The only remaining path was hand-editing
 * `data/.env.generated` inside the mounted volume, which `.env.example` does not mention for these
 * keys. The sibling MEDIA_CONVERSION_* family was forwarded all along.
 */
describe.each(['docker-compose.yml', 'docker-compose.dev.yml'])('%s forwards the inbound-media knobs', file => {
  const compose = (): string => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');

  const forwards = (key: string): boolean => new RegExp(`^\\s*-\\s*${key}=`, 'm').test(compose());

  // Guards the assertions below: a matcher that can never fire would pass them vacuously.
  it('detects a key that IS forwarded', () => {
    expect(forwards('MEDIA_CONVERSION_ENABLED')).toBe(true);
  });

  it.each([
    'MEDIA_DOWNLOAD_ENABLED',
    'MEDIA_DOWNLOAD_MAX_BYTES',
    'MEDIA_DOWNLOAD_TIMEOUT_MS',
    'INBOUND_MEDIA_CONCURRENCY',
    'INBOUND_MEDIA_GLOBAL_CONCURRENCY',
  ])('forwards %s', key => {
    expect(forwards(key)).toBe(true);
  });
});
