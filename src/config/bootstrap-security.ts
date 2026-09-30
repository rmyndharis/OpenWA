export interface CorsPolicy {
  /** Explicit origin allowlist (empty when none / wildcard blocked). */
  origins: string[];
  /** Whether any origin is allowed (wildcard) — never true in production. */
  allowAnyOrigin: boolean;
  /** CORS credentials are only allowed with an explicit allowlist (never with a wildcard). */
  credentials: boolean;
}

/**
 * Resolves the effective CORS policy from CORS_ORIGINS + NODE_ENV.
 * - Dev: wildcard allowed (no credentials with wildcard — spec-compliant).
 * - Prod: a wildcard origin is REFUSED (collapses to same-origin only) so a
 *   misconfigured deployment cannot reflect arbitrary origins with credentials.
 */
export function resolveCorsPolicy(corsOriginsEnv?: string, nodeEnv?: string): CorsPolicy {
  const origins = corsOriginsEnv
    ?.split(',')
    .map(o => o.trim())
    .filter(Boolean) ?? ['*'];
  const hasWildcard = origins.includes('*');

  // In production a wildcard origin is refused: collapse to same-origin only.
  if (hasWildcard && nodeEnv === 'production') {
    return { origins: [], allowAnyOrigin: false, credentials: false };
  }

  return {
    origins,
    allowAnyOrigin: hasWildcard,
    // Credentials are only safe with an explicit allowlist, never with a wildcard.
    credentials: !hasWildcard,
  };
}

/**
 * Whether to serve the Swagger UI (/api/docs). An explicit ENABLE_SWAGGER wins ('true'/'false').
 * When unset, it defaults ON outside production but OFF in production — the public API schema is
 * reconnaissance surface, so production must opt in with ENABLE_SWAGGER=true.
 */
export function isSwaggerEnabled(enableSwaggerEnv?: string, nodeEnv?: string): boolean {
  if (enableSwaggerEnv === 'true') return true;
  if (enableSwaggerEnv === 'false') return false;
  return nodeEnv !== 'production';
}

/**
 * Whether the global ValidationPipe should EXPOSE field-level validation error messages. Hidden by
 * default in production (a 400 there returns a generic message so the DTO shape isn't reflected back)
 * and shown outside production. `VALIDATION_ERROR_DETAIL=true` forces detail on — useful for debugging
 * an SDK/integration against a production instance without flipping NODE_ENV — and `=false` forces it
 * off everywhere. Mirrors isSwaggerEnabled's exact-string, production-default-off contract.
 */
export function isValidationErrorDetailEnabled(validationDetailEnv?: string, nodeEnv?: string): boolean {
  if (validationDetailEnv === 'true') return true;
  if (validationDetailEnv === 'false') return false;
  return nodeEnv !== 'production';
}

/**
 * Whether to emit the CSP `upgrade-insecure-requests` directive (browsers auto-upgrade HTTP→HTTPS).
 * An explicit CSP_UPGRADE_INSECURE_REQUESTS wins ('true'/'false'). When unset it keeps the legacy
 * behaviour — ON in production only (the secure default for Internet-facing TLS deployments), OFF
 * elsewhere. Set CSP_UPGRADE_INSECURE_REQUESTS=false for an HTTP-only deployment on a trusted private
 * network, where the upgrade would otherwise force the dashboard to https and make it unreachable. (#611)
 */
export function isUpgradeInsecureRequestsEnabled(cspEnv?: string, nodeEnv?: string): boolean {
  if (cspEnv === 'true') return true;
  if (cspEnv === 'false') return false;
  return nodeEnv === 'production';
}

/**
 * Whether a boot is likely walking into the #731 blank-dashboard trap: production serves the bundled
 * UI with `upgrade-insecure-requests` on, so a browser reaching it over plain HTTP silently upgrades
 * the UI's own script fetches to https:// and renders a blank page. The server never sees the failed
 * request (it dies in the browser), so a boot warning is the only pointer we can give.
 *
 * This cannot distinguish direct-HTTP (broken) from behind-a-TLS-proxy (correct) — Express `trust
 * proxy` is off, so at boot there is no signal either way. It deliberately fires for both; the
 * warning text tells a proxied operator to ignore it.
 */
export function isDashboardCspUpgradeTrapLikely(env: {
  nodeEnv?: string;
  cspEnv?: string;
  dashboardServed: boolean;
}): boolean {
  return env.dashboardServed && isUpgradeInsecureRequestsEnabled(env.cspEnv, env.nodeEnv);
}

