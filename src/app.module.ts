import { Module, DynamicModule, Type } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ConfigModule, ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
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
import { EventsModule } from './modules/events/events.module';
import { ContactModule } from './modules/contact/contact.module';
import { GroupModule } from './modules/group/group.module';
import { LabelModule } from './modules/label/label.module';
import { ChannelModule } from './modules/channel/channel.module';
import { CacheModule } from './common/cache';
import { StorageModule } from './common/storage/storage.module';
import { StatsModule } from './modules/stats/stats.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { StatusModule } from './modules/status/status.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { HooksModule } from './core/hooks';
import { PluginsModule } from './core/plugins';
import { PluginsApiModule } from './modules/plugins/plugins.module';
import { AgentToolsModule } from './core/agent-tools/agent-tools.module';
import { IntegrationModule } from './modules/integration/integration.module';

// Only import QueueModule if explicitly enabled to avoid Redis connection errors
const queueModules: Array<Type | DynamicModule> = [];
if (process.env.QUEUE_ENABLED === 'true') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const queueModule = require('./modules/queue/queue.module') as {
    QueueModule: Type;
  };
  queueModules.push(queueModule.QueueModule);
}

// Only mount the MCP server if explicitly enabled to avoid startup cost and
// the SDK import (which pulls in @modelcontextprotocol/sdk) in non-MCP deployments.
const mcpModules: Array<Type | DynamicModule> = [];
if (process.env.MCP_ENABLED === 'true') {
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
if (dashboardServingEnabled && dashboardBuildPresent) {
  serveStaticModules.push(
    ServeStaticModule.forRoot({
      rootPath: DASHBOARD_DIST,
      // Let Nest own these so unknown API/socket routes return real 404s/JSON rather
      // than the SPA index.html fallback (Express 5 / path-to-regexp v8 wildcard syntax).
      exclude: ['/api/{*splat}', '/socket.io/{*splat}', '/mcp', '/mcp/{*splat}'],
    }),
  );
}

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),

    // Main Database (always SQLite - boot config)
    TypeOrmModule.forRootAsync({
      name: 'main',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        // Default ON for zero-config first boot. When disabled
        // (MAIN_DATABASE_SYNCHRONIZE=false), the main-owned migrations create the
        // api_keys/audit_logs schema instead — never both at once.
        const synchronize = configService.get<boolean>('database.synchronize', true);
        return {
          name: 'main',
          type: 'sqlite' as const,
          database: configService.get<string>('database.database', './data/main.sqlite'),
          entities: [
            __dirname + '/modules/auth/**/*.entity{.ts,.js}',
            __dirname + '/modules/audit/**/*.entity{.ts,.js}',
          ],
          // Dedicated migrations dir for the main connection only (must NOT run the
          // data-connection migrations, which target session/webhook/message tables).
          migrations: [__dirname + '/database/migrations-main/*{.ts,.js}'],
          synchronize,
          migrationsRun: !synchronize,
          logging: configService.get<boolean>('database.logging', false),
        };
      },
    }),

    // Data Storage Database (pluggable - user data)
    TypeOrmModule.forRootAsync({
      name: 'data',
      imports: [ConfigModule],
      inject: [ConfigService],
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
          ],
          migrations: [__dirname + '/database/migrations/*{.ts,.js}'],
          logging: configService.get<boolean>('dataDatabase.logging', false),
        };

        if (dbType === 'postgres') {
          return {
            ...baseConfig,
            name: 'data',
            type: 'postgres' as const,
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

            // Never auto-sync Postgres in production; rely on migrations.
            synchronize: configService.get<boolean>('dataDatabase.synchronize', false),
            migrationsRun: true,
            retryAttempts: 10,
            retryDelay: 3000,
            extra: {
              max: configService.get<number>('dataDatabase.poolSize', 10),
              // Runtime query/pool timeouts so a stuck query or saturated pool fails fast instead of
              // hanging requests. statement_timeout bounds live runtime queries; the boot migrations
              // (migrationsRun above) reset it to 0 per-transaction via SET LOCAL, so a long
              // CREATE INDEX / backfill at boot is never aborted by it.
              statement_timeout: configService.get<number>('dataDatabase.statementTimeoutMs', 30000),
              idleTimeoutMillis: configService.get<number>('dataDatabase.idleTimeoutMs', 30000),
              connectionTimeoutMillis: configService.get<number>('dataDatabase.connectionTimeoutMs', 10000),
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
          type: 'sqlite' as const,
          database: configService.get<string>('dataDatabase.database', './data/openwa.sqlite'),
          synchronize,
          migrationsRun: !synchronize,
        };
      },
    }),

    // Rate limiting
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        throttlers: [
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
        ],
      }),
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
    InfraModule,
    ContactModule,
    GroupModule,
    LabelModule, // Phase 3: Labels Management
    ChannelModule, // Phase 3: Channels/Newsletter
    StatsModule, // Phase 3: Statistics Dashboard
    MetricsModule, // Prometheus /api/metrics
    StatusModule, // Phase 3: Status/Stories API
    CatalogModule, // Phase 3: Catalog API (WhatsApp Business)
    PluginsApiModule, // Phase 5: Plugins API
    AgentToolsModule, // Agent-invocable tool registry (protocol-neutral)
    IntegrationModule, // Integration Fabric: @Public provider-webhook ingress + fast-ack pipeline
    ...mcpModules, // MCP Streamable-HTTP server (opt-in via MCP_ENABLED=true)
    ...serveStaticModules, // Bundled dashboard SPA (production single-port setup)
  ],
})
export class AppModule {}
