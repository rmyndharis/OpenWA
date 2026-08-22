import { Module, DynamicModule, Type } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ConfigModule, ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { RedisThrottlerStorage } from './common/throttler/redis-throttler.storage';
import { createThrottlerRedisClient } from './common/throttler/throttler-redis.client';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { createBootDataSource } from './database/pg-boot-migrations';
import { SessionModule } from './modules/session/session.module';
import { MessageModule } from './modules/message/message.module';
import { TemplateModule } from './modules/template/template.module';
import { WebhookModule } from './modules/webhook/webhook.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { AuditModule } from './modules/audit/audit.module';
import { EngineModule } from './engine/engine.module';
import { LoggerModule } from './common/services/logger.module';
import { SettingsModule } from './modules/settings/settings.module';
import { InfraModule } from './modules/infra/infra.module';
import { InfraNodeModule } from './modules/infra/infra-node.module';
import { EventsModule } from './modules/events/events.module';
import { ContactModule } from './modules/contact/contact.module';
import { GroupModule } from './modules/group/group.module';
import { ProfileModule } from './modules/profile/profile.module';
import { CallModule } from './modules/call/call.module';
import { LabelModule } from './modules/label/label.module';
import { ChannelModule } from './modules/channel/channel.module';
import { CacheModule } from './common/cache';
import { StorageModule } from './common/storage/storage.module';
import { StatsModule } from './modules/stats/stats.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { StatusModule } from './modules/status/status.module';
import { MediaModule } from './modules/media/media.module';
import { StatusStoreModule } from './modules/status-store/status-store.module';
import { ChatMediaModule } from './modules/chat-media/chat-media.module';
import { AutomationModule } from './modules/automation/automation.module';
import { TakeoverModule } from './modules/takeover/takeover.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { HooksModule } from './core/hooks';
import { PluginsModule } from './core/plugins';
import { PluginsApiModule } from './modules/plugins/plugins.module';
import { AgentToolsModule } from './core/agent-tools/agent-tools.module';
import { IntegrationModule } from './modules/integration/integration.module';
import { SearchModule } from './modules/search/search.module';
import { SqlitePermissionsBoot } from './database/sqlite-file-permissions';

// Which plane this process serves (see configuration.ts `role`). Read from process.env because
// this file computes its conditional module arrays at module-eval time, before ConfigModule loads.
const ROLE = ['api', 'worker', 'all'].includes(process.env.ROLE ?? '') ? (process.env.ROLE as string) : 'all';
const isWorkerRole = ROLE === 'worker';
const isApiRole = ROLE === 'api';

// Only import QueueModule if explicitly enabled to avoid Redis connection errors
const queueModules: Array<Type | DynamicModule> = [];
if (process.env.QUEUE_ENABLED === 'true') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const queueModule = require('./modules/queue/queue.module') as {
    QueueModule: Type;
  };
  queueModules.push(queueModule.QueueModule);
}

// Global message search. Opt-out via SEARCH_ENABLED=false: the module (route + provider + registry)
// is absent entirely — zero footprint, no DI wiring. Mirrors the queueModules/MCP conditional shape so
// an opt-out deployment never even loads the search providers. Default is ON for zero-config first boot.
const searchModules: Array<Type | DynamicModule> = [];
if (process.env.SEARCH_ENABLED !== 'false' && !isWorkerRole) {
  searchModules.push(SearchModule);
}

// Only mount the MCP server if explicitly enabled to avoid startup cost and
// the SDK import (which pulls in @modelcontextprotocol/sdk) in non-MCP deployments.
const mcpModules: Array<Type | DynamicModule> = [];
if (process.env.MCP_ENABLED === 'true' && !isWorkerRole) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { McpModule } = require('./modules/mcp/mcp.module') as typeof import('./modules/mcp/mcp.module');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { version } = require('../package.json') as { version: string };
  mcpModules.push(
    McpModule.forRoot({
      basePath: '/mcp',
      serverInfo: { name: 'openwa', version },
    }),
  );
}

// Serve the bundled dashboard SPA from this same NestJS process/port when a build is
// present (the production image copies dashboard/dist in). In local dev the build is
// absent, so this stays inert and the Vite dev server (:2886) handles the UI. Opt out
// explicitly with SERVE_DASHBOARD=false. The path + flags are exported so main.ts can
// log a clear status line (served / disabled / build missing) at startup.
export const DASHBOARD_DIST = path.resolve(__dirname, '..', 'dashboard', 'dist');
export const dashboardServingEnabled = process.env.SERVE_DASHBOARD !== 'false';
export const dashboardBuildPresent = fs.existsSync(path.join(DASHBOARD_DIST, 'index.html'));

