import * as path from 'path';
import { computeFeatureFlags } from './feature-flags';
import { computeSendPacingConfig } from '../modules/message/send-pacing.config';
import { resolveInflightBodyBudgetBytes } from './inflight-body-budget';
import { readWsRateLimitConfig } from '../modules/events/ws-rate-limit';

/**
 * Root of the host's persistent state. Relative on purpose: the image sets WORKDIR /app and mounts
 * the data volume at /app/data, so this resolves onto the volume without the config having to know
 * whether it runs in a container.
 *
 * Exposed as the `dataDir` key because PluginStorageService already reads it — the key never existed,
 * so `get('dataDir')` always fell through to its own literal while the plugin package dir defaulted
 * from an unrelated string. Deriving both from one value is what keeps a plugin's code and its
 * registry entry in the same tree.
 *
 * Deliberately NOT env-overridable: every other data path (DATABASE_NAME, MAIN_DATABASE_NAME,
 * SESSION_DATA_PATH, BAILEYS_AUTH_DIR, STORAGE_LOCAL_PATH) carries its own override and none of them
 * would follow a DATA_DIR knob, so such a knob would move part of the state while looking like it
 * moved all of it.
 */
export const DEFAULT_DATA_DIR = './data';

/** Where installed plugin packages live when PLUGINS_DIR is unset — the tree the registry is in. */
export const DEFAULT_PLUGINS_DIR = path.join(DEFAULT_DATA_DIR, 'plugins');

/**
 * The plugin package dir OpenWA ≤ 0.12.1 defaulted to. A host that ran on that default has working
 * plugin code sitting here, so the loader still scans it (and says so, loudly) when PLUGINS_DIR is
 * unset — see PluginLoaderService.onModuleInit.
 */
export const LEGACY_PLUGINS_DIR = './plugins';

/**
 * Shared parser for numeric env knobs whose 0 is a documented opt-out (unlimited / disabled).
 * `Number('')` is 0, so a blank or whitespace-only value — exactly what a compose `${KEY:-}`
 * forward renders — would otherwise pass every `Number.isFinite(x) && x >= 0` guard and land
 * silently on the opt-out sentinel (disabling a memory cap, a reaper, a retry backoff). Blank
 * means "unset": fall back to the default; 0 stays reserved for an explicit opt-out. The value
 * must be a plain decimal integer — the same rule env.validation.ts enforces — so the validated
 * and the parsed value always agree (`parseInt('1e6', 10)` would silently read 1).
 */
export function resolveNonNegativeIntEnv(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
  return Number(trimmed);
}

/**
 * The UI locale Chromium is pinned to. WhatsApp Web renders its chrome — including the new-account
 * onboarding modal the whatsapp-web.js adapter dismisses (#982) — in the browser's language, and that
 * detector matches visible English text. Without a pin the language is whatever the launched binary
 * defaults to, which differs between the amd64 (Chrome for Testing) and arm64 (Debian chromium) images
 * and between host installs.
 */
export const PINNED_BROWSER_LOCALE = 'en-US';

/**
 * Append the locale pin unless the operator already set one. Deliberately applied AFTER the
 * PUPPETEER_ARGS override rather than baked into the default string: that variable REPLACES the
 * defaults, so a deployment that customises args for an unrelated reason would otherwise silently
 * lose the pin and the onboarding detector with it. An explicit `--lang` always wins.
 *
 * Returns a NEW array — never mutates the input — because the resolved args object is shared by every
 * session, and pushing per-session flags onto a shared array leaked proxy settings across sessions
 * once already (#840).
 */
export function withPinnedBrowserLocale(args: string[]): string[] {
  return args.some(arg => arg.startsWith('--lang')) ? [...args] : [...args, `--lang=${PINNED_BROWSER_LOCALE}`];
}