/**
 * Request body-size cap (DoS hardening). Default is media-aware (base64 sends ride in the JSON body).
 * A value the body-size parser can't understand (e.g. 'unlimited', 'none', a typo) resolves to a null
 * limit downstream, which SILENTLY DISABLES the cap — so an unparseable value falls back to the default
 * instead. Accepts a positive number with an optional bytes unit (b/kb/mb/gb/tb/pb).
 */
const BODY_LIMIT_PATTERN = /^\d+(\.\d+)?\s?(b|kb|mb|gb|tb|pb)?$/i;
export function resolveBodyLimit(bodySizeEnv?: string): string {
  const trimmed = bodySizeEnv?.trim();
  return trimmed && BODY_LIMIT_PATTERN.test(trimmed) ? trimmed : '25mb';
}

/**
 * Minimum length for an explicit API_MASTER_KEY in production. A static master key is the seed of an
 * ADMIN credential, so below this it is brute-forceable however unique it looks. The first-boot
 * generator emits 71 chars (`owa_k1_` + 32 bytes hex), so a generated key always passes.
 */
const MIN_PROD_MASTER_KEY_LENGTH = 32;

/** Known weak/default/placeholder secret values that must never reach production. */
const FORBIDDEN_PROD_SECRETS = new Set([
  'openwa',
  'minioadmin',
  'your-secure-password',
  'dev-master-key',
  'dev-admin-key',
  'changeme',
  'change-me',
  'password',
  'secret',
  'admin',
  '123456',
  'qwerty',
  'root',
  'test',
  'demo',
]);

/**
 * Whether to warn that API_KEY_PEPPER is unset in production. Without a pepper, stored API-key hashes
 * fall back to plain SHA-256 (still functional). Advisory only — enabling a pepper re-hashes keys and
 * invalidates existing ones (see api-key-hash.ts), so it stays opt-in and must never be enforced.
 */
export function isApiKeyPepperMissingInProduction(nodeEnv?: string, apiKeyPepper?: string): boolean {
  return nodeEnv === 'production' && !apiKeyPepper?.trim();
}

/**
 * Whether to warn that the main (auth/audit) DB schema is also managed by synchronize in production.
 * After the migrations-main chain, synchronize alters api_keys/audit_logs to this release's entities
 * without recording those changes in the migration ledger. Advisory only: the explicit opt-in keeps working.
 */
export function isMainDbSynchronizeInProduction(nodeEnv?: string, mainDbSynchronize?: string): boolean {
  return nodeEnv === 'production' && mainDbSynchronize === 'true';
}

/**
 * Whether NODE_ENV is unset or blank. That is the deliberate local-dev default, but it silently
 * degrades four controls to their dev posture: the default-secret assert is skipped, a wildcard
 * CORS origin is allowed, Swagger UI is served, and validation error detail is exposed. Boot warns
 * (without changing any default) so a production deployment that merely forgot the variable can tell.
 */
export function isNodeEnvUnset(nodeEnv?: string): boolean {
  return !nodeEnv?.trim();
}

/** A built-in S3 endpoint is the bundled MinIO (host `minio`). An unset endpoint means the standard
 * AWS regional endpoint, so it is external and its credentials must never be exempted. */
function isInternalS3Endpoint(endpoint?: string): boolean {
  const e = endpoint?.trim();
  if (!e) return false;
  try {
    return new URL(e).hostname === 'minio';
  } catch {
    return false;
  }
}

export interface SecretCheckEnv {
  nodeEnv?: string;
  databaseType?: string;
  databasePassword?: string;
  /** POSTGRES_BUILTIN — when 'true', OpenWA runs the bundled Postgres on the internal-only network. */
  postgresBuiltIn?: string;
  /** DATABASE_HOST — used to confirm a built-in exemption really points at the internal `postgres`. */
  databaseHost?: string;
  storageType?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  /** S3_ENDPOINT — used to confirm a built-in exemption really points at the internal `minio`. */
  s3Endpoint?: string;
  /** MINIO_BUILTIN — when 'true', OpenWA runs the bundled MinIO on the internal-only network. */
  minioBuiltIn?: string;
  apiMasterKey?: string;
  /** ALLOW_DEV_API_KEY — when 'true' it seeds the well-known public `dev-admin-key` as an ADMIN credential. */
  allowDevApiKey?: string;
  /** REDIS_PASSWORD — optional; passwordless private-network Redis is supported, so only a known placeholder is rejected. */
  redisPassword?: string;
}

/**
 * Refuse to boot in production when a required secret is empty, a known default/
 * placeholder, or — for an explicit API_MASTER_KEY — below the length floor.
 * Only secrets actually in use are checked: the DB password
 * when DATABASE_TYPE=postgres, the S3 keys when STORAGE_TYPE=s3, and API_MASTER_KEY
 * whenever it is set. Throws with the offending var names so the operator can fix them.
 */
