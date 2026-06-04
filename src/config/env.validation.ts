import * as Joi from 'joi';

/**
 * Bootstrap env validation schema (Tier 3 #11).
 *
 * Fails fast at startup if env vars are malformed (wrong type, bad enum,
 * missing DB credentials for a remote driver). Defaults mirror
 * `configuration.ts` so an empty env behaves exactly as before. Unknown env
 * vars are allowed — this only guards the keys the app actually consumes.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().port().default(2785),

  // Redis
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),

  // Feature toggles
  QUEUE_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  CACHE_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),

  // Cluster / horizontal scale (Tier 4). Master gate for Redis-backed
  // Socket.io fan-out and the session-ownership registry.
  CLUSTER_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  // Stable identity for this node in the ownership registry. Defaults to the
  // hostname at bootstrap (resolved in configuration.ts) when left unset.
  INSTANCE_ID: Joi.string().optional(),
  // Seconds before an ownership claim expires if the owner stops heart-beating.
  CLUSTER_OWNERSHIP_TTL: Joi.number().integer().min(5).default(30),

  // Data storage database (pluggable driver). SQLite is single-writer and
  // file-local, so it is rejected when CLUSTER_ENABLED is on (C5): a shared,
  // network-reachable store (postgres/mysql) is mandatory for multi-instance.
  DATABASE_TYPE: Joi.string()
    .valid('sqlite', 'postgres', 'mysql')
    .default('sqlite')
    .when('CLUSTER_ENABLED', {
      is: true,
      then: Joi.invalid('sqlite').messages({
        'any.invalid':
          'DATABASE_TYPE must be postgres or mysql when CLUSTER_ENABLED is true (SQLite cannot be shared across instances)',
      }),
    }),
  DATABASE_NAME: Joi.string().default('./data/openwa.sqlite'),
  DATABASE_HOST: Joi.string().default('localhost'),
  DATABASE_PORT: Joi.number().port().default(5432),
  // Credentials required only for remote drivers (postgres/mysql).
  DATABASE_USERNAME: Joi.string().when('DATABASE_TYPE', {
    is: Joi.valid('postgres', 'mysql'),
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  DATABASE_PASSWORD: Joi.string()
    .allow('')
    .when('DATABASE_TYPE', {
      is: Joi.valid('postgres', 'mysql'),
      then: Joi.required(),
      otherwise: Joi.optional(),
    }),
  DATABASE_SYNCHRONIZE: Joi.boolean().truthy('true').falsy('false').default(false),
  DATABASE_LOGGING: Joi.boolean().truthy('true').falsy('false').default(false),
  DATABASE_POOL_SIZE: Joi.number().integer().min(1).default(10),
  DATABASE_SSL: Joi.boolean().truthy('true').falsy('false').default(false),
  DATABASE_SSL_REJECT_UNAUTHORIZED: Joi.boolean().truthy('true').falsy('false').default(true),

  // WhatsApp engine
  ENGINE_TYPE: Joi.string().default('whatsapp-web.js'),
  PUPPETEER_HEADLESS: Joi.boolean().truthy('true').falsy('false').default(true),
  PUPPETEER_ARGS: Joi.string().default('--no-sandbox,--disable-setuid-sandbox'),
  SESSION_DATA_PATH: Joi.string().default('./data/sessions'),

  // Webhook
  WEBHOOK_TIMEOUT: Joi.number().integer().min(0).default(10000),
  WEBHOOK_MAX_RETRIES: Joi.number().integer().min(0).default(3),
  WEBHOOK_RETRY_DELAY: Joi.number().integer().min(0).default(5000),
  WEBHOOK_MAX_PER_DISPATCH: Joi.number().integer().min(1).default(100),

  // API rate limiting
  RATE_LIMIT_SHORT_TTL: Joi.number().integer().min(0).default(1000),
  RATE_LIMIT_SHORT_LIMIT: Joi.number().integer().min(0).default(10),
  RATE_LIMIT_MEDIUM_TTL: Joi.number().integer().min(0).default(60000),
  RATE_LIMIT_MEDIUM_LIMIT: Joi.number().integer().min(0).default(100),
  RATE_LIMIT_LONG_TTL: Joi.number().integer().min(0).default(3600000),
  RATE_LIMIT_LONG_LIMIT: Joi.number().integer().min(0).default(1000),

  // Storage
  STORAGE_TYPE: Joi.string().valid('local', 's3').default('local'),
  STORAGE_LOCAL_PATH: Joi.string().default('./data/media'),
  // S3 credentials required only when storage type is s3.
  S3_BUCKET: Joi.string().when('STORAGE_TYPE', {
    is: 's3',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  S3_REGION: Joi.string().optional(),
  S3_ACCESS_KEY_ID: Joi.string().when('STORAGE_TYPE', {
    is: 's3',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  S3_SECRET_ACCESS_KEY: Joi.string().when('STORAGE_TYPE', {
    is: 's3',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  S3_ENDPOINT: Joi.string().optional(),

  // Plugin isolation (blast-radius containment). Timeouts wrap plugin
  // entrypoints; the breaker disables a plugin after N consecutive failures.
  PLUGIN_HOOK_TIMEOUT_MS: Joi.number().integer().min(1).default(5000),
  PLUGIN_LIFECYCLE_TIMEOUT_MS: Joi.number().integer().min(1).default(10000),
  PLUGIN_CIRCUIT_BREAKER_THRESHOLD: Joi.number().integer().min(1).default(5),

  // Media handling
  MEDIA_MAX_BYTES: Joi.number().integer().min(1).default(67108864),

  // Audit-log retention/cleanup
  AUDIT_CLEANUP_ENABLED: Joi.boolean().default(true),
  AUDIT_RETENTION_DAYS: Joi.number().integer().min(1).default(30),
  AUDIT_CLEANUP_INTERVAL_HOURS: Joi.number().integer().min(1).default(24),

  // Docker integration
  DOCKER_ENABLED: Joi.boolean().default(true),
  DOCKER_SOCKET_PATH: Joi.string().optional(),
}).unknown(true);
