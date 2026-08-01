import * as path from 'path';
import configuration, {
  DEFAULT_DATA_DIR,
  PINNED_BROWSER_LOCALE,
  resolveNonNegativeIntEnv,
  withPinnedBrowserLocale,
} from './configuration';

describe('configuration — main DB synchronize', () => {
  const orig = process.env.MAIN_DATABASE_SYNCHRONIZE;

  afterEach(() => {
    if (orig === undefined) delete process.env.MAIN_DATABASE_SYNCHRONIZE;
    else process.env.MAIN_DATABASE_SYNCHRONIZE = orig;
  });

  it('defaults main synchronize ON (zero-config first boot)', () => {
    delete process.env.MAIN_DATABASE_SYNCHRONIZE;
    expect(configuration().database.synchronize).toBe(true);
  });

  it('disables synchronize only when MAIN_DATABASE_SYNCHRONIZE="false"', () => {
    process.env.MAIN_DATABASE_SYNCHRONIZE = 'false';
    expect(configuration().database.synchronize).toBe(false);
    process.env.MAIN_DATABASE_SYNCHRONIZE = 'true';
    expect(configuration().database.synchronize).toBe(true);
  });
});

describe('configuration — Postgres database name', () => {
  const orig = process.env.DATABASE_NAME;
  afterEach(() => {
    if (orig === undefined) delete process.env.DATABASE_NAME;
    else process.env.DATABASE_NAME = orig;
  });

  it('resolves dataDatabase.name from DATABASE_NAME (matches the migration CLI), default openwa', () => {
    delete process.env.DATABASE_NAME;
    expect(configuration().dataDatabase.name).toBe('openwa');
    process.env.DATABASE_NAME = 'prod_db';
    expect(configuration().dataDatabase.name).toBe('prod_db');
  });
});

describe('configuration — Puppeteer args delimiter', () => {
  const orig = process.env.PUPPETEER_ARGS;
  afterEach(() => {
    if (orig === undefined) delete process.env.PUPPETEER_ARGS;
    else process.env.PUPPETEER_ARGS = orig;
  });

  // The dashboard Infrastructure form persists browser args space-separated, while .env/compose
  // use commas. The parser must accept both so each flag reaches Chromium as a discrete argv token
  // (a single glued token like "--no-sandbox --disable-gpu" silently neuters --no-sandbox).
  it('splits space-separated PUPPETEER_ARGS into discrete flags (dashboard-written form)', () => {
    process.env.PUPPETEER_ARGS = '--no-sandbox --disable-gpu';
    // The locale pin is appended after the split (see withPinnedBrowserLocale) — assert the split
    // itself, not the whole list, so this test keeps testing the delimiter and nothing else.
    expect(configuration().engine.puppeteer.args.slice(0, 2)).toEqual(['--no-sandbox', '--disable-gpu']);
  });

  it('still splits comma-separated PUPPETEER_ARGS (.env / docker-compose form)', () => {
    process.env.PUPPETEER_ARGS = '--no-sandbox,--disable-setuid-sandbox';
    expect(configuration().engine.puppeteer.args.slice(0, 2)).toEqual(['--no-sandbox', '--disable-setuid-sandbox']);
  });

  it('defaults to the Docker-relevant sandbox flag set when unset', () => {
    delete process.env.PUPPETEER_ARGS;
    expect(configuration().engine.puppeteer.args).toEqual([
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      `--lang=${PINNED_BROWSER_LOCALE}`,
    ]);
  });
});

