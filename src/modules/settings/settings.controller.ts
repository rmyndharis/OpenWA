import { Controller, Get, Put, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiSecurity } from '@nestjs/swagger';
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
@ApiSecurity('X-API-Key')
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
  @ApiOperation({ summary: 'Update application settings' })
  @ApiResponse({ status: 200, description: 'Settings updated' })
  update(@Body() newSettings: Partial<Settings>): Settings {
    if (newSettings.general) {
      this.settings.general = {
        ...this.settings.general,
        ...newSettings.general,
      };
    }
    if (newSettings.api) {
      this.settings.api = { ...this.settings.api, ...newSettings.api };
    }
    if (newSettings.notifications) {
      this.settings.notifications = {
        ...this.settings.notifications,
        ...newSettings.notifications,
      };
    }
    return this.settings;
  }
}
