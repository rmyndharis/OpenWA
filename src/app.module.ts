import { Module, DynamicModule, Type } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import configuration from './config/configuration';
import { SessionModule } from './modules/session/session.module';
import { MessageModule } from './modules/message/message.module';
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
import { StatusModule } from './modules/status/status.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { HooksModule } from './core/hooks';
import { PluginsModule } from './core/plugins';
import { PluginsApiModule } from './modules/plugins/plugins.module';

// Only import QueueModule if explicitly enabled to avoid Redis connection errors
const queueModules: Array<Type | DynamicModule> = [];
if (process.env.QUEUE_ENABLED === 'true') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const queueModule = require('./modules/queue/queue.module') as {
    QueueModule: Type;
  };
  queueModules.push(queueModule.QueueModule);
}

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),

    // Main Database (always SQLite - boot config)
    TypeOrmModule.forRootAsync({
      name: 'main',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'sqlite' as const,
        database: configService.get<string>('database.database', './data/main.sqlite'),
        entities: [__dirname + '/modules/auth/**/*.entity{.ts,.js}', __dirname + '/modules/audit/**/*.entity{.ts,.js}'],
        synchronize: true,
        logging: configService.get<boolean>('database.logging', false),
      }),
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
          ],
          migrations: [__dirname + '/database/migrations/*{.ts,.js}'],
          logging: configService.get<boolean>('dataDatabase.logging', false),
        };

        if (dbType === 'postgres') {
          return {
            ...baseConfig,
            type: 'postgres' as const,
            host: configService.get<string>('dataDatabase.host'),
            port: configService.get<number>('dataDatabase.port'),
            username: configService.get<string>('dataDatabase.username'),
            password: configService.get<string>('dataDatabase.password'),
            database: 'openwa',

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
            },
          };
        }

        // SQLite: zero-config. Default to synchronize=true so the embedded
        // database "just works" on first boot without a separate migration step.
        // Users can opt out with DATABASE_SYNCHRONIZE=false to use migrations instead.
        return {
          ...baseConfig,
          type: 'sqlite' as const,
          database: configService.get<string>('dataDatabase.database', './data/openwa.sqlite'),
          synchronize: configService.get<boolean>('dataDatabase.synchronize', true),
          migrationsRun: !configService.get<boolean>('dataDatabase.synchronize', true),
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
    WebhookModule,
    HealthModule,
    SettingsModule,
    InfraModule,
    ContactModule,
    GroupModule,
    LabelModule, // Phase 3: Labels Management
    ChannelModule, // Phase 3: Channels/Newsletter
    StatsModule, // Phase 3: Statistics Dashboard
    StatusModule, // Phase 3: Status/Stories API
    CatalogModule, // Phase 3: Catalog API (WhatsApp Business)
    PluginsApiModule, // Phase 5: Plugins API
  ],
})
export class AppModule {}