describe('configuration — Postgres pool timeouts', () => {
  const keys = ['DATABASE_STATEMENT_TIMEOUT_MS', 'DATABASE_IDLE_TIMEOUT_MS', 'DATABASE_CONNECTION_TIMEOUT_MS'];
  const orig: Record<string, string | undefined> = {};
  beforeEach(() => keys.forEach(k => (orig[k] = process.env[k])));
  afterEach(() =>
    keys.forEach(k => {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }),
  );

  it('defaults to sane pool timeouts (30s statement, 30s idle, 10s connection)', () => {
    keys.forEach(k => delete process.env[k]);
    const cfg = configuration().dataDatabase;
    expect(cfg.statementTimeoutMs).toBe(30000);
    expect(cfg.idleTimeoutMs).toBe(30000);
    expect(cfg.connectionTimeoutMs).toBe(10000);
  });

  it('honors env overrides (incl. 0 to disable a timeout)', () => {
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = '0';
    process.env.DATABASE_IDLE_TIMEOUT_MS = '15000';
    process.env.DATABASE_CONNECTION_TIMEOUT_MS = '2000';
    const cfg = configuration().dataDatabase;
    expect(cfg.statementTimeoutMs).toBe(0);
    expect(cfg.idleTimeoutMs).toBe(15000);
    expect(cfg.connectionTimeoutMs).toBe(2000);
  });
});

describe('configuration — plugins directory default', () => {
  const orig = process.env.PLUGINS_DIR;
  afterEach(() => {
    if (orig === undefined) delete process.env.PLUGINS_DIR;
    else process.env.PLUGINS_DIR = orig;
  });

  // The package dir and the registry are two halves of one install: PluginStorageService writes
  // <dataDir>/plugins/registry.json, so a package dir defaulting anywhere else means the loader scans
  // an empty tree while the registry still lists every plugin as installed — and, in Docker, an
  // install lands in the container layer instead of on the data volume.
  it('defaults plugins.dir to <dataDir>/plugins so plugin code and the registry share one tree', () => {
    delete process.env.PLUGINS_DIR;
    const cfg = configuration();
    expect(cfg.dataDir).toBe(DEFAULT_DATA_DIR);
    expect(cfg.plugins.dir).toBe(path.join(cfg.dataDir, 'plugins'));
  });

  it('exposes the historical ./plugins default as legacyDir so an existing install keeps loading', () => {
    delete process.env.PLUGINS_DIR;
    expect(configuration().plugins.legacyDir).toBe('./plugins');
  });

  it('lets an explicit PLUGINS_DIR win, and drops the legacy fallback with it', () => {
    process.env.PLUGINS_DIR = '/srv/openwa-plugins';
    const cfg = configuration();
    expect(cfg.plugins.dir).toBe('/srv/openwa-plugins');
    // An operator who named the directory has said where plugins live; nothing may second-guess it.
    expect(cfg.plugins.legacyDir).toBeNull();
  });
});

describe('configuration — plugin download cap is fail-safe', () => {
  const orig = process.env.PLUGIN_DOWNLOAD_MAX_BYTES;
  afterEach(() => {
    if (orig === undefined) delete process.env.PLUGIN_DOWNLOAD_MAX_BYTES;
    else process.env.PLUGIN_DOWNLOAD_MAX_BYTES = orig;
  });

  it('uses the env value when it is a valid positive integer', () => {
    process.env.PLUGIN_DOWNLOAD_MAX_BYTES = '1048576';
    expect(configuration().plugins.downloadMaxBytes).toBe(1048576);
  });

  it('falls back to the 5 MB default when the env value is non-numeric or non-positive', () => {
    for (const bad of ['abc', 'unlimited', '0', '-1']) {
      process.env.PLUGIN_DOWNLOAD_MAX_BYTES = bad;
      expect(configuration().plugins.downloadMaxBytes).toBe(5 * 1024 * 1024);
    }
  });
});