export default () => ({
  port: parseInt(process.env.PORT || '2785', 10),

  // Root of the persistent state tree (see DEFAULT_DATA_DIR). Read by PluginStorageService for the
  // plugin registry and per-plugin storage; the other data paths keep their own env-specific keys.
  dataDir: DEFAULT_DATA_DIR,

  // HTTP server timeouts (Node http.Server). Pinned explicitly so they are operator-tunable and
  // observable at boot rather than left at Node's implicit defaults. requestTimeout defaults to
  // Node's 300s; keepAliveTimeout to 5s; headersTimeout to 65s (a second above keepAlive — Node
  // requires headers > keepAlive, and main.ts normalizes it anyway). Set any to 0 at your own risk;
  // env.validation rejects 0 so a bound is never silently disabled.
  http: {
    requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '300000', 10),
    headersTimeoutMs: parseInt(process.env.HEADERS_TIMEOUT_MS || '65000', 10),
    keepAliveTimeoutMs: parseInt(process.env.KEEPALIVE_TIMEOUT_MS || '5000', 10),
    // Aggregate cap on request-body bytes buffered across ALL connections (the pre-body-parser
    // budget middleware in main.ts). Defaults to 4 × the per-request BODY_SIZE_LIMIT so the two
    // scale together; explicit bytes override via INFLIGHT_BODY_BUDGET_BYTES.
    inflightBodyBudgetBytes: resolveInflightBodyBudgetBytes(
      process.env.INFLIGHT_BODY_BUDGET_BYTES,
      process.env.BODY_SIZE_LIMIT,
    ),
  },

  // Global message search. Opt-out via SEARCH_ENABLED=false. Provider defaults to 'auto' (the
  // built-in DB full-text provider — Postgres tsvector/GIN, SQLite FTS5); 'none' disables the
  // /search route + module at runtime while keeping the config namespace loaded.
  search: {
    enabled: process.env.SEARCH_ENABLED !== 'false',
    provider: process.env.SEARCH_PROVIDER || 'auto',
    limitMax: Number(process.env.SEARCH_LIMIT_MAX) || 100,
  },

  // Dashboard statistics. The /stats aggregates run GROUP BY scans over the whole messages
  // table (synchronously on the event loop with the default SQLite backend), so responses are
  // memoized in-process for this TTL to keep dashboard polling from re-running the scans on
  // every request. 0 disables the memo.
  stats: {
    cacheTtlMs: parseInt(process.env.STATS_CACHE_TTL_MS || '30000', 10),
  },

  // Runtime feature flags. Single source of truth: src/config/feature-flags.ts. Exposed here so the
  // full set is discoverable via ConfigService (`features.*`) instead of scattered process.env reads.
  features: computeFeatureFlags(),

  // Outbound send pacing. Its own object rather than a feature flag: every field needs clamping,
  // because a bad value here decides whether messages are refused. See message/send-pacing.config.ts.
  sendPacing: computeSendPacingConfig(),

  // Redis configuration
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    connectTimeoutMs: parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS || '5000', 10),
  },

  // Queue configuration
  queue: {
    enabled: process.env.QUEUE_ENABLED === 'true',
  },

  // Cache configuration
  cache: {
    enabled: process.env.CACHE_ENABLED === 'true',
  },

  // Main Database configuration (always SQLite for boot config)
  database: {
    type: 'sqlite' as const,
    // SQLite file for the auth/audit DB. Overridable (e.g. e2e points it at a temp file) so tests
    // never write api keys into the developer's ./data/main.sqlite.
    database: process.env.MAIN_DATABASE_NAME || './data/main.sqlite',
    // Schema management for the auth/audit DB. Default ON (zero-config first boot).
    // Set MAIN_DATABASE_SYNCHRONIZE=false to manage schema via the main-owned migrations
    // instead (migrationsRun then creates api_keys/audit_logs). When disabled, run the
    // main-connection migrations explicitly with `npm run migration:run:main` (or
    // `migration:run:main:prod` for the compiled image) — the plain `migration:run` only
    // manages the data connection.
    synchronize: process.env.MAIN_DATABASE_SYNCHRONIZE !== 'false',
    logging: process.env.DATABASE_LOGGING === 'true',
  },

  // Data Storage Database configuration (pluggable: SQLite, PostgreSQL, etc.)
  dataDatabase: {
    type: process.env.DATABASE_TYPE || 'sqlite',
    // SQLite path (used when type is sqlite)
    database: process.env.DATABASE_NAME || './data/openwa.sqlite',
    // Postgres database NAME (used when type is postgres). Resolved from the same
    // DATABASE_NAME env as the migration CLI (data-source.ts) so the runtime factory and
    // migrations never target different databases. Distinct sqlite-vs-pg defaults.
    name: process.env.DATABASE_NAME || 'openwa',
    // PostgreSQL schema (used when type is postgres). Default 'public' preserves the historical
    // behavior; set POSTGRES_SCHEMA to place OpenWA's tables + the TypeORM migration ledger in a
    // dedicated schema (e.g. a managed-Postgres project schema, or to isolate OpenWA from other
    // apps sharing the database). The schema must already exist — a missing one fails fast at
    // migration time rather than silently falling back to public. SQLite ignores this.
    schema: process.env.POSTGRES_SCHEMA || 'public',
    // PostgreSQL/MySQL connection (used when type is postgres/mysql)
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    username: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    synchronize: process.env.DATABASE_SYNCHRONIZE === 'true',
    logging: process.env.DATABASE_LOGGING === 'true',
    // Connection pooling (PostgreSQL)
    poolSize: parseInt(process.env.DATABASE_POOL_SIZE || '10', 10),
    // Pool/query timeouts (PostgreSQL). statement_timeout is server-side per query; idle/connection
    // are pool-side. Set any to 0 to disable. Applied to the runtime connection only (see app.module).
    statementTimeoutMs: parseInt(process.env.DATABASE_STATEMENT_TIMEOUT_MS || '30000', 10),
    idleTimeoutMs: parseInt(process.env.DATABASE_IDLE_TIMEOUT_MS || '30000', 10),
    connectionTimeoutMs: parseInt(process.env.DATABASE_CONNECTION_TIMEOUT_MS || '10000', 10),
    // SSL configuration
    ssl: process.env.DATABASE_SSL === 'true',
    sslRejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
  },

  // WhatsApp engine configuration
  engine: {
    type: process.env.ENGINE_TYPE || 'whatsapp-web.js',
    puppeteer: {
      headless: process.env.PUPPETEER_HEADLESS !== 'false',
      // Accept either delimiter: .env/compose use commas, the dashboard Infrastructure form
      // persists space-separated. Splitting on both keeps each flag a discrete argv token —
      // a single glued token like "--no-sandbox --disable-gpu" silently neuters --no-sandbox.
      args: withPinnedBrowserLocale(
        (process.env.PUPPETEER_ARGS || '--no-sandbox,--disable-setuid-sandbox,--disable-dev-shm-usage,--disable-gpu')
          .split(/[\s,]+/)
          .filter(Boolean),
      ),
      // Optional path to a system Chromium/Chrome binary. When unset, whatsapp-web.js
      // uses Puppeteer's bundled Chromium. Required on hosts where the bundled binary
      // is missing or incompatible (Alpine, ARM, custom base images).
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    },
    sessionDataPath: process.env.SESSION_DATA_PATH || './data/sessions',
    // Baileys engine (used when ENGINE_TYPE=baileys). Multi-file auth state base dir; each session
    // gets its own subdirectory. Read by the Baileys plugin from the opaque engine config blob.
    baileys: {
      authDir: process.env.BAILEYS_AUTH_DIR || './data/baileys',
    },
  },

  sessions: {
    // 0 = unlimited/backwards-compatible. Set to a positive integer to cap concurrently running or
    // initializing WhatsApp engines, which protects memory/Chromium-constrained deployments.
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT_SESSIONS || '0', 10),
  },

  // Webhook configuration
  webhook: {
    timeout: parseInt(process.env.WEBHOOK_TIMEOUT || '10000', 10),
    retryDelay: parseInt(process.env.WEBHOOK_RETRY_DELAY || '5000', 10),
    // Cap on how many matching webhooks are delivered CONCURRENTLY for one event. Without it, an event
    // matching N webhooks opens N outbound sockets at once (no per-event bound). Default 16.
    dispatchConcurrency: parseInt(process.env.WEBHOOK_DISPATCH_CONCURRENCY || '16', 10),
    // Bound parked inline deliveries as well as active sockets. Queue-full dispatches are recorded in
    // webhook_delivery_failures instead of retaining payload closures without limit.
    dispatchMaxQueued: parseInt(process.env.WEBHOOK_DISPATCH_MAX_QUEUED || '1000', 10),
    // Upper bound on the serialized webhook body after webhook:before hooks ran; oversize payloads
    // are recorded as undelivered instead of being sent/persisted. Default 1 MiB. Fail-safe like the
    // other byte caps: a non-numeric or non-positive value falls back to the default. 0 is NOT an
    // opt-out here — a 0-byte cap rejects every dispatch (a total webhook outage), and a NaN would
    // silently disable the cap (`payloadBytes > NaN` is always false). env.validation rejects
    // non-decimal / non-positive values at boot.
    maxPayloadBytes: (() => {
      const n = parseInt(process.env.WEBHOOK_MAX_PAYLOAD_BYTES ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : 1024 * 1024;
    })(),
    // Max webhooks registered per session. One inbound event fans out to every registered webhook
    // of the session, so an unbounded count multiplies per-event copies of the payload. Creating a
    // NEW webhook above the cap is rejected with 400; existing ones are grandfathered (never
    // deleted). Default 16; 0 disables the cap. Garbage falls back to the default.
    maxPerSession: (() => {
      const n = parseInt(process.env.WEBHOOK_MAX_PER_SESSION ?? '', 10);
      return Number.isFinite(n) && n >= 0 ? n : 16;
    })(),
    // Inline base64 media cap for webhook payloads (decoded bytes). A media blob larger than this
    // is replaced with the { omitted: true, sizeBytes } marker BEFORE the payload is cloned per
    // webhook / queued into Redis, so fan-out and failed-job retention never copy the blob. Media
    // at or under the cap stays inline (unchanged). Default 1 MiB; 0 = never inline media. Garbage
    // falls back to the default.
    mediaInlineMaxBytes: (() => {
      const n = parseInt(process.env.WEBHOOK_MEDIA_INLINE_MAX_BYTES ?? '', 10);
      return Number.isFinite(n) && n >= 0 ? n : 1024 * 1024;
    })(),
    // How long shutdown waits for in-flight direct deliveries to finish before abandoning them.
    // 0 = don't wait (explicit opt-out); blank/garbage falls back to the default — a NaN here would
    // silently remove the drain deadline downstream (Math.max(0, NaN) is NaN).
    shutdownDrainMs: resolveNonNegativeIntEnv(process.env.WEBHOOK_SHUTDOWN_DRAIN_MS, 5000),
  },

  // API configuration
  api: {
    rateLimit: {
      // Short burst protection: 10 requests per second
      shortTtl: parseInt(process.env.RATE_LIMIT_SHORT_TTL || '1000', 10),
      shortLimit: parseInt(process.env.RATE_LIMIT_SHORT_LIMIT || '10', 10),
      // Medium protection: 100 requests per minute
      mediumTtl: parseInt(process.env.RATE_LIMIT_MEDIUM_TTL || '60000', 10),
      mediumLimit: parseInt(process.env.RATE_LIMIT_MEDIUM_LIMIT || '100', 10),
      // Long protection: 1000 requests per hour
      longTtl: parseInt(process.env.RATE_LIMIT_LONG_TTL || '3600000', 10),
      longLimit: parseInt(process.env.RATE_LIMIT_LONG_LIMIT || '1000', 10),
    },
  },

  // WebSocket (/events Socket.IO) rate limits. The gateway sits outside the Nest enhancer
  // pipeline (global guards never run on WS frames), so EventsGateway enforces these
  // in-process. Single source of truth is readWsRateLimitConfig (with the same
  // missing/blank/non-positive/non-numeric → default fallback the MCP limiters use):
  // per-key frame token bucket (framePerSecond sustained + frameBurst capacity),
  // pre-auth per-IP handshake sliding window, and a per-key simultaneous-socket cap.
  websocket: readWsRateLimitConfig(),

  // Security configuration
  security: {
    // Comma-separated IPs/CIDRs of reverse proxies whose X-Forwarded-For header
    // may be trusted for client-IP resolution. Empty by default: X-Forwarded-For
    // is ignored and the direct socket address is used, preventing spoofing of
    // the API-key allowedIps whitelist.
    trustedProxies: (process.env.TRUSTED_PROXIES || '')
      .split(',')
      .map(proxy => proxy.trim())
      .filter(Boolean),
  },

  // Plugin platform configuration
  plugins: {
    // Where installed plugin packages live on disk. This MUST resolve to the same tree as the plugin
    // registry (<dataDir>/plugins/registry.json, see PluginStorageService): a plugin's code and its
    // registry entry — status, operator config, secrets, enabledByOperator — are two halves of one
    // install. While the two defaults were independent, an unset PLUGINS_DIR put the code under
    // ./plugins and the registry under ./data/plugins, so the loader scanned a directory that did not
    // exist and reported "Loaded 0 plugins" while the registry still listed every plugin as installed;
    // in Docker the install also landed in the ephemeral container layer instead of the /app/data
    // volume, destroying the code on the next recreate while its config and secrets survived.
    dir: process.env.PLUGINS_DIR || DEFAULT_PLUGINS_DIR,
    // Compatibility only: the pre-fix default, scanned as a fallback so a host that installed plugins
    // there keeps loading them. Null once PLUGINS_DIR is set — an operator who named the directory
    // has said where plugins live, and nothing may second-guess that.
    legacyDir: process.env.PLUGINS_DIR ? null : LEGACY_PLUGINS_DIR,
    // Remote catalog of installable plugins (JSON array; the OpenWA-plugins repo's plugins.json).
    // Fetched through the SSRF guard — add its host to SSRF_ALLOWED_HOSTS if it is not publicly resolvable.
    catalogUrl:
      process.env.PLUGIN_CATALOG_URL || 'https://raw.githubusercontent.com/rmyndharis/OpenWA-plugins/main/plugins.json',
    // Cap on a plugin .zip downloaded by install-from-URL (matches the 5 MB upload limit). Fail-safe:
    // a non-numeric or non-positive value (parseInt → NaN/0/-n) falls back to the default rather than
    // silently disabling the cap (a downstream `??` would not catch NaN).
    downloadMaxBytes: (() => {
      const n = parseInt(process.env.PLUGIN_DOWNLOAD_MAX_BYTES ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : 5 * 1024 * 1024;
    })(),
    // Host-side budget for ONE worker-initiated capability call (see PluginWorkerHost.withCapTimeout).
    // Same fail-safe parsing as downloadMaxBytes.
    capTimeoutMs: (() => {
      const n = parseInt(process.env.PLUGIN_CAP_TIMEOUT_MS ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : 30000;
    })(),
    // Per-plugin bound on ctx.storage writes. Same fail-safe parsing as downloadMaxBytes.
    storageMaxBytes: (() => {
      const n = parseInt(process.env.PLUGIN_STORAGE_MAX_BYTES ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : 50 * 1024 * 1024;
    })(),
  },

  // Integration Fabric ingress configuration
  ingress: {
    // Opt-in to load plugins whose ingress routes declare signature.scheme: 'none'. Such a route is a
    // fully-unauthenticated @Public() endpoint: once an instance is provisioned against it, anyone who can
    // reach the host can POST a forged payload that triggers outbound WhatsApp sends. Default off — only
    // set ALLOW_UNSIGNED_INGRESS=true for a provider that genuinely offers no HMAC, and front the route
    // with a network/reverse-proxy ACL. Refused in production by the boot guard unless explicitly set.
    allowUnsigned: process.env.ALLOW_UNSIGNED_INGRESS === 'true',
  },

  // Status/Stories store configuration
  status: {
    // Per-file cap on status media persisted to disk/S3 (default 10 MiB). A status whose media exceeds
    // this is stored omitted (mediaOmitted=true, omitReason='over_cap') rather than rejected outright.
    mediaMaxBytes: (() => {
      const n = parseInt(process.env.STATUS_MEDIA_MAX_BYTES ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : 10 * 1024 * 1024;
    })(),
    // How often the reconciliation sweep re-lists status media files to find ones no row references
    // (default 1h). Orphans only arise from a crash between the media write and its row update.
    orphanSweepIntervalMs: (() => {
      const n = parseInt(process.env.STATUS_ORPHAN_SWEEP_INTERVAL_MS ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : 60 * 60 * 1000;
    })(),
    // How long an unreferenced status media file must be observed by the sweep before it is deleted
    // (default 1h), so a file mid-ingest is never reaped. A non-positive/garbage value falls back.
    orphanGraceMs: (() => {
      const n = parseInt(process.env.STATUS_ORPHAN_GRACE_MS ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : 60 * 60 * 1000;
    })(),
  },

  // Chat-media archiving (opt-in): a copy of each message's media in the file store, addressable
  // after delivery. Independent of the inline base64 the message row already carries.
  chatMedia: {
    // Off by default: archiving doubles storage for media under the cap, since the inline copy stays.
    archiveEnabled: process.env.CHAT_MEDIA_ARCHIVE_ENABLED === 'true',
    // Per-file cap on archived chat media (default 25 MiB). Media above it is simply not archived —
    // the message row and its inline copy are unaffected.
    maxBytes: (() => {
      const n = parseInt(process.env.CHAT_MEDIA_ARCHIVE_MAX_BYTES ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : 25 * 1024 * 1024;
    })(),
    // How long an archived file is kept, in days. 0 (the default) means forever. Unlike statuses,
    // chat messages have no WhatsApp-side expiry, so retention is purely an operator policy.
    ttlDays: (() => {
      const n = parseInt(process.env.CHAT_MEDIA_ARCHIVE_TTL_DAYS ?? '', 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    })(),
    // Cadence of the reconciliation sweep that reaps chat-media files no row references (default 1h).
    orphanSweepIntervalMs: (() => {
      const n = parseInt(process.env.CHAT_MEDIA_ORPHAN_SWEEP_INTERVAL_MS ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : 60 * 60 * 1000;
    })(),
    // How long an unreferenced chat-media file must be observed by the sweep before deletion
    // (default 1h), so a file mid-write is never reaped.
    orphanGraceMs: (() => {
      const n = parseInt(process.env.CHAT_MEDIA_ORPHAN_GRACE_MS ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : 60 * 60 * 1000;
    })(),
  },

  // Session ownership across processes. A session's engine runs in exactly one process; these
  // record which, so a second process booting beside a live one does not disturb its sessions.
  session: {
    // Stable across restarts by design — a restarted process must recognise its own leftover rows
    // in order to reset them. Defaults to the hostname, which is the container or host boundary.
    nodeId: process.env.NODE_ID || '',
    // Where THIS node answers HTTP for its peers (e.g. http://10.0.0.5:2785). Written onto every
    // session this node claims, so a peer can forward a request to the engine's host. Empty (the
    // default) disables request forwarding entirely — the right setting for single-node
    // deployments, where the lookup would be pure overhead.
    nodeUrl: process.env.NODE_URL || '',
    // Ceiling for one forwarded request (default 60s): engine operations can legitimately take
    // tens of seconds (a send with typing simulation, a media fetch), but a peer must not hold a
    // caller forever when the owner hangs.
    proxyTimeoutMs: (() => {
      const n = parseInt(process.env.SESSION_PROXY_TIMEOUT_MS ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : 60_000;
    })(),
    // How long a claim is honoured without renewal (default 60s). This is the worst-case delay
    // before a peer may take over from a process that died without releasing.
    leaseTtlMs: (() => {
      const n = parseInt(process.env.SESSION_LEASE_TTL_MS ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : 60_000;
    })(),
    // Renewal cadence (default 20s). Comfortably under the TTL so a single missed tick — a slow
    // query, a brief database blip — never costs a live process its sessions.
    leaseHeartbeatMs: (() => {
      const n = parseInt(process.env.SESSION_LEASE_HEARTBEAT_MS ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : 20_000;
    })(),
    // Takeover sweep cadence (default 30s): how often a node looks for sessions whose holder's
    // lease has lapsed — a crashed peer, or this node's own previous identity after a container
    // recreate — and starts them here. Gated by the AUTO_START_SESSIONS feature flag.
    takeoverSweepMs: (() => {
      const n = parseInt(process.env.SESSION_TAKEOVER_SWEEP_MS ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : 30_000;
    })(),
  },

  // Autoreply rules
  automation: {
    // Max rules per session. Every inbound message is evaluated against every rule of its session,
    // so an unbounded count turns each message into unbounded work. Creating a NEW rule above the
    // cap is rejected with 400; existing ones are grandfathered. Default 32; 0 disables the cap.
    maxPerSession: (() => {
      const n = parseInt(process.env.AUTOMATION_MAX_PER_SESSION ?? '', 10);
      return Number.isFinite(n) && n >= 0 ? n : 32;
    })(),
  },

  // Server-side media conversion (opt-in): transcodes caller-supplied audio and video into the
  // shapes WhatsApp clients actually play, by running the ffmpeg binary. Nothing is converted
  // implicitly — only the explicit conversion endpoints use this.
  mediaConversion: {
    // Off by default: it spawns an external process per request, so an operator opts in knowingly.
    // Even when true the endpoints stay unavailable unless the binary is actually present, so
    // enabling it on a host without ffmpeg degrades to a clear 503 rather than a spawn error.
    enabled: process.env.MEDIA_CONVERSION_ENABLED === 'true',
    // Absolute path to the binary, for hosts that keep it outside PATH. Resolved via PATH by default.
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    // Wall-clock ceiling for one conversion (default 60s). A codec can spin on malformed input, and
    // this process is spawned on a request path, so the timeout kills it rather than tying up a slot.
    timeoutMs: (() => {
      const n = parseInt(process.env.MEDIA_CONVERSION_TIMEOUT_MS ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : 60_000;
    })(),
    // Cap on the CONVERTED bytes (default 50 MiB, matching the inbound media cap). Transcoding can
    // inflate as well as shrink, so the output needs its own ceiling and not just the input's.
    maxOutputBytes: (() => {
      const n = parseInt(process.env.MEDIA_CONVERSION_MAX_OUTPUT_BYTES ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : 50 * 1024 * 1024;
    })(),
    // At most this many ffmpeg processes at once (default 2). Each conversion spawns an external
    // process and holds its input in heap; without a bound, requests inside the rate-limit window
    // can stack processes for as long as each one runs. A short queue absorbs bursts; beyond it
    // the endpoint answers 503 rather than piling on.
    concurrency: (() => {
      const n = parseInt(process.env.MEDIA_CONVERSION_CONCURRENCY ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : 2;
    })(),
  },

  // Message-template rendering
  template: {
    // Cap on the FINAL rendered text of a send-template request (header+body+footer joined, after
    // caller-supplied variable substitution; default 64 KiB — also WhatsApp's own text-message
    // ceiling). Without it a small template plus a huge variable inflates the payload to the
    // engine/DB unboundedly. Over-cap renders are rejected (400), never silently truncated.
    renderMaxChars: (() => {
      const n = parseInt(process.env.TEMPLATE_RENDER_MAX_CHARS ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : 64 * 1024;
    })(),
  },

  // Storage configuration
  storage: {
    type: process.env.STORAGE_TYPE || 'local',
    localPath: process.env.STORAGE_LOCAL_PATH || './data/media',
    s3: {
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      endpoint: process.env.S3_ENDPOINT,
    },
  },
});
