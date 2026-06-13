import { Controller, Get, Put, Post, Body, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { Public, RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { isPathWithin } from '../../common/utils/path-safety';
import { EngineFactory } from '../../engine/engine.factory';
import { DockerService } from '../docker';
import { CacheService } from '../../common/cache/cache.service';
import { StorageService } from '../../common/storage/storage.service';
import { ShutdownService } from '../../common/services/shutdown.service';
import { createLogger } from '../../common/services/logger.service';
import * as fs from 'fs';
import * as path from 'path';

interface InfraStatus {
  database: { connected: boolean; type: string; host: string };
  redis: { enabled: boolean; connected: boolean; host: string; port: number };
  queue: {
    enabled: boolean;
    messages: { pending: number; completed: number; failed: number };
    webhooks: { pending: number; completed: number; failed: number };
  };
  storage: { type: 'local' | 's3'; path?: string; bucket?: string };
  engine: { type: string; headless: boolean; sessionDataPath: string; browserArgs: string };
}

interface SaveConfigDto {
  database?: {
    type: 'sqlite' | 'postgres';
    builtIn?: boolean;
    host?: string;
    port?: string;
    username?: string;
    password?: string;
    database?: string;
    poolSize?: number;
    sslEnabled?: boolean;
  };
  redis?: {
    enabled?: boolean;
    builtIn?: boolean;
    host?: string;
    port?: string;
    password?: string;
  };
  queue?: {
    enabled?: boolean;
  };
  storage?: {
    type: 'local' | 's3';
    builtIn?: boolean;
    localPath?: string;
    s3Bucket?: string;
    s3Region?: string;
    s3AccessKey?: string;
    s3SecretKey?: string;
    s3Endpoint?: string;
  };
  engine?: {
    headless?: boolean;
    sessionDataPath?: string;
    browserArgs?: string;
  };
}

// Database migration types for export/import
interface SessionRow {
  id: string;
  name: string;
  status: string;
  phone: string | null;
  pushName: string | null;
  config: string | Record<string, unknown>;
  proxyUrl: string | null;
  proxyType: string | null;
  connectedAt: string | null;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface WebhookRow {
  id: string;
  sessionId: string;
  url: string;
  events: string | string[];
  secret: string | null;
  headers: string | Record<string, string>;
  active: boolean;
  retryCount: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MessageRow {
  id: string;
  sessionId: string;
  messageId: string;
  chatId: string;
  direction: string;
  type: string;
  content: string | Record<string, unknown>;
  status: string;
  metadata: string | Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface MessageBatchRow {
  id: string;
  batchId: string;
  sessionId: string;
  status: string;
  messages: string | unknown[];
  options: string | Record<string, unknown>;
  progress: string | Record<string, unknown>;
  results: string | unknown[];
  currentIndex: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface MigrationTables {
  sessions: SessionRow[];
  webhooks: WebhookRow[];
  messages: MessageRow[];
  messageBatches: MessageBatchRow[];
}

@ApiTags('infrastructure')
@Controller('infra')
export class InfraController {
  private readonly logger = createLogger('InfraController');

  constructor(
    private readonly configService: ConfigService,
    @InjectDataSource('main')
    private readonly mainDataSource: DataSource,
    @InjectDataSource('data')
    private readonly dataDataSource: DataSource,
    private readonly engineFactory: EngineFactory,
    private readonly dockerService: DockerService,
    private readonly cacheService: CacheService,
    private readonly storageService: StorageService,
    private readonly shutdownService: ShutdownService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Get infrastructure status' })
  @ApiResponse({ status: 200, description: 'Infrastructure status' })
  async getStatus(): Promise<InfraStatus> {
    // Check both database connections
    const mainDbConnected = this.mainDataSource.isInitialized;
    const dataDbConnected = this.dataDataSource.isInitialized;
    const dbConnected = mainDbConnected && dataDbConnected;
    const dbType = this.configService.get<string>('dataDatabase.type', 'sqlite');
    const dbHost = this.configService.get<string>('dataDatabase.host', 'localhost');

    const redisHost = process.env.REDIS_HOST || this.configService.get<string>('redis.host', 'localhost');
    const redisPort = parseInt(process.env.REDIS_PORT || '', 10) || this.configService.get<number>('redis.port', 6379);
    const redisEnabled = process.env.REDIS_ENABLED === 'true';
    const queueEnabled = this.configService.get<boolean>('queue.enabled', false);

    // Check actual Redis connectivity via CacheService
    const redisConnected = await this.cacheService.isAvailable();

    const storageType = this.configService.get<'local' | 's3'>('storage.type', 'local');
    const storagePath = this.configService.get<string>('storage.path', './uploads');

    const engineType = this.configService.get<string>('engine.type', 'whatsapp-web.js');
    const engineHeadless = this.configService.get<boolean>('engine.headless', true);
    const sessionDataPath = this.configService.get<string>('engine.sessionDataPath', './data/sessions');
    const browserArgs = this.configService.get<string>('engine.browserArgs', '--no-sandbox --disable-gpu');

    return {
      database: { connected: dbConnected, type: dbType, host: dbHost },
      redis: { enabled: redisEnabled, connected: redisConnected, host: redisHost, port: redisPort },
      queue: {
        enabled: queueEnabled,
        messages: { pending: 0, completed: 0, failed: 0 },
        webhooks: { pending: 0, completed: 0, failed: 0 },
      },
      storage: { type: storageType, path: storagePath },
      engine: { type: engineType, headless: engineHeadless, sessionDataPath, browserArgs },
    };
  }

  @Get('engines')
  @ApiOperation({ summary: 'Get available WhatsApp engines' })
  @ApiResponse({ status: 200, description: 'List of available engines' })
  getEngines(): Array<{ id: string; name: string; enabled: boolean; features: string[] }> {
    return this.engineFactory.getAvailableEngines();
  }

  @Get('engines/current')
  @ApiOperation({ summary: 'Get current active engine' })
  @ApiResponse({ status: 200, description: 'Current engine info' })
  getCurrentEngine(): { engineType: string } {
    return { engineType: this.engineFactory.getCurrentEngine() };
  }

  @Put('config')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Save infrastructure configuration to .env file' })
  @ApiResponse({ status: 200, description: 'Configuration saved' })
  @ApiBody({ description: 'Configuration to save' })
  saveConfig(@Body() config: SaveConfigDto): { message: string; saved: boolean; envPath: string; profiles: string[] } {
    try {
      // Build .env content from config
      const envLines: string[] = [];
      const profiles: string[] = [];

      // Header
      envLines.push('# OpenWA Configuration');
      envLines.push(`# Generated at ${new Date().toISOString()}`);
      envLines.push('');

      // Database
      if (config.database) {
        envLines.push('# Database');
        envLines.push(`DATABASE_TYPE=${config.database.type || 'sqlite'}`);
        envLines.push(`POSTGRES_BUILTIN=${config.database.builtIn ? 'true' : 'false'}`);
        if (config.database.type === 'postgres') {
          if (config.database.builtIn) {
            // Built-in PostgreSQL - use container name as host
            envLines.push('DATABASE_HOST=postgres');
            envLines.push('DATABASE_PORT=5432');
            envLines.push('DATABASE_USERNAME=openwa');
            envLines.push('DATABASE_PASSWORD=openwa');
            envLines.push('DATABASE_NAME=openwa');
            profiles.push('postgres');
          } else {
            // External PostgreSQL
            envLines.push(`DATABASE_HOST=${config.database.host || 'localhost'}`);
            envLines.push(`DATABASE_PORT=${config.database.port || '5432'}`);
            envLines.push(`DATABASE_USERNAME=${config.database.username || 'postgres'}`);
            envLines.push(`DATABASE_PASSWORD=${config.database.password || ''}`);
            envLines.push(`DATABASE_NAME=${config.database.database || 'openwa'}`);
          }
          envLines.push(`DATABASE_POOL_SIZE=${config.database.poolSize || 10}`);
          envLines.push(`DATABASE_SSL=${config.database.sslEnabled ? 'true' : 'false'}`);
        }
        envLines.push('');
      }

      // Redis / Queue
      envLines.push('# Redis / Queue System');
      envLines.push(`REDIS_ENABLED=${config.redis?.enabled ? 'true' : 'false'}`);
      envLines.push(`REDIS_BUILTIN=${config.redis?.builtIn ? 'true' : 'false'}`);
      envLines.push(`QUEUE_ENABLED=${config.queue?.enabled ? 'true' : 'false'}`);
      if (config.redis?.enabled) {
        if (config.redis.builtIn) {
          // Built-in Redis - use container name as host
          envLines.push('REDIS_HOST=redis');
          envLines.push('REDIS_PORT=6379');
          profiles.push('redis');
        } else {
          // External Redis
          envLines.push(`REDIS_HOST=${config.redis.host || 'localhost'}`);
          envLines.push(`REDIS_PORT=${config.redis.port || '6379'}`);
          if (config.redis.password) {
            envLines.push(`REDIS_PASSWORD=${config.redis.password}`);
          }
        }
      }
      envLines.push('');

      // Storage
      if (config.storage) {
        envLines.push('# Storage');
        envLines.push(`STORAGE_TYPE=${config.storage.type || 'local'}`);
        envLines.push(`MINIO_BUILTIN=${config.storage.builtIn ? 'true' : 'false'}`);
        if (config.storage.type === 'local') {
          envLines.push(`STORAGE_PATH=${config.storage.localPath || './uploads'}`);
        } else if (config.storage.type === 's3') {
          if (config.storage.builtIn) {
            // Built-in MinIO - use container name as endpoint
            envLines.push('S3_ENDPOINT=http://minio:9000');
            envLines.push('S3_ACCESS_KEY=minioadmin');
            envLines.push('S3_SECRET_KEY=minioadmin');
            envLines.push('S3_BUCKET=openwa');
            envLines.push('S3_REGION=us-east-1');
            profiles.push('minio');
          } else {
            // External S3/MinIO
            envLines.push(`S3_BUCKET=${config.storage.s3Bucket || ''}`);
            envLines.push(`S3_REGION=${config.storage.s3Region || 'ap-southeast-1'}`);
            envLines.push(`S3_ACCESS_KEY=${config.storage.s3AccessKey || ''}`);
            envLines.push(`S3_SECRET_KEY=${config.storage.s3SecretKey || ''}`);
            if (config.storage.s3Endpoint) {
              envLines.push(`S3_ENDPOINT=${config.storage.s3Endpoint}`);
            }
          }
        }
        envLines.push('');
      }

      // Engine
      if (config.engine) {
        envLines.push('# WhatsApp Engine');
        envLines.push(`ENGINE_HEADLESS=${config.engine.headless !== false ? 'true' : 'false'}`);
        envLines.push(`ENGINE_SESSION_PATH=${config.engine.sessionDataPath || './data/sessions'}`);
        envLines.push(`ENGINE_BROWSER_ARGS=${config.engine.browserArgs || '--no-sandbox --disable-gpu'}`);
        envLines.push('');
      }

      // Docker Profiles (for reference)
      envLines.push('# Docker Profiles (auto-generated)');
      envLines.push(`# Required profiles: ${profiles.length > 0 ? profiles.join(', ') : 'none'}`);
      envLines.push('');

      // Write to .env file in data/ directory so it persists across container restarts
      const envPath = path.resolve(process.cwd(), 'data', '.env.generated');
      fs.writeFileSync(envPath, envLines.join('\n'), 'utf8');
      this.logger.log('Configuration saved', { envPath });

      const profileMsg = profiles.length > 0 ? ` Docker profiles required: ${profiles.join(', ')}.` : '';

      return {
        message: `Configuration saved successfully.${profileMsg} Server restart required to apply changes.`,
        saved: true,
        envPath,
        profiles,
      };
    } catch (error) {
      return {
        message: `Failed to save configuration: ${error instanceof Error ? error.message : 'Unknown error'}`,
        saved: false,
        envPath: '',
        profiles: [],
      };
    }
  }
  @Post('restart')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Request server restart with Docker orchestration' })
  @ApiResponse({ status: 200, description: 'Server will restart with new profiles' })
  async requestRestart(@Body() body?: { profiles?: string[]; profilesToRemove?: string[] }): Promise<{
    message: string;
    restarting: boolean;
    profiles: string[];
    profilesToRemove: string[];
    estimatedTime: number;
    orchestration?: object;
    removal?: object;
  }> {
    const profiles = body?.profiles || [];
    const profilesToRemove = body?.profilesToRemove || [];
    let orchestrationResult: object | undefined;
    let removalResult: { removed: string[]; errors: string[] } | undefined;

    this.logger.log('Restart requested', { profiles });
    this.logger.log('Profiles to remove', { profilesToRemove });

    // If profiles are specified, orchestrate Docker containers
    if (this.dockerService.isDockerAvailable()) {
      // First, remove containers for disabled services
      if (profilesToRemove.length > 0) {
        this.logger.log('Removing disabled profiles...');
        removalResult = { removed: [], errors: [] };

        for (const profile of profilesToRemove) {
          try {
            const success = await this.dockerService.removeService(profile);
            if (success) {
              removalResult.removed.push(profile);
            } else {
              removalResult.errors.push(`Failed to remove ${profile}`);
            }
          } catch (err) {
            removalResult.errors.push(`Error removing ${profile}: ${err}`);
          }
        }
        this.logger.log('Removal result', { removalResult });
      }

      // Then, start containers for enabled services
      if (profiles.length > 0) {
        this.logger.log('Orchestrating enabled profiles...');
        orchestrationResult = await this.dockerService.orchestrateProfiles(profiles);
        this.logger.log('Orchestration result', { orchestrationResult });
      }
    } else {
      this.logger.warn('Docker not available, writing signal file instead');
      // Fallback: write signal file for host script
      try {
        const signalFile = path.resolve(process.cwd(), 'data', '.orchestration-request.json');
        const orchestrationRequest = {
          timestamp: new Date().toISOString(),
          profiles,
          profilesToRemove,
          action: 'restart-with-profiles',
        };
        fs.writeFileSync(signalFile, JSON.stringify(orchestrationRequest, null, 2), 'utf8');
        this.logger.log('Orchestration request written', { signalFile });
      } catch (err) {
        this.logger.error('Failed to write orchestration request', err instanceof Error ? err.message : String(err));
      }
    }

    // Schedule graceful shutdown after delay to allow response and container orchestration
    void this.shutdownService.shutdown(3000);

    // Calculate estimated time - base 15s + additional for each service (increased for reliability)
    let estimatedTime = 15;
    if (profiles.includes('postgres')) estimatedTime += 20;
    if (profiles.includes('redis')) estimatedTime += 13;
    if (profiles.includes('minio')) estimatedTime += 15;
    if (profilesToRemove.length > 0) estimatedTime += profilesToRemove.length * 5; // +5s per removal

    return {
      message:
        profiles.length > 0 || profilesToRemove.length > 0
          ? `Server is restarting. Enabling: ${profiles.join(', ') || 'none'}. Disabling: ${profilesToRemove.join(', ') || 'none'}.`
          : 'Server is restarting. Please wait...',
      restarting: true,
      profiles,
      profilesToRemove,
      estimatedTime,
      orchestration: orchestrationResult,
      removal: removalResult,
    };
  }

  @Get('health')
  @Public()
  @ApiOperation({ summary: 'Health check endpoint' })
  @ApiResponse({ status: 200, description: 'Server is healthy' })
  healthCheck(): { status: string; timestamp: string } {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('export-data')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Export all data from Data DB for migration' })
  @ApiResponse({ status: 200, description: 'Exported data as JSON' })
  async exportData(): Promise<{
    exportedAt: string;
    dataDbType: string;
    tables: MigrationTables;
    counts: { sessions: number; webhooks: number; messages: number; messageBatches: number };
  }> {
    // Get all entities from Data DB
    const sessions = await this.dataDataSource.query<SessionRow[]>('SELECT * FROM sessions');
    const webhooks = await this.dataDataSource.query<WebhookRow[]>('SELECT * FROM webhooks');

    // Messages table may not exist yet or be empty
    let messages: MessageRow[] = [];
    let messageBatches: MessageBatchRow[] = [];

    try {
      messages = await this.dataDataSource.query<MessageRow[]>('SELECT * FROM messages');
    } catch (error) {
      this.logger.debug('Messages table not available for export', { error: String(error) });
    }

    try {
      messageBatches = await this.dataDataSource.query<MessageBatchRow[]>('SELECT * FROM message_batches');
    } catch (error) {
      this.logger.debug('Message batches table not available for export', { error: String(error) });
    }

    return {
      exportedAt: new Date().toISOString(),
      dataDbType: this.configService.get<string>('dataDatabase.type', 'sqlite'),
      tables: {
        sessions,
        webhooks,
        messages,
        messageBatches,
      },
      counts: {
        sessions: sessions.length,
        webhooks: webhooks.length,
        messages: messages.length,
        messageBatches: messageBatches.length,
      },
    };
  }

  @Post('import-data')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Import data to Data DB (replaces existing data)' })
  @ApiBody({
    description: 'Exported data from export-data endpoint',
    schema: {
      type: 'object',
      properties: {
        tables: {
          type: 'object',
          properties: {
            sessions: { type: 'array' },
            webhooks: { type: 'array' },
            messages: { type: 'array' },
            messageBatches: { type: 'array' },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Data imported successfully' })
  async importData(
    @Body()
    data: {
      tables: Partial<MigrationTables>;
    },
  ): Promise<{
    imported: boolean;
    counts: { sessions: number; webhooks: number; messages: number; messageBatches: number };
    warnings: string[];
  }> {
    const warnings: string[] = [];
    const queryRunner = this.dataDataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Clear existing data (in correct order due to foreign keys)
      await queryRunner.query('DELETE FROM webhooks');
      await queryRunner.query('DELETE FROM messages').catch(() => {});
      await queryRunner.query('DELETE FROM message_batches').catch(() => {});
      await queryRunner.query('DELETE FROM sessions');

      // Import sessions first
      let sessionsCount = 0;
      if (data.tables.sessions?.length) {
        for (const session of data.tables.sessions) {
          try {
            await queryRunner.query(
              `INSERT INTO sessions (id, name, status, phone, "pushName", config, "proxyUrl", "proxyType", "connectedAt", "lastActiveAt", "createdAt", "updatedAt") 
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
              [
                session.id,
                session.name,
                session.status,
                session.phone,
                session.pushName,
                typeof session.config === 'string' ? session.config : JSON.stringify(session.config || {}),
                session.proxyUrl,
                session.proxyType,
                session.connectedAt,
                session.lastActiveAt,
                session.createdAt,
                session.updatedAt,
              ],
            );
            sessionsCount++;
          } catch (err) {
            warnings.push(`Failed to import session ${session.id}: ${err}`);
          }
        }
      }

      // Import webhooks
      let webhooksCount = 0;
      if (data.tables.webhooks?.length) {
        for (const webhook of data.tables.webhooks) {
          try {
            await queryRunner.query(
              `INSERT INTO webhooks (id, "sessionId", url, events, secret, headers, active, "retryCount", "lastTriggeredAt", "createdAt", "updatedAt") 
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [
                webhook.id,
                webhook.sessionId,
                webhook.url,
                typeof webhook.events === 'string' ? webhook.events : JSON.stringify(webhook.events || []),
                webhook.secret,
                typeof webhook.headers === 'string' ? webhook.headers : JSON.stringify(webhook.headers || {}),
                webhook.active,
                webhook.retryCount,
                webhook.lastTriggeredAt,
                webhook.createdAt,
                webhook.updatedAt,
              ],
            );
            webhooksCount++;
          } catch (err) {
            warnings.push(`Failed to import webhook ${webhook.id}: ${err}`);
          }
        }
      }

      // Import messages (optional)
      let messagesCount = 0;
      if (data.tables.messages?.length) {
        for (const msg of data.tables.messages) {
          try {
            await queryRunner.query(
              `INSERT INTO messages (id, "sessionId", "messageId", "chatId", direction, type, content, status, metadata, "createdAt", "updatedAt") 
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [
                msg.id,
                msg.sessionId,
                msg.messageId,
                msg.chatId,
                msg.direction,
                msg.type,
                typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || {}),
                msg.status,
                typeof msg.metadata === 'string' ? msg.metadata : JSON.stringify(msg.metadata || {}),
                msg.createdAt,
                msg.updatedAt,
              ],
            );
            messagesCount++;
          } catch (err) {
            warnings.push(`Failed to import message ${msg.id}: ${err}`);
          }
        }
      }

      // Import message batches (optional)
      let messageBatchesCount = 0;
      if (data.tables.messageBatches?.length) {
        for (const batch of data.tables.messageBatches) {
          try {
            await queryRunner.query(
              `INSERT INTO message_batches (id, "batchId", "sessionId", status, messages, options, progress, results, "currentIndex", "createdAt", "updatedAt", "startedAt", "completedAt") 
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
              [
                batch.id,
                batch.batchId,
                batch.sessionId,
                batch.status,
                typeof batch.messages === 'string' ? batch.messages : JSON.stringify(batch.messages || []),
                typeof batch.options === 'string' ? batch.options : JSON.stringify(batch.options || {}),
                typeof batch.progress === 'string' ? batch.progress : JSON.stringify(batch.progress || {}),
                typeof batch.results === 'string' ? batch.results : JSON.stringify(batch.results || []),
                batch.currentIndex,
                batch.createdAt,
                batch.updatedAt,
                batch.startedAt,
                batch.completedAt,
              ],
            );
            messageBatchesCount++;
          } catch (err) {
            warnings.push(`Failed to import message batch ${batch.id}: ${err}`);
          }
        }
      }

      await queryRunner.commitTransaction();

      return {
        imported: true,
        counts: {
          sessions: sessionsCount,
          webhooks: webhooksCount,
          messages: messagesCount,
          messageBatches: messageBatchesCount,
        },
        warnings,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // ============================================================================
  // STORAGE MIGRATION API
  // ============================================================================

  @Get('storage/files/count')
  @ApiOperation({ summary: 'Get file count in current storage' })
  @ApiResponse({ status: 200, description: 'File count and size' })
  async getStorageFileCount(): Promise<{
    storageType: string;
    count: number;
    sizeBytes: number;
    sizeMB: string;
  }> {
    const { count, sizeBytes } = await this.storageService.getFileCount();
    return {
      storageType: this.storageService.getCurrentStorageType(),
      count,
      sizeBytes,
      sizeMB: (sizeBytes / 1024 / 1024).toFixed(2),
    };
  }

  @Get('storage/export')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Export all storage files as tar.gz' })
  @ApiResponse({ status: 200, description: 'Tar.gz archive stream' })
  async exportStorage(): Promise<{ message: string; download: string }> {
    // Note: In production, this would return a StreamableFile
    // For simplicity, we'll save to a temp file and return the path
    const stream = await this.storageService.createExportStream();
    const exportPath = path.join(process.cwd(), 'data', `storage-export-${Date.now()}.tar.gz`);

    const writeStream = fs.createWriteStream(exportPath);
    stream.pipe(writeStream);

    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    return {
      message: 'Storage export completed',
      download: exportPath,
    };
  }

  @Post('storage/import')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Import storage files from tar.gz' })
  @ApiBody({ description: 'Path to tar.gz file to import' })
  @ApiResponse({ status: 200, description: 'Import result' })
  async importStorage(
    @Body() body: { filePath: string },
  ): Promise<{ imported: boolean; count: number; storageType: string }> {
    const { filePath } = body;

    // `filePath` is fully caller-controlled. Restrict it to the app's data
    // directory so it cannot point at arbitrary files on the host.
    const dataDir = path.join(process.cwd(), 'data');
    if (!filePath || !isPathWithin(dataDir, filePath)) {
      throw new BadRequestException('filePath must reference a file inside the data directory');
    }

    if (!fs.existsSync(filePath)) {
      throw new BadRequestException(`File not found: ${filePath}`);
    }

    const readStream = fs.createReadStream(filePath);
    const count = await this.storageService.importFromStream(readStream);

    return {
      imported: true,
      count,
      storageType: this.storageService.getCurrentStorageType(),
    };
  }
}