describe('configuration — status media cap is fail-safe', () => {
  const orig = process.env.STATUS_MEDIA_MAX_BYTES;
  afterEach(() => {
    if (orig === undefined) delete process.env.STATUS_MEDIA_MAX_BYTES;
    else process.env.STATUS_MEDIA_MAX_BYTES = orig;
  });

  it('uses the env value when it is a valid positive integer', () => {
    process.env.STATUS_MEDIA_MAX_BYTES = '2097152';
    expect(configuration().status.mediaMaxBytes).toBe(2097152);
  });

  it('falls back to the 10 MiB default when unset, empty, non-numeric, or non-positive', () => {
    delete process.env.STATUS_MEDIA_MAX_BYTES;
    expect(configuration().status.mediaMaxBytes).toBe(10 * 1024 * 1024);
    // A non-positive value must NOT disable the per-file cap — it falls back to the default.
    for (const bad of ['', 'abc', '0', '-5']) {
      process.env.STATUS_MEDIA_MAX_BYTES = bad;
      expect(configuration().status.mediaMaxBytes).toBe(10 * 1024 * 1024);
    }
  });
});

describe('configuration — in-flight body budget', () => {
  const keys = ['INFLIGHT_BODY_BUDGET_BYTES', 'BODY_SIZE_LIMIT'];
  const orig: Record<string, string | undefined> = {};
  beforeEach(() => keys.forEach(k => (orig[k] = process.env[k])));
  afterEach(() =>
    keys.forEach(k => {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }),
  );

  it('defaults to 4 × the per-request body cap and scales with BODY_SIZE_LIMIT', () => {
    keys.forEach(k => delete process.env[k]);
    expect(configuration().http.inflightBodyBudgetBytes).toBe(100 * 1024 * 1024);
    process.env.BODY_SIZE_LIMIT = '5mb';
    expect(configuration().http.inflightBodyBudgetBytes).toBe(20 * 1024 * 1024);
  });

  it('honors an explicit INFLIGHT_BODY_BUDGET_BYTES override', () => {
    process.env.INFLIGHT_BODY_BUDGET_BYTES = '52428800';
    expect(configuration().http.inflightBodyBudgetBytes).toBe(52428800);
  });
});

describe('configuration — webhook fan-out knobs are fail-safe', () => {
  const keys = ['WEBHOOK_MAX_PER_SESSION', 'WEBHOOK_MEDIA_INLINE_MAX_BYTES'];
  const orig: Record<string, string | undefined> = {};
  beforeEach(() => keys.forEach(k => (orig[k] = process.env[k])));
  afterEach(() =>
    keys.forEach(k => {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }),
  );

  it('defaults: 16 webhooks per session, 1 MiB inline media', () => {
    keys.forEach(k => delete process.env[k]);
    expect(configuration().webhook.maxPerSession).toBe(16);
    expect(configuration().webhook.mediaInlineMaxBytes).toBe(1024 * 1024);
  });

  it('honors valid non-negative overrides (0 = cap disabled / never inline)', () => {
    process.env.WEBHOOK_MAX_PER_SESSION = '0';
    process.env.WEBHOOK_MEDIA_INLINE_MAX_BYTES = '0';
    expect(configuration().webhook.maxPerSession).toBe(0);
    expect(configuration().webhook.mediaInlineMaxBytes).toBe(0);
    process.env.WEBHOOK_MAX_PER_SESSION = '32';
    process.env.WEBHOOK_MEDIA_INLINE_MAX_BYTES = '262144';
    expect(configuration().webhook.maxPerSession).toBe(32);
    expect(configuration().webhook.mediaInlineMaxBytes).toBe(262144);
  });

  it('falls back to the defaults on garbage or negative values (never silently unlimited)', () => {
    for (const bad of ['', 'abc', '-1']) {
      process.env.WEBHOOK_MAX_PER_SESSION = bad;
      process.env.WEBHOOK_MEDIA_INLINE_MAX_BYTES = bad;
      expect(configuration().webhook.maxPerSession).toBe(16);
      expect(configuration().webhook.mediaInlineMaxBytes).toBe(1024 * 1024);
    }
  });
});