const serveStaticModules: Array<Type | DynamicModule> = [];
if (dashboardServingEnabled && dashboardBuildPresent && !isWorkerRole) {
  serveStaticModules.push(
    ServeStaticModule.forRoot({
      rootPath: DASHBOARD_DIST,
      // Let Nest own these so unknown API/socket routes return real 404s/JSON rather
      // than the SPA index.html fallback (Express 5 / path-to-regexp v8 wildcard syntax).
      exclude: ['/api/{*splat}', '/socket.io/{*splat}', '/mcp', '/mcp/{*splat}'],
      // Disable this module's OWN catch-all SPA fallback. main.ts already serves dashboard
      // documents (it injects the per-response CSP nonce, which is why it must own them), and
      // that handler is correctly narrow: it skips /assets and only answers extensionless paths
      // or explicit text/html navigations. The built-in fallback here is not narrow — it answers
      // EVERY unmatched GET with index.html, so a mistyped `<script src>` came back 200 HTML and
      // the browser reported a JavaScript parse error instead of the real 404, hiding broken
      // builds behind a confusing symptom. It is also outright broken when the install path
      // contains a dot-segment (~/.openwa, a checkout under ~/.cache): it sends the index by
      // ABSOLUTE path and Express's `send` refuses dot-segments, 404ing every client-side route.
      // Turning it off fixes both, and makes behaviour identical on either path shape.
      // ServeStaticModule has no explicit off switch, so this is a renderPath literal that no
      // real request can match.
      renderPath: '/__openwa_spa_fallback_owned_by_main_ts__',
    }),
  );
}

