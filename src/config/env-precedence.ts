/**
 * Treat a blank (empty or whitespace-only) value for each given key as if the variable were unset,
 * by deleting it from `env`.
 *
 * Why: the bundled compose files forward an operator's engine choice with `- ENGINE_TYPE=${ENGINE_TYPE:-}`
 * so a real `.env`/host value reaches the container. When the operator sets nothing, that line renders
 * an *empty* value, which would still sit in `process.env` and block the lower-priority `.env` /
 * `data/.env.generated` layers (loaded with dotenv `override: false`) from supplying one — silently
 * pinning the default and ignoring the dashboard's selection. Clearing the blank lets the lower layers
 * provide the value, while a real (non-empty) value is preserved and keeps its top precedence.
 */
/**
 * Keys the bundled compose forwards with `- KEY=${KEY:-}`, which renders blank when the operator
 * sets nothing. A blank forward shadows `.env` / `data/.env.generated` (both loaded with dotenv
 * `override: false`), so each is cleared when blank — letting a dashboard switch (database, storage,
 * redis, engine) or a hand-edited `data/.env.generated` actually apply at runtime while a real host
 * value still pins.
 *
 * EVERY `${KEY:-}` forward in docker-compose.yml belongs here — being dashboard-managed is not a
 * further condition, because `data/.env.generated` is documented as hand-editable (see load-env.ts)
 * and `saveConfig` preserves keys it does not own. `env-precedence.spec.ts` derives the expected set
 * from the compose file and fails when the two drift.
 */