export function assertNoDefaultSecretsInProduction(env: SecretCheckEnv): void {
  // Deny-list, not an allow-list: main.ts calls this BEFORE NestFactory.create, so NODE_ENV has not
  // been through boot validation yet and is still an arbitrary string here. Recognising only
  // 'production' meant every unrecognised value — a `prod` typo, a `staging` deployment — skipped the
  // guard silently, including the ALLOW_DEV_API_KEY rejection below. Only the two values that are
  // deliberately not production (and an unset or blank variable, the standard Node default for local
  // runs) skip it; everything else is treated as production.
  //
  // NOTE: unset skips the guard. That is the pre-existing behaviour and is deliberate — a local
  // `node dist/main` outside the packaged runtimes sets no NODE_ENV, and refusing to start there
  // would break local use — but it does mean a production deployment must set it (the runtime image
  // and the chart do so themselves). shutdown.service.ts makes the OPPOSITE choice for the
  // same variable (unset keeps the production drain window), so this is not a mirror of it.
  // A blank value means the same here as it does to boot validation, which treats '' as unset:
  // otherwise `NODE_ENV=` boots clean and then gets production-grade secret enforcement, and the
  // two halves of this guard disagree about the same string.
  const nodeEnv = env.nodeEnv?.trim();
  if (nodeEnv === 'development' || nodeEnv === 'test' || !nodeEnv) return;

  const isWeak = (value?: string): boolean => !value || FORBIDDEN_PROD_SECRETS.has(value.trim().toLowerCase());
  const problems: string[] = [];

  // Built-in datastores run on the internal-only Docker network (the managed container specs in
  // docker.service.ts publish no host ports), so their fixed
  // 'openwa'/'minioadmin' credentials are not internet-reachable — exempt them so selecting the
  // built-in option doesn't crash-loop a production boot. The exemption requires BOTH the built-in
  // flag AND an internal host: a host-pinned EXTERNAL datastore (even with the built-in flag set) is
  // reachable, so its weak credential is still enforced.
  const dbHost = env.databaseHost?.trim();
  const dbExempt = env.postgresBuiltIn === 'true' && (!dbHost || dbHost === 'postgres');
  if (env.databaseType === 'postgres' && !dbExempt && isWeak(env.databasePassword)) {
    problems.push('DATABASE_PASSWORD');
  }
  const s3Exempt = env.minioBuiltIn === 'true' && isInternalS3Endpoint(env.s3Endpoint);
  if (env.storageType === 's3' && !s3Exempt) {
    // Name the canonical variables even when the value came from the legacy S3_ACCESS_KEY /
    // S3_SECRET_KEY fallback: they are what the docs and .env.example tell an operator to set.
    if (isWeak(env.s3AccessKey)) problems.push('S3_ACCESS_KEY_ID');
    if (isWeak(env.s3SecretKey)) problems.push('S3_SECRET_ACCESS_KEY');
  }
  // API_MASTER_KEY is optional, but if provided it must neither be a known default nor fall below
  // the length floor — both are refused the same way, like the other weak secrets above. Unset stays
  // allowed: first boot then generates a strong random key (resolveSeedApiKey).
  if (env.apiMasterKey) {
    const masterKey = env.apiMasterKey.trim();
    if (FORBIDDEN_PROD_SECRETS.has(masterKey.toLowerCase())) {
      problems.push('API_MASTER_KEY');
    } else if (masterKey.length < MIN_PROD_MASTER_KEY_LENGTH) {
      problems.push(`API_MASTER_KEY (below the ${MIN_PROD_MASTER_KEY_LENGTH}-character minimum)`);
    }
  }
  // Redis auth is optional (passwordless private-network Redis is a supported deployment), so unlike
  // DATABASE_PASSWORD this rejects only a known placeholder VALUE — never an empty/unset password.
  if (env.redisPassword && FORBIDDEN_PROD_SECRETS.has(env.redisPassword.trim().toLowerCase())) {
    problems.push('REDIS_PASSWORD');
  }
  // ALLOW_DEV_API_KEY=true seeds the publicly-documented `dev-admin-key` as an ADMIN credential
  // (when no API_MASTER_KEY is set) — never allow that opt-in to be carried into production.
  if (env.allowDevApiKey === 'true') {
    problems.push('ALLOW_DEV_API_KEY (seeds the public dev-admin-key)');
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start in production: insecure or default value for ${problems.join(', ')}. ` +
        'Set strong, unique secrets (see .env.example).',
    );
  }
}
