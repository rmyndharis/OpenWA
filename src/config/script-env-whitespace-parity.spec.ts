import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { loadCliEnv } from '../database/load-cli-env';
import { BLANK_SHADOWED_ENV_KEYS } from './env-precedence';

// Each case starts bash, and a restore.sh run starts node a dozen times.
jest.setTimeout(60_000);

const repoRoot = path.resolve(__dirname, '../..');
const libEnv = path.join(repoRoot, 'scripts/lib-env.sh');
const restore = path.join(repoRoot, 'scripts/restore.sh');
const backup = path.join(repoRoot, 'scripts/backup.sh');
const OVERLAY = 'from-the-overlay';
const FALLBACK = 'script-default';
const PATH_ENV = process.env.PATH ?? '';
/** The caller's locale as the child inherits it, with none set; an operator's shell usually sets a UTF-8 one. */
const UNSET = 'unset';
const UTF8_LOCALE = spawnSync('locale', ['-a'], { encoding: 'utf8' })
  .stdout?.split('\n')
  .find(name => /^(C|en_US)\.UTF-?8$/i.test(name));
/** Where the host has no UTF-8 locale, only the first runs. */
const LOCALES = [UNSET, ...(UTF8_LOCALE ? [UTF8_LOCALE] : [])];

const scriptText = (name: string): string => fs.readFileSync(path.join(repoRoot, 'scripts', name), 'utf8');
const keysAfter = (text: string, calls: string): string[] =>
  [...text.matchAll(new RegExp(`\\b(?:${calls})\\s+([A-Z][A-Z0-9_]*)\\b`, 'g'))].map(match => match[1]);

/** Every setting the scripts read from the environment, found by the calls that read one. */
const KEYS = [
  ...new Set(
    ['lib-env.sh', 'backup.sh', 'restore.sh'].flatMap(name =>
      keysAfter(scriptText(name), 'openwa_resolve|openwa_env|archive_target'),
    ),
  ),
].sort();
/** The keys restore.sh takes a target for: a path from the archive's .env.generated must lie inside the data dir. */
const ARCHIVE_KEYS = keysAfter(scriptText('restore.sh'), 'archive_target').sort();

/** The archive member each of those keys' targets is restored from. */
const MEMBERS: Record<string, { name: string; kind: 'file' | 'dir' }> = {
  MAIN_DATABASE_NAME: { name: 'main.sqlite', kind: 'file' },
  DATABASE_NAME: { name: 'openwa.sqlite', kind: 'file' },
  SESSION_DATA_PATH: { name: 'sessions', kind: 'dir' },
  BAILEYS_AUTH_DIR: { name: 'baileys', kind: 'dir' },
  STORAGE_LOCAL_PATH: { name: 'media', kind: 'dir' },
  PLUGINS_DIR: { name: 'plugin-packages', kind: 'dir' },
  PLUGIN_STATE_DIR: { name: 'plugin-state', kind: 'dir' },
  BOOTSTRAP_KEY_FILE: { name: '.api-key', kind: 'file' },
};

const NBSP = String.fromCodePoint(0xa0);
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);
const BLANKS = [' ', '\t', '  \t ', NBSP, ` ${IDEOGRAPHIC_SPACE}\t`];
/** Not blank: the app keeps such a value as written, and so must the scripts. */
const WRITTEN = ['  x  ', 'a b', 'x '];

/** Every code point JavaScript's trim() takes, which is what clearBlankEnv drops. */
const JS_BLANKS: string[] = [];
for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
  const char = String.fromCodePoint(codePoint);
  if (char.trim() === '') JS_BLANKS.push(char);
}
/** The code points either side of those, and others a pattern could mistake for them: none is blank. */
const BESIDE = [
  ...new Set([
    ...JS_BLANKS.flatMap(char => [(char.codePointAt(0) ?? 0) - 1, (char.codePointAt(0) ?? 0) + 1]),
    0x85,
    0x180e,
    0x200b,
    0x2060,
    0xfffd,
  ]),
]
  .map(codePoint => String.fromCodePoint(codePoint))
  .filter(char => char.trim() !== '');

