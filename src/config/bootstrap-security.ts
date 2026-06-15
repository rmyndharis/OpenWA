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

/** Swagger UI is served unless ENABLE_SWAGGER=false (default on, backward compatible). */
export function isSwaggerEnabled(enableSwaggerEnv?: string): boolean {
  return enableSwaggerEnv !== 'false';
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
  'changeme',
  'change-me',
  'password',
  'secret',
  'admin',
]);

export interface SecretCheckEnv {
  nodeEnv?: string;
  databaseType?: string;
  databasePassword?: string;
  storageType?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
  apiMasterKey?: string;
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

  if (env.databaseType === 'postgres' && isWeak(env.databasePassword)) {
    problems.push('DATABASE_PASSWORD');
  }
  if (env.storageType === 's3') {
    if (isWeak(env.s3AccessKey)) problems.push('S3_ACCESS_KEY');
    if (isWeak(env.s3SecretKey)) problems.push('S3_SECRET_KEY');
  }
  // API_MASTER_KEY is optional, but if provided it must not be a known default.
  if (env.apiMasterKey && FORBIDDEN_PROD_SECRETS.has(env.apiMasterKey.trim().toLowerCase())) {
    problems.push('API_MASTER_KEY');
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to start in production: insecure or default value for ${problems.join(', ')}. ` +
        'Set strong, unique secrets (see .env.example).',
    );
  }
}
