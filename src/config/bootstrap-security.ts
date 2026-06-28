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

/** Request body-size cap (DoS hardening). Default is media-aware (base64 sends ride in the JSON body). */
export function resolveBodyLimit(bodySizeEnv?: string): string {
  const trimmed = bodySizeEnv?.trim();
  return trimmed ? trimmed : '25mb';
}

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

/** A built-in S3 endpoint is the bundled MinIO (host `minio`) — or unset (the built-in default). An
 * external endpoint (e.g. s3.amazonaws.com) is reachable, so its credentials are never exempted. */
function isInternalS3Endpoint(endpoint?: string): boolean {
  const e = endpoint?.trim();
  if (!e) return true;
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
 * Refuse to boot in production when a required secret is empty or a known default/
 * placeholder. Only secrets actually in use are checked: the DB password
 * when DATABASE_TYPE=postgres, the S3 keys when STORAGE_TYPE=s3, and API_MASTER_KEY
 * whenever it is set. Throws with the offending var names so the operator can fix them.
 */
export function assertNoDefaultSecretsInProduction(env: SecretCheckEnv): void {
  if (env.nodeEnv !== 'production') return;

  const isWeak = (value?: string): boolean => !value || FORBIDDEN_PROD_SECRETS.has(value.trim().toLowerCase());
  const problems: string[] = [];

  // Built-in datastores run on the internal-only Docker network (not published), so their fixed
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
    if (isWeak(env.s3AccessKey)) problems.push('S3_ACCESS_KEY');
    if (isWeak(env.s3SecretKey)) problems.push('S3_SECRET_KEY');
  }
  // API_MASTER_KEY is optional, but if provided it must not be a known default.
  if (env.apiMasterKey && FORBIDDEN_PROD_SECRETS.has(env.apiMasterKey.trim().toLowerCase())) {
    problems.push('API_MASTER_KEY');
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