export const BLANK_SHADOWED_ENV_KEYS: string[] = [
  'ENGINE_TYPE',
  // Inbound-media knobs. Not dashboard-managed, but every blank compose forward must be cleared or
  // the empty value shadows .env / data/.env.generated — which is why the gate above requires an
  // entry for each one.
  'MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES',
  'MEDIA_DOWNLOAD_ENABLED',
  'MEDIA_DOWNLOAD_MAX_BYTES',
  'MEDIA_DOWNLOAD_TIMEOUT_MS',
  'INBOUND_MEDIA_CONCURRENCY',
  // Database selection + connection details (#488)
  'DATABASE_TYPE',
  // Main (auth/audit) DB backend + connection details — blank-forwarded by compose like DATABASE_*.
  'MAIN_DATABASE_TYPE',
  'MAIN_DATABASE_HOST',
  'MAIN_DATABASE_PORT',
  'MAIN_DATABASE_USERNAME',
  'MAIN_DATABASE_PASSWORD',
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_USERNAME',
  'DATABASE_NAME',
  'DATABASE_PASSWORD',
  // PostgreSQL schema (dashboard-managed + compose blank-forwarded, like the other DATABASE_* keys)
  'POSTGRES_SCHEMA',
  // Storage selection + S3 details (#488)
  'STORAGE_TYPE',
  // S3 strict mode + local path — blank-forwarded with the other storage keys.
  'STORAGE_STRICT',
  'STORAGE_LOCAL_PATH',
  'S3_BUCKET',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  // Legacy S3 credential names — compose forwards them blank for backward compat, so clear a blank
  // forward too (otherwise it could shadow a value in data/.env.generated).
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  // Chat-media archiving. Blank-forwarded by compose like the storage keys above, so an operator
  // who sets nothing must not have an empty string pin the feature off against data/.env.generated.
  'CHAT_MEDIA_ARCHIVE_ENABLED',
  'CHAT_MEDIA_ARCHIVE_OUTBOUND',
  'CHAT_MEDIA_ARCHIVE_MAX_BYTES',
  'CHAT_MEDIA_ARCHIVE_TTL_DAYS',
  'CHAT_MEDIA_ORPHAN_SWEEP_INTERVAL_MS',
  'CHAT_MEDIA_ORPHAN_GRACE_MS',
  // Send pacing. Blank-forwarded by compose like the chat-media keys, so an operator who sets
  // nothing must not have an empty string pin pacing off against .env / data/.env.generated.
  'SEND_PACING_ENABLED',
  'SEND_PACING_WARMUP_SCHEDULE',
  'SEND_PACING_COLD_DAILY_CAP',
  'SEND_PACING_BREAKER_THRESHOLD',
  'SEND_PACING_BREAKER_COOLDOWN_MS',
  // Server-side media conversion, same arrangement.
  'MEDIA_CONVERSION_ENABLED',
  'FFMPEG_PATH',
  'MEDIA_CONVERSION_TIMEOUT_MS',
  'MEDIA_CONVERSION_MAX_OUTPUT_BYTES',
  'MEDIA_CONVERSION_CONCURRENCY',
  // Session ownership / multi-node routing (docs/13). Blank-forwarded so the single-node default
  // stays untouched while .env / data/.env.generated can supply real values.
  'NODE_ID',
  'NODE_URL',
  'SESSION_LEASE_TTL_MS',
  'SESSION_LEASE_HEARTBEAT_MS',
  'SESSION_TAKEOVER_SWEEP_MS',
  'SESSION_PROXY_TIMEOUT_MS',
  // Plane role + restore/auth-store knobs — blank-forwarded with the multi-node keys above.
  'ROLE',
  'SESSION_RESTORE_CONCURRENCY',
  'BAILEYS_AUTH_STORE',
  // Autoreply rule cap, blank-forwarded like the knobs above so an operator who sets nothing does
  // not have an empty string shadow a value in .env / data/.env.generated.
  'AUTOMATION_MAX_PER_SESSION',
  // Behaviour flags with no dashboard route: before they were forwarded, a value set in .env simply
  // never reached the container. They are blank-forwarded like everything else here so the forward
  // itself cannot pin them off.
  'WEBHOOK_CONTACT_DETAILS',
  'BAILEYS_MARK_ONLINE_ON_CONNECT',
  'BAILEYS_SYNC_FULL_HISTORY',
  'BAILEYS_WA_VERSION',
  'ALLOW_UNSIGNED_INGRESS',
  'STORE_EPHEMERAL_MESSAGES',
  'RESOLVE_LID_TO_PHONE',
  'SIMULATE_TYPING',
  'MCP_ENABLED',
  'SEARCH_ENABLED',
  'SERVE_DASHBOARD',
  'CACHE_ENABLED',
  'DATABASE_LOGGING',
  'MAIN_DATABASE_SYNCHRONIZE',
  // Redis selection + connection details (#488)
  'REDIS_ENABLED',
  'REDIS_HOST',
  'REDIS_PORT',
  // Engine launch options the dashboard saves (data/.env.generated). Compose blank-forwards these so a
  // dashboard edit is not shadowed by a pinned container default; the app layer (configuration.ts)
  // supplies the sane default when nothing is set.
  'PUPPETEER_HEADLESS',
  'SESSION_DATA_PATH',
  'PUPPETEER_ARGS',
  // Rate-limit values are blank-forwarded by Compose so a host value can take precedence without an
  // empty forward masking the lower-priority loaded .env / data/.env.generated value.
  'RATE_LIMIT_SHORT_TTL',
  'RATE_LIMIT_SHORT_LIMIT',
  'RATE_LIMIT_MEDIUM_TTL',
  'RATE_LIMIT_MEDIUM_LIMIT',
  'RATE_LIMIT_LONG_TTL',
  'RATE_LIMIT_LONG_LIMIT',
  // Boot-time flags and limits an operator sets in .env / data/.env.generated. AUTO_START_SESSIONS
  // gained its compose forward in v0.12.0 without a clear entry here, so the blank forward shadowed
  // the file and auto-start silently stayed off — sessions sat at `disconnected` with no engine and
  // no error to go on (#981).
  'AUTO_START_SESSIONS',
  'BODY_SIZE_LIMIT',
  'API_MASTER_KEY',
  'TRUSTED_PROXIES',
  'CSP_UPGRADE_INSECURE_REQUESTS',
  // whatsapp-web.js launch knobs: the WhatsApp Web version pin, its remote HTML template, and the
  // first-boot init wait raised for slow hosts.
  'WWEBJS_WEB_VERSION',
  'WWEBJS_WEB_VERSION_REMOTE_PATH',
  'WWEBJS_AUTH_TIMEOUT_MS',
  // The remainder of the documented knob set, forwarded blank once the compose forwarding list was
  // completed (compose-parity.spec.ts now derives the required forwards from .env.example, so every
  // entry here exists because a `${KEY:-}` line renders blank when the operator sets nothing).
  'ALLOW_DEV_API_KEY',
  'API_KEY_PEPPER',
  'BOOTSTRAP_KEY_FILE',
  'ENABLE_SWAGGER',
  'VALIDATION_ERROR_DETAIL',
  'MCP_READONLY',
  'MCP_RATE_LIMIT_MAX',
  'MCP_RATE_LIMIT_WINDOW_MS',
  'MCP_IP_RATE_LIMIT_MAX',
  'MCP_IP_RATE_LIMIT_WINDOW_MS',
  'METRICS_TOKEN',
  'CORS_ORIGINS',
  'SSRF_ALLOWED_HOSTS',
  'SSRF_DNS_TIMEOUT_MS',
  'WEBHOOK_SSRF_REDIRECTS',
  'REQUEST_TIMEOUT_MS',
  'HEADERS_TIMEOUT_MS',
  'KEEPALIVE_TIMEOUT_MS',
  'INFLIGHT_BODY_BUDGET_BYTES',
  'WEBHOOK_SHUTDOWN_DRAIN_MS',
  'WEBHOOK_MEDIA_INLINE_MAX_BYTES',
  'WEBHOOK_MAX_PAYLOAD_BYTES',
  'WEBHOOK_MAX_PER_SESSION',
  'WEBHOOK_FAILURE_RETENTION_DAYS',
  'WEBHOOK_WORKER_CONCURRENCY',
  'INGRESS_INSTANCE_LIMIT',
  'INGRESS_INSTANCE_TTL',
  'INGRESS_IP_LIMIT',
  'INGRESS_MAX_ATTEMPTS',
  'INGRESS_RETRY_DELAY_MS',
  'INGRESS_DEDUP_RETENTION_DAYS',
  'INGRESS_RETENTION_DAYS',
  'INGRESS_TIMESTAMP_TOLERANCE_SEC',
  'INGRESS_RECONCILE_INTERVAL_MS',
  'INGRESS_RECONCILE_GRACE_MS',
  'INGRESS_RECONCILE_BATCH_SIZE',
  'INGRESS_RECONCILE_MAX_ATTEMPTS',
  'WEBHOOK_RECONCILE_INTERVAL_MS',
  'WEBHOOK_RECONCILE_GRACE_MS',
  'WEBHOOK_RECONCILE_BATCH_SIZE',
  'WEBHOOK_RECONCILE_MAX_ATTEMPTS',
  'WEBHOOK_OUTBOX_RETENTION_DAYS',
  'INGRESS_WORKER_CONCURRENCY',
  'WS_RATE_LIMIT_FRAME_PER_SECOND',
  'WS_RATE_LIMIT_FRAME_BURST',
  'WS_RATE_LIMIT_HANDSHAKE_MAX',
  'WS_RATE_LIMIT_HANDSHAKE_WINDOW_MS',
  'WS_MAX_SOCKETS_PER_KEY',
  'DATABASE_POOL_SIZE',
  'DATABASE_STATEMENT_TIMEOUT_MS',
  'DATABASE_IDLE_TIMEOUT_MS',
  'DATABASE_CONNECTION_TIMEOUT_MS',
  'MAIN_DATABASE_NAME',
  'REDIS_USERNAME',
  'REDIS_PASSWORD',
  'REDIS_CONNECT_TIMEOUT_MS',
  'MAX_CONCURRENT_SESSIONS',
  'BAILEYS_AUTH_DIR',
  'BAILEYS_BROWSER_NAME',
  'BAILEYS_LOG_LEVEL',
  'BAILEYS_MESSAGE_STORE_LIMIT',
  'BAILEYS_SESSION_STORE_MAX_ENTRIES',
  'WWEBJS_ONBOARDING_CONTINUE_LABELS',
  'SHUTDOWN_DELAY_MS',
  'SIMULATE_TYPING_MAX_MS',
  'LID_MAPPING_CACHE_MAX',
  'EXPORT_INLINE_MEDIA_BUDGET_BYTES',
  'CHAT_HISTORY_MEDIA_BUDGET_BYTES',
  'STATUS_MEDIA_MAX_BYTES',
  'STATUS_ORPHAN_SWEEP_INTERVAL_MS',
  'STATUS_ORPHAN_GRACE_MS',
  'STORAGE_LIST_MAX_FILES',
  'STORAGE_IMPORT_MAX_BYTES',
  'STORAGE_IMPORT_MAX_ENTRIES',
  'STORAGE_EXPORT_TTL_MS',
  'STORAGE_EXPORT_SWEEP_MAX_AGE_MS',
  'S3_REPROBE_INTERVAL_MS',
  'MESSAGE_REAPER_INTERVAL_MS',
  'MESSAGE_REAPER_GRACE_MS',
  'MESSAGE_REAPER_BATCH_SIZE',
  'PLUGIN_DOWNLOAD_MAX_BYTES',
  'PLUGIN_INSTALL_REQUIRE_PIN',
  'PLUGIN_CATALOG_URL',
  'PLUGIN_CAP_TIMEOUT_MS',
  'PLUGIN_STORAGE_MAX_BYTES',
  'AUDIT_RETENTION_DAYS',
  'BULK_MAX_CONCURRENT_BATCHES',
  'TEMPLATE_RENDER_MAX_CHARS',
  'STATS_CACHE_TTL_MS',
  'SEARCH_PROVIDER',
  'SEARCH_LIMIT_MAX',
  'LOG_FORMAT',
  'BASE_URL',
  'DASHBOARD_URL',
];