/** The value the app ends up with for `key` when the environment holds `value` and the files in `cwd` are loaded. */
function appValue(cwd: string, key: string, value: string): string | undefined {
  const saved = { ...process.env };
  try {
    for (const name of Object.keys(process.env)) delete process.env[name];
    process.env.PATH = saved.PATH;
    process.env[key] = value;
    loadCliEnv(cwd);
    return process.env[key];
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, saved);
  }
}

/** What openwa_resolve prints for `key`, once for each of `values` as its value in the environment. */
function scriptValues(cwd: string, key: string, values: string[], locale = UNSET): string[] {
  const run = spawnSync(
    'bash',
    [
      '-c',
      'lib="$1"; key="$2"; shift 2; . "$lib"; DATA_DIR=./data; ' +
        `for value in "$@"; do ( export "$key=$value"; openwa_resolve "$key" ${FALLBACK}; printf "\\0" ); done`,
      '_',
      libEnv,
      key,
      ...values,
    ],
    {
      cwd,
      env: { PATH: PATH_ENV, ...(locale === UNSET ? {} : { LC_ALL: locale }) },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  return run.stdout.split('\0').slice(0, -1);
}

/** The values for which the script and the app part ways, each with what they read. */
function mismatches(cwd: string, key: string, values: string[], locale = UNSET): string[] {
  const script = scriptValues(cwd, key, values, locale);
  return values.flatMap((value, i) => {
    // An empty value is the key's default: for the app (PLUGINS_DIR || default) and for a blank line of a file alike.
    const app = appValue(cwd, key, value) || FALLBACK;
    return script[i] === app
      ? []
      : [`${JSON.stringify(value)}: app ${JSON.stringify(app)}, script ${JSON.stringify(script[i])}`];
  });
}

/**
 * scripts/lib-env.sh is documented to resolve a setting EXACTLY like the app: the environment first, then ./.env, then
 * data/.env.generated. The app drops a blank value of a compose-forwarded key before it looks at the files
 * (clearBlankEnv in env-precedence.ts), so a lower layer supplies the key, and JavaScript's trim() decides what is
 * blank: an empty value, or one of nothing but whitespace, the Unicode blanks included. The scripts took only the
 * empty string for blank. A whitespace-only value therefore read as set in backup.sh and restore.sh and as unset in the
 * app: backup.sh archived a SQLite file the app had left behind, and restore.sh wrote where the app never reads, or
 * past the check that keeps a path from the archive's .env.generated inside the data directory.
 */
describe('scripts/lib-env.sh against the app for a blank value in the environment', () => {
  let dir: string;
  let bare: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-env-blank-'));
    bare = path.join(dir, 'bare');
    fs.mkdirSync(path.join(dir, 'data'));
    fs.mkdirSync(bare);
    fs.writeFileSync(path.join(dir, 'data', '.env.generated'), KEYS.map(key => `${key}=${OVERLAY}`).join('\n') + '\n');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('scans the scripts for the settings they read, and has an archive member for each target key', () => {
    // Guards the scans above: a pattern that found nothing would make every comparison below pass for no keys.
    expect(KEYS).toEqual(
      expect.arrayContaining(['DATABASE_TYPE', 'DATABASE_URL', 'PLUGINS_DIR', 'STORAGE_LOCAL_PATH']),
    );
    expect(KEYS.length).toBeGreaterThanOrEqual(18);
    expect(ARCHIVE_KEYS).toEqual(Object.keys(MEMBERS).sort());
  });

  it('reads as written exactly the settings the app does not clear', () => {
    const asWritten = KEYS.filter(key => scriptValues(dir, key, [' '])[0] === ' ');

    expect(asWritten).toEqual(KEYS.filter(key => !BLANK_SHADOWED_ENV_KEYS.includes(key)));
    expect(asWritten.length).toBeGreaterThan(0);
    expect(asWritten.length).toBeLessThan(KEYS.length);
  });

  it.each(KEYS)('%s reads as the app reads it in the environment, blank or not', key => {
    const cleared = BLANK_SHADOWED_ENV_KEYS.includes(key);
    // What the app does with the blank is the premise of every comparison: the file value when it clears the key.
    expect(appValue(dir, key, ' ')).toBe(cleared ? OVERLAY : ' ');
    // An empty value is in the list for every key: the app clears it for a compose-forwarded key, so the files supply
    // it, and keeps it for PLUGINS_DIR and DATABASE_URL, which then take their defaults, as the scripts must.
    const values = [...BLANKS, ...WRITTEN, ''];

    expect(mismatches(dir, key, values)).toEqual([]);
  });

  it.each(['PLUGINS_DIR', 'DATABASE_URL'])(
    '%s exported empty is set, and one absent from the environment reads the files',
    key => {
      // Only printenv's status tells the two apart; the value is empty in both.
      const resolve = (env: Record<string, string>): string =>
        spawnSync('bash', ['-c', `. "${libEnv}"; DATA_DIR=./data; openwa_resolve ${key} ${FALLBACK}`], {
          cwd: dir,
          env: { PATH: PATH_ENV, ...env },
          encoding: 'utf8',
          timeout: 60_000,
        }).stdout;

      expect(resolve({ [key]: '' })).toBe(FALLBACK);
      expect(resolve({})).toBe(OVERLAY);
    },
  );

  it.each(['DATABASE_NAME', 'PLUGINS_DIR'].flatMap(key => LOCALES.map(locale => [key, locale] as const)))(
    '%s reads every code point trim() takes, and the ones beside them, as the app does (LC_ALL %s)',
    (key, locale) => {
      // JavaScript's trim() takes the ASCII blanks, and the code points an ASCII-only test misses: no-break space,
      // U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and the byte-order mark.
      expect(JS_BLANKS.length).toBeGreaterThanOrEqual(25);
      // A command substitution drops trailing newlines, so a value that ends in one is compared only where it is blank.
      const values = [
        ...JS_BLANKS,
        JS_BLANKS.join(''),
        ...JS_BLANKS.flatMap(char => [` ${char}\t`, `x${char}`, `${char}x${char}`]),
        ...BESIDE,
        ...BESIDE.map(char => ` ${char} `),
      ].filter(value => !value.endsWith('\n') || (key !== 'PLUGINS_DIR' && value.trim() === ''));

      expect(mismatches(bare, key, values, locale)).toEqual([]);
    },
  );

  describe('where a blank value used to stop a path from the archive being held inside the data directory', () => {
    /** An archive that carries what `key` restores, and whose .env.generated names its target outside the data dir. */
    function archiveNaming(key: string, outside: string): string {
      const { name, kind } = MEMBERS[key];
      const stage = path.join(dir, `stage-${key}`);
      fs.mkdirSync(stage);
      if (kind === 'dir') {
        fs.mkdirSync(path.join(stage, name));
        fs.writeFileSync(path.join(stage, name, 'file'), 'x');
      } else {
        fs.writeFileSync(path.join(stage, name), 'x');
      }
      fs.writeFileSync(path.join(stage, '.env.generated'), `${key}=${path.join(outside, 'target')}\n`);
      const archive = path.join(dir, `${key}.tar.gz`);
      expect(spawnSync('tar', ['-czf', archive, '-C', stage, '.']).status).toBe(0);
      return archive;
    }

    // An exported empty value is what a compose forward renders, and the only one a variable of the script's own that
    // carries the key's name can hide behind; a value of blanks is the one the app drops as well. PLUGINS_DIR is not
    // cleared: exported empty it is set, so the archive's value is not the one the app reads (see below).
    it.each(
      ARCHIVE_KEYS.filter(key => BLANK_SHADOWED_ENV_KEYS.includes(key)).flatMap(key =>
        ['', ' '].map(value => [key, value] as const),
      ),
    )('refuses %s outside the data directory with the key exported as %j', (key, value) => {
      const outside = path.join(dir, 'outside');
      const target = path.join(dir, 'target');
      fs.mkdirSync(outside);
      fs.mkdirSync(target);

      const run = spawnSync('bash', [restore, archiveNaming(key, outside)], {
        cwd: target,
        env: { PATH: PATH_ENV, [key]: value },
        encoding: 'utf8',
        timeout: 60_000,
      });

      expect(run.stdout + run.stderr).toContain(
        `${key} from the archive's .env.generated is not inside the data directory`,
      );
      expect(run.status).toBe(1);
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(fs.readdirSync(target)).toEqual([]);
    });

    it('restores the plugin packages into the default directory when PLUGINS_DIR is exported empty', () => {
      const outside = path.join(dir, 'outside');
      const target = path.join(dir, 'target');
      fs.mkdirSync(outside);
      fs.mkdirSync(target);

      const run = spawnSync('bash', [restore, archiveNaming('PLUGINS_DIR', outside)], {
        cwd: target,
        env: { PATH: PATH_ENV, PLUGINS_DIR: '' },
        encoding: 'utf8',
        timeout: 60_000,
      });

      // The app keeps the empty value and takes <data dir>/plugins, not the directory the archive's file names.
      expect(run.status).toBe(0);
      expect(fs.readFileSync(path.join(target, 'data', 'plugins', 'file'), 'utf8')).toBe('x');
      expect(fs.readdirSync(outside)).toEqual([]);
    });
  });

  it('openwa_media_dir settles a blank STORAGE_LOCAL_PATH as it does one that is not set', () => {
    // A ./uploads left in ./.env is not where the app keeps media under a data directory that is not the working
    // directory's ./data, unless the environment names it: then the call is the caller's own.
    fs.writeFileSync(path.join(dir, '.env'), 'STORAGE_LOCAL_PATH=./uploads\n');
    const volume = path.join(dir, 'volume');
    fs.mkdirSync(volume);
    const mediaDir = (env: Record<string, string>) =>
      spawnSync('bash', ['-c', `. "${libEnv}"; DATA_DIR="${volume}"; openwa_media_dir`], {
        cwd: dir,
        env: { PATH: PATH_ENV, ...env },
        encoding: 'utf8',
        timeout: 60_000,
      });

    const unset = mediaDir({});
    expect(unset.stdout).toBe(path.join(volume, 'media'));
    expect(unset.stderr).toContain('Remove the line from ./.env or .env.generated.');
    for (const blank of BLANKS) {
      const run = mediaDir({ STORAGE_LOCAL_PATH: blank });

      expect({ blank, stdout: run.stdout, stderr: run.stderr }).toEqual({
        blank,
        stdout: unset.stdout,
        stderr: unset.stderr,
      });
    }
  });

  it.each([
    ["the archive's .env.generated", 'archive'],
    ['./.env', 'dotenv'],
  ])('restore.sh refuses a SQLite archive when %s chooses PostgreSQL and DATABASE_TYPE is blank', (_layer, where) => {
    const stage = path.join(dir, 'stage');
    fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, 'main.sqlite'), 'main');
    fs.writeFileSync(path.join(stage, 'openwa.sqlite'), 'data');
    const postgres = 'DATABASE_TYPE=postgres\nDATABASE_HOST=db.example.invalid\n';
    if (where === 'archive') fs.writeFileSync(path.join(stage, '.env.generated'), postgres);
    const archive = path.join(dir, 'archive.tar.gz');
    expect(spawnSync('tar', ['-czf', archive, '-C', stage, '.']).status).toBe(0);
    const target = path.join(dir, 'target');
    fs.mkdirSync(target);
    if (where === 'dotenv') fs.writeFileSync(path.join(target, '.env'), postgres);

    const run = spawnSync('bash', [restore, archive], {
      cwd: target,
      env: { PATH: PATH_ENV, DATABASE_TYPE: ' ' },
      encoding: 'utf8',
      timeout: 60_000,
    });

    // What the app reads once the same files are in place.
    const restored = path.join(dir, 'restored');
    fs.mkdirSync(path.join(restored, 'data'), { recursive: true });
    fs.writeFileSync(
      where === 'archive' ? path.join(restored, 'data', '.env.generated') : path.join(restored, '.env'),
      postgres,
    );
    expect(appValue(restored, 'DATABASE_TYPE', ' ')).toBe('postgres');

    expect(run.stdout + run.stderr).toContain('the archive holds a SQLite data store');
    expect(run.status).toBe(1);
    expect(fs.readdirSync(target).filter(name => name !== '.env')).toEqual([]);
  });

  it.each(['data/.env.generated', '.env'])(
    'backup.sh does not archive the SQLite file left from before the switch when %s chooses PostgreSQL',
    async layer => {
      const install = path.join(dir, 'install');
      fs.mkdirSync(path.join(install, 'data'), { recursive: true });
      for (const name of ['main', 'openwa']) {
        const db = new DataSource({ type: 'better-sqlite3', database: path.join(install, 'data', `${name}.sqlite`) });
        await db.initialize();
        await db.query('CREATE TABLE t (x TEXT)');
        await db.query('INSERT INTO t VALUES (?)', [name]);
        await db.destroy();
      }
      fs.writeFileSync(
        path.join(install, layer),
        'DATABASE_TYPE=postgres\nDATABASE_HOST=db.example.invalid\nDATABASE_USERNAME=openwa\nDATABASE_PASSWORD=x\n',
      );
      const out = path.join(dir, 'out');

      const run = spawnSync('bash', [backup], {
        cwd: install,
        env: { PATH: PATH_ENV, DATABASE_TYPE: ' ', BACKUP_DIR: out },
        encoding: 'utf8',
        timeout: 60_000,
      });

      expect(appValue(install, 'DATABASE_TYPE', ' ')).toBe('postgres');
      const archives = fs.existsSync(out) ? fs.readdirSync(out).filter(name => name.endsWith('.tar.gz')) : [];
      const members = archives.flatMap(name =>
        spawnSync('tar', ['-tzf', path.join(out, name)], { encoding: 'utf8' }).stdout.split('\n'),
      );
      // A run that dumps PostgreSQL, or fails for want of pg_dump or a server, is right; one that archives the stale
      // SQLite data store and exits 0 captured a database the app no longer reads.
      expect(members).not.toContain('./openwa.sqlite');
      expect(run.status === 0 ? members : ['./database.sql']).toContain('./database.sql');
    },
  );

  it('backup.sh archives the default plugin directory when PLUGINS_DIR is exported empty and ./.env names another', async () => {
    const install = path.join(dir, 'install');
    for (const [folder, id] of [
      ['data/plugins', 'default-plugin'],
      ['custom', 'custom-plugin'],
    ]) {
      fs.mkdirSync(path.join(install, folder, id), { recursive: true });
      fs.writeFileSync(path.join(install, folder, id, 'manifest.json'), '{}');
    }
    for (const name of ['main', 'openwa']) {
      const db = new DataSource({ type: 'better-sqlite3', database: path.join(install, 'data', `${name}.sqlite`) });
      await db.initialize();
      await db.query('CREATE TABLE t (x TEXT)');
      await db.destroy();
    }
    fs.writeFileSync(path.join(install, '.env'), 'PLUGINS_DIR=./custom\n');
    const members = (env: Record<string, string>, out: string): string[] => {
      const run = spawnSync('bash', [backup], {
        cwd: install,
        env: { PATH: PATH_ENV, BACKUP_DIR: path.join(dir, out), ...env },
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(run.status).toBe(0);
      const [archive] = fs.readdirSync(path.join(dir, out)).filter(name => name.endsWith('.tar.gz'));
      return spawnSync('tar', ['-tzf', path.join(dir, out, archive)], { encoding: 'utf8' }).stdout.split('\n');
    };

    // Not exported at all, the key is the file's; the control that makes the empty export's result mean something.
    expect(members({}, 'unset')).toContain('./plugin-packages/custom-plugin/manifest.json');
    // Exported empty, the app keeps the empty value and takes the default.
    const empty = members({ PLUGINS_DIR: '' }, 'empty');
    expect(empty).toContain('./plugin-packages/default-plugin/manifest.json');
    expect(empty).not.toContain('./plugin-packages/custom-plugin/manifest.json');
  });
});