describe('configuration search namespace', () => {
  // Save/restore the SEARCH_* env vars so a CI .env that sets them cannot flake the default-value
  // assertions below (mirrors the mutate-and-restore pattern used for PLUGIN_DOWNLOAD_MAX_BYTES etc.).
  const keys = ['SEARCH_ENABLED', 'SEARCH_PROVIDER', 'SEARCH_LIMIT_MAX'];
  const orig: Record<string, string | undefined> = {};
  beforeEach(() => keys.forEach(k => (orig[k] = process.env[k])));
  afterEach(() =>
    keys.forEach(k => {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }),
  );

  it('exposes search defaults', () => {
    keys.forEach(k => delete process.env[k]);
    const cfg = configuration();
    expect(cfg.search).toEqual({ enabled: true, provider: 'auto', limitMax: 100 });
  });
});

describe('configuration stats namespace', () => {
  const orig = process.env.STATS_CACHE_TTL_MS;
  afterEach(() => {
    if (orig === undefined) delete process.env.STATS_CACHE_TTL_MS;
    else process.env.STATS_CACHE_TTL_MS = orig;
  });

  it('exposes stats memo defaults and parses STATS_CACHE_TTL_MS (0 disables the memo)', () => {
    delete process.env.STATS_CACHE_TTL_MS;
    expect(configuration().stats.cacheTtlMs).toBe(30000);
    process.env.STATS_CACHE_TTL_MS = '0';
    expect(configuration().stats.cacheTtlMs).toBe(0);
    process.env.STATS_CACHE_TTL_MS = '60000';
    expect(configuration().stats.cacheTtlMs).toBe(60000);
  });
});

describe('configuration — webhook payload cap is fail-safe', () => {
  const orig = process.env.WEBHOOK_MAX_PAYLOAD_BYTES;
  afterEach(() => {
    if (orig === undefined) delete process.env.WEBHOOK_MAX_PAYLOAD_BYTES;
    else process.env.WEBHOOK_MAX_PAYLOAD_BYTES = orig;
  });

  it('defaults to 1 MiB and honors a valid positive override', () => {
    delete process.env.WEBHOOK_MAX_PAYLOAD_BYTES;
    expect(configuration().webhook.maxPayloadBytes).toBe(1024 * 1024);
    process.env.WEBHOOK_MAX_PAYLOAD_BYTES = '2097152';
    expect(configuration().webhook.maxPayloadBytes).toBe(2097152);
  });

  it('falls back to the default on empty, garbage, zero, or negative values', () => {
    // 0 is NOT an opt-out here (a 0-byte cap rejects every dispatch — a total webhook outage),
    // and a NaN would silently disable the cap (`payloadBytes > NaN` is always false).
    for (const bad of ['', 'abc', '0', '-1']) {
      process.env.WEBHOOK_MAX_PAYLOAD_BYTES = bad;
      expect(configuration().webhook.maxPayloadBytes).toBe(1024 * 1024);
    }
  });
});

describe('configuration — webhook shutdown drain is fail-safe', () => {
  const orig = process.env.WEBHOOK_SHUTDOWN_DRAIN_MS;
  afterEach(() => {
    if (orig === undefined) delete process.env.WEBHOOK_SHUTDOWN_DRAIN_MS;
    else process.env.WEBHOOK_SHUTDOWN_DRAIN_MS = orig;
  });

  it('defaults to 5000 and honors a valid override, incl. an explicit 0 (no wait)', () => {
    delete process.env.WEBHOOK_SHUTDOWN_DRAIN_MS;
    expect(configuration().webhook.shutdownDrainMs).toBe(5000);
    process.env.WEBHOOK_SHUTDOWN_DRAIN_MS = '10000';
    expect(configuration().webhook.shutdownDrainMs).toBe(10000);
    process.env.WEBHOOK_SHUTDOWN_DRAIN_MS = '0';
    expect(configuration().webhook.shutdownDrainMs).toBe(0);
  });

  it('falls back to the default on blank or garbage (a NaN would remove the drain deadline)', () => {
    for (const bad of ['', '   ', 'abc', '1e4']) {
      process.env.WEBHOOK_SHUTDOWN_DRAIN_MS = bad;
      expect(configuration().webhook.shutdownDrainMs).toBe(5000);
    }
  });
});

