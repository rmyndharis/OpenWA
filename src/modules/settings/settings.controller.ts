import { Controller, Get, Put, NotImplementedException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

interface Settings {
  general: {
    apiBaseUrl: string;
    sessionTimeout: number;
    autoReconnect: boolean;
    debugMode: boolean;
  };
  api: {
    rateLimit: number;
    rateLimitWindow: number;
    enableDocs: boolean;
  };
  notifications: {
    emailEnabled: boolean;
    notificationEmail: string;
    webhookAlerts: boolean;
  };
}

@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  private settings: Settings;

  constructor(private readonly configService: ConfigService) {
    // Initialize with values from configuration (reads from .env)
    const port = this.configService.get<number>('port', 2785);

    this.settings = {
      general: {
        apiBaseUrl: `http://localhost:${port}`,
        sessionTimeout: Math.floor(this.configService.get<number>('webhook.timeout', 300000) / 60000),
        autoReconnect: this.configService.get<boolean>('engine.autoReconnect', false),
        debugMode: this.configService.get<boolean>('database.logging', false),
      },
      api: {
        rateLimit: this.configService.get<number>('api.rateLimit.mediumLimit', 100),
        rateLimitWindow: this.configService.get<number>('api.rateLimit.mediumTtl', 60000),
        enableDocs: true, // Swagger docs always enabled
      },
      notifications: {
        emailEnabled: false,
        notificationEmail: '',
        webhookAlerts: true,
      },
    };
  }

  @Get()
  @ApiOperation({ summary: 'Get application settings' })
  @ApiResponse({ status: 200, description: 'Current settings' })
  get(): Settings {
    return this.settings;
  }

  @Put()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Settings are read-only at runtime (environment-derived)' })
  @ApiResponse({
    status: 501,
    description: 'Settings are derived from environment configuration and cannot be changed at runtime',
  })
  update(): never {
    // Every Settings field is derived from environment variables and consumed at boot /
    // decorator-evaluation time (ThrottlerModule.forRootAsync, port, webhook timeout, DB logging),
    // and ConfigService is immutable at runtime — so a runtime write cannot actually take effect.
    // The previous handler mutated an in-memory copy and returned 200 'updated' while persisting
    // nothing and applying nothing: a false success. Be honest instead of pretending it worked.
    throw new NotImplementedException(
      'Settings are derived from environment configuration and are read-only at runtime. ' +
        'Change the corresponding environment variable and restart the service.',
    );
  }
}