export function clearBlankEnv(env: NodeJS.ProcessEnv, keys: string[]): void {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value.trim() === '') {
      delete env[key];
    }
  }
}

/**
 * Keys that were already in `process.env` before load-env merged `.env` and `data/.env.generated`
 * into it — i.e. genuinely supplied by the host/orchestrator.
 *
 * Needed because after boot the two file layers are indistinguishable from a real host override:
 * both simply sit in `process.env`. Any check that asks "what will the next boot see for this key?"
 * must not read a file value back out of `process.env` and mistake it for an override — for the
 * save-config guard that would mean validating the config being REPLACED instead of the one being
 * written.
 */
let osEnvKeys: Set<string> | null = null;

/** Snapshot the host-supplied keys. Called by load-env after blank-clearing, before any dotenv load. */
export function recordOsEnvKeys(env: NodeJS.ProcessEnv = process.env): void {
  osEnvKeys = new Set(Object.keys(env));
}

/**
 * True when `key` came from the host rather than a loaded env file. With no snapshot taken (a unit
 * test that never boots), every key counts as host-supplied — the caller's own `process.env` is then
 * the only source there is.
 */
export function isOsProvidedEnv(key: string): boolean {
  return osEnvKeys === null || osEnvKeys.has(key);
}

/**
 * Keys already present when `data/.env.generated` is about to be merged — i.e. supplied by the host
 * OR by the project `.env`, both of which load with `override: false` and therefore win over the
 * dashboard-saved file for good.
 *
 * Distinct from `osEnvKeys` on purpose. That snapshot answers "may this value win over the file being
 * WRITTEN?" for the save-config guard, where only a host value counts. This one answers "can the
 * dashboard change this setting at all?", and there a project `.env` pins exactly as hard as an
 * orchestrator variable does.
 */
let pinnedEnvKeys: Set<string> | null = null;

/** Snapshot the shadowing layers. Called by load-env immediately before `data/.env.generated` loads. */
export function recordPinnedEnvKeys(env: NodeJS.ProcessEnv = process.env): void {
  pinnedEnvKeys = new Set(Object.keys(env));
}

/**
 * True when `key` is supplied by a layer above `data/.env.generated`, so saving it from the dashboard
 * cannot take effect until that layer is changed.
 *
 * Defaults to FALSE with no snapshot taken (a unit test that never boots), the opposite of
 * `isOsProvidedEnv`. Each default is the safe one for its caller: the save guard must assume an
 * override it cannot see, while this drives a user-facing warning that must never be invented.
 *
 * Note `clearBlankEnv` runs BEFORE the snapshot, so a blank compose forward (`- KEY=${KEY:-}` with
 * nothing set) is already gone and correctly does not count as a pin.
 */
export function isEnvPinned(key: string): boolean {
  return pinnedEnvKeys !== null && pinnedEnvKeys.has(key);
}