// InfraModule is the operator/config surface (dashboard backplane, Docker orchestration, data
// import/export, .env.generated writer) — control-plane concerns, absent on workers. The node-level
// drain verb lives in its own InfraNodeModule below so EVERY role keeps it: draining is exactly a
// worker operation. TakeoverModule is the engine-adopting claim loop — engine-hosting roles only;
// the api role must never launch an engine (its auto-start flag is also forced off in
// feature-flags.ts, so this exclusion is belt AND braces).
const roleModules: Array<Type | DynamicModule> = [];
if (!isWorkerRole) {
  roleModules.push(InfraModule);
}
if (!isApiRole) {
  roleModules.push(TakeoverModule);
}

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),

    // Main Database (auth/audit). SQLite by default; MAIN_DATABASE_TYPE=postgres moves it to a
    // shared server — required for multi-node, where per-node SQLite files mean per-node key stores.
    TypeOrmModule.forRootAsync({
      name: 'main',
      imports: [ConfigModule],
      inject: [ConfigService],
      // Postgres boots its migrations under the same cross-replica advisory lock as the data
      // connection; the sqlite branch keeps the library's default construction + initialize.
      dataSourceFactory: createBootDataSource,
      useFactory: (configService: ConfigService) => {
        const baseConfig = {
          name: 'main',
          entities: [
            __dirname + '/modules/auth/**/*.entity{.ts,.js}',
            __dirname + '/modules/audit/**/*.entity{.ts,.js}',
          ],
          // Dedicated migrations dir for the main connection only (must NOT run the
          // data-connection migrations, which target session/webhook/message tables).
          migrations: [__dirname + '/database/migrations-main/*{.ts,.js}'],
          logging: configService.get<boolean>('database.logging', false),
        };
        if (configService.get<string>('database.type') === 'postgres') {
          return {
            ...baseConfig,
            type: 'postgres' as const,
            host: configService.get<string>('database.host'),
            port: configService.get<number>('database.port'),
            username: configService.get<string>('database.username'),
            password: configService.get<string>('database.password'),
            database: configService.get<string>('database.database', 'openwa_main'),
            // Never synchronize on postgres: N replicas racing DDL is the failure the advisory-
            // locked migration boot exists to prevent. The migration chain is idempotent
            // (IF NOT EXISTS), so it also adopts a database created by an earlier synchronize.
            synchronize: false,
            migrationsRun: true,
            // Same UTC discipline as the data connection (see its comment).
            useUTC: true,
            extra: { options: '-c timezone=UTC' },
          };
        }
        // Default ON for zero-config first boot. When disabled (MAIN_DATABASE_SYNCHRONIZE=false),
        // the main-owned migrations create the api_keys/audit_logs schema instead — never both.
        const synchronize = configService.get<boolean>('database.synchronize', true);
        return {
          ...baseConfig,
          type: 'better-sqlite3' as const,
          database: configService.get<string>('database.database', './data/main.sqlite'),
          synchronize,
          migrationsRun: !synchronize,
        };
      },
    }),

    // Data Storage Database (pluggable - user data)
    TypeOrmModule.forRootAsync({
      name: 'data',
      imports: [ConfigModule],
      inject: [ConfigService],
      // The postgres branch runs its boot migrations under a cross-replica advisory lock inside
      // this factory (see pg-boot-migrations.ts) instead of TypeORM's unsynchronized built-in
      // migrationsRun; the sqlite branches keep the library's default construction + initialize.
      dataSourceFactory: createBootDataSource,
      useFactory: (configService: ConfigService) => {
        const dbType = configService.get<'sqlite' | 'postgres'>('dataDatabase.type', 'sqlite');
        const baseConfig = {
          entities: [
            __dirname + '/modules/session/**/*.entity{.ts,.js}',
            __dirname + '/modules/webhook/**/*.entity{.ts,.js}',
            __dirname + '/modules/message/**/*.entity{.ts,.js}',
            __dirname + '/modules/template/**/*.entity{.ts,.js}',
            __dirname + '/engine/**/*.entity{.ts,.js}',
            __dirname + '/modules/integration/**/*.entity{.ts,.js}',
            __dirname + '/modules/status-store/**/*.entity{.ts,.js}',
            __dirname + '/modules/automation/**/*.entity{.ts,.js}',
          ],
          migrations: [__dirname + '/database/migrations/*{.ts,.js}'],
          logging: configService.get<boolean>('dataDatabase.logging', false),
        };

        if (dbType === 'postgres') {
          // Schema selection: 'public' (default) is a no-op vs the historical behavior. A non-public
          // schema additionally sets the session search_path via pg's startup `options` parameter so
          // the project's RAW, unqualified migration SQL (CREATE TABLE "x"..., ALTER TABLE "y"...)
          // resolves to the configured schema — TypeORM's `schema` option alone does NOT set
          // search_path, so without this raw DDL would land in `public` while the migration ledger
          // lands in the configured schema.
          const schema = configService.get<string>('dataDatabase.schema', 'public');
          const useCustomSearchPath = schema && schema !== 'public';
          return {
            ...baseConfig,
            name: 'data',
            type: 'postgres' as const,
            schema,
            host: configService.get<string>('dataDatabase.host'),
            port: configService.get<number>('dataDatabase.port'),
            username: configService.get<string>('dataDatabase.username'),
            password: configService.get<string>('dataDatabase.password'),
            database: configService.get<string>('dataDatabase.name', 'openwa'),

            ssl: configService.get<boolean>('dataDatabase.ssl', false)
              ? {
                  rejectUnauthorized: configService.get<boolean>('dataDatabase.sslRejectUnauthorized', true),
                }
              : false,

            // Never auto-sync Postgres in production; rely on migrations. Boot migrations execute
            // inside createBootDataSource (dataSourceFactory above) under the advisory lock — this
            // flag states the intent and remains the built-in fallback if that factory is ever
            // bypassed (the factory constructs the DataSource with migrationsRun:false and calls
            // runMigrations() itself while holding the lock).
            synchronize: configService.get<boolean>('dataDatabase.synchronize', false),
            migrationsRun: true,
            retryAttempts: 10,
            retryDelay: 3000,
            // Read/write timestamp-without-timezone columns as UTC. With DB-clock leases, NOW()
            // writes the database's naive UTC into leaseExpiresAt; without this, node-postgres
            // parses that value back in the NODE's local timezone, and every JS-side date the app
            // touches is shifted by the tz offset — an IST reader saw a live lease as 5.5h lapsed.
            useUTC: true,
            extra: {
              max: configService.get<number>('dataDatabase.poolSize', 10),
              // Runtime query/pool timeouts so a stuck query or saturated pool fails fast instead of
              // hanging requests. statement_timeout bounds live runtime queries; the boot migrations
              // reset it to 0 per-transaction via SET LOCAL, so a long
              // CREATE INDEX / backfill at boot is never aborted by it.
              statement_timeout: configService.get<number>('dataDatabase.statementTimeoutMs', 30000),
              idleTimeoutMillis: configService.get<number>('dataDatabase.idleTimeoutMs', 30000),
              connectionTimeoutMillis: configService.get<number>('dataDatabase.connectionTimeoutMs', 10000),
              // Pin the session timezone so NOW() renders UTC whatever the server default is —
              // the other half of useUTC above (a managed PG with a non-UTC default would
              // otherwise write local-naive lease expiries). search_path rides the same startup
              // options string for a non-public schema (see above).
              options: `-c timezone=UTC${useCustomSearchPath ? ` -c search_path=${schema},public` : ''}`,
            },
          };
        }

        // SQLite data DB: schema is MIGRATION-managed by default (DATABASE_SYNCHRONIZE unset/false),
        // matching configuration.ts and .env.example ("Set false in production"). Set
        // DATABASE_SYNCHRONIZE=true for zero-config synchronize instead. Computed once: the resolved
        // value is always a boolean, so a get(..., true) fallback would never fire (and would be a trap).
        const synchronize = configService.get<boolean>('dataDatabase.synchronize', false);
        return {
          ...baseConfig,
          name: 'data',
          type: 'better-sqlite3' as const,
          database: configService.get<string>('dataDatabase.database', './data/openwa.sqlite'),
          synchronize,
          migrationsRun: !synchronize,
        };
      },
    }),

    // Rate limiting. When REDIS_ENABLED, the hit-count storage moves to Redis so limits aggregate
    // across replicas; otherwise the default in-memory (per-process) storage is used. Default off —
    // a single-node deployment gains nothing from Redis storage, and it adds a connection dep.
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const throttlers = [
          {
            name: 'short',
            ttl: configService.get<number>('api.rateLimit.shortTtl', 1000),
            limit: configService.get<number>('api.rateLimit.shortLimit', 10),
          },
          {
            name: 'medium',
            ttl: configService.get<number>('api.rateLimit.mediumTtl', 60000),
            limit: configService.get<number>('api.rateLimit.mediumLimit', 100),
          },
          {
            name: 'long',
            ttl: configService.get<number>('api.rateLimit.longTtl', 3600000),
            limit: configService.get<number>('api.rateLimit.longLimit', 1000),
          },
        ];
        // Fail-open on Redis error (see RedisThrottlerStorage), so a Redis outage never blocks the
        // API. The client is built fail-fast (see throttler-redis.client.ts) so that fail-open
        // engages immediately instead of after a queue/timeout stall per request.
        const redisStorage =
          process.env.REDIS_ENABLED === 'true'
            ? new RedisThrottlerStorage(createThrottlerRedisClient(configService))
            : undefined;
        return { throttlers, ...(redisStorage ? { storage: redisStorage } : {}) };
      },
    }),

    // Core modules
    HooksModule, // Global hook system for plugin integration
    PluginsModule, // Global plugin system
    LoggerModule,
    CacheModule,
    StorageModule,
    AuditModule,
    EventsModule, // WebSocket real-time events
    ...queueModules,
    AuthModule,
    EngineModule,
    SessionModule,
    MessageModule,
    TemplateModule,
    WebhookModule,
    HealthModule,
    SettingsModule,
    InfraNodeModule, // node drain verb — every role (see roleModules note)
    ContactModule,
    GroupModule,
    ProfileModule, // Own-profile API (name / status / picture)
    CallModule, // Incoming-call API (reject a ringing call)
    LabelModule, // Phase 3: Labels Management
    ChannelModule, // Phase 3: Channels/Newsletter
    StatsModule, // Phase 3: Statistics Dashboard
    MetricsModule, // Prometheus /api/metrics
    StatusModule, // Phase 3: Status/Stories API
    MediaModule, // Server-side media conversion (opt-in)
    StatusStoreModule, // Phase 3: inbound status/story TTL store (24h purge + media persistence)
    ChatMediaModule, // opt-in chat-media archive (retention purge + orphan sweep)
    AutomationModule, // single-message autoreply rules, evaluated on the inbound dispatch
    CatalogModule, // Phase 3: Catalog API (WhatsApp Business)
    PluginsApiModule, // Phase 5: Plugins API
    AgentToolsModule, // Agent-invocable tool registry (protocol-neutral)
    IntegrationModule, // Integration Fabric: @Public provider-webhook ingress + fast-ack pipeline
    ...searchModules, // Global message search (opt-out via SEARCH_ENABLED=false; default ON)
    ...mcpModules, // MCP Streamable-HTTP server (opt-in via MCP_ENABLED=true)
    ...serveStaticModules, // Bundled dashboard SPA (production single-port setup)
    ...roleModules, // role-gated control-plane / engine-hosting modules (ROLE=api|worker|all)
  ],
  // Runs after every DataSource has initialized (they initialize eagerly in their provider
  // factories, and onApplicationBootstrap fires after every onModuleInit), tightening the SQLite
  // files that better-sqlite3 created with umask permissions back to owner-only.
  providers: [SqlitePermissionsBoot],
})
export class AppModule {}