describe('resolveNonNegativeIntEnv', () => {
  it('treats blank/whitespace as unset and falls back (never the 0 opt-out sentinel)', () => {
    // Number('') is 0, which would otherwise pass a finite && >= 0 guard and silently land on
    // the documented 0 = unlimited/disabled sentinel.
    expect(resolveNonNegativeIntEnv(undefined, 5000)).toBe(5000);
    expect(resolveNonNegativeIntEnv('', 5000)).toBe(5000);
    expect(resolveNonNegativeIntEnv('   ', 5000)).toBe(5000);
  });

  it('reserves 0 for an explicit opt-out and honors valid values', () => {
    expect(resolveNonNegativeIntEnv('0', 5000)).toBe(0);
    expect(resolveNonNegativeIntEnv('250', 5000)).toBe(250);
  });

  it('falls back on garbage and non-decimal spellings (matching the boot validator)', () => {
    for (const bad of ['abc', '-1', '1.5', '1e6', '0x100']) {
      expect(resolveNonNegativeIntEnv(bad, 5000)).toBe(5000);
    }
  });
});

// WhatsApp Web renders its chrome in the BROWSER's language, and the onboarding-modal detector (#982)
// matches visible English text. Pinning the locale is what makes that match deterministic across the
// amd64 (Chrome for Testing) and arm64 (Debian chromium) images and any host install.
describe('withPinnedBrowserLocale', () => {
  it('appends the pin when the args carry no --lang', () => {
    expect(withPinnedBrowserLocale(['--no-sandbox'])).toEqual(['--no-sandbox', `--lang=${PINNED_BROWSER_LOCALE}`]);
  });

  it('leaves an operator-supplied --lang alone (theirs wins, and it is not duplicated)', () => {
    expect(withPinnedBrowserLocale(['--no-sandbox', '--lang=de-DE'])).toEqual(['--no-sandbox', '--lang=de-DE']);
    // `--lang` with no value, and the `--lang foo` spelling, both count as operator-supplied.
    expect(withPinnedBrowserLocale(['--lang'])).toEqual(['--lang']);
  });

  it('never mutates the input array', () => {
    // The resolved puppeteer args object is shared by every session; mutating it leaked one session's
    // proxy flag into the others once already (#840).
    const original = ['--no-sandbox'];
    const result = withPinnedBrowserLocale(original);
    expect(original).toEqual(['--no-sandbox']);
    expect(result).not.toBe(original);
  });
});

describe('configuration — puppeteer locale pin', () => {
  const orig = process.env.PUPPETEER_ARGS;

  afterEach(() => {
    if (orig === undefined) delete process.env.PUPPETEER_ARGS;
    else process.env.PUPPETEER_ARGS = orig;
  });

  it('pins the locale on the default args', () => {
    delete process.env.PUPPETEER_ARGS;
    expect(configuration().engine.puppeteer.args).toContain(`--lang=${PINNED_BROWSER_LOCALE}`);
  });

  // PUPPETEER_ARGS REPLACES the defaults, so applying the pin only to the default string would let any
  // deployment that customises args for an unrelated reason silently lose the onboarding detector.
  it('still pins the locale when the operator overrides PUPPETEER_ARGS', () => {
    process.env.PUPPETEER_ARGS = '--no-sandbox,--disable-gpu';
    const args = configuration().engine.puppeteer.args;
    expect(args).toEqual(['--no-sandbox', '--disable-gpu', `--lang=${PINNED_BROWSER_LOCALE}`]);
  });

  it('respects an explicit --lang inside PUPPETEER_ARGS', () => {
    process.env.PUPPETEER_ARGS = '--no-sandbox --lang=id-ID';
    expect(configuration().engine.puppeteer.args).toEqual(['--no-sandbox', '--lang=id-ID']);
  });
});
