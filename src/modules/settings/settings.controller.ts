import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { SettingsResponseDto } from './dto/settings-response.dto';
import { ConfigService } from '@nestjs/config';
import { RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { isSwaggerEnabled } from '../../config/bootstrap-security';
import { resolvePublicUrl } from '../../config/bind-host';

interface Settings {
  general: {
    apiBaseUrl: string;
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
        // The real advertised base URL (BASE_URL — the same value the startup banner and ingress URLs
        // use), not a hardcoded localhost guess that ignores the operator's configured host.
        apiBaseUrl: resolvePublicUrl(process.env.NODE_ENV, process.env.BASE_URL, port),
        // The engine auto-reconnects on a transient disconnect by default (there is no global off
        // switch; reconnection is bounded per-session by RECONNECT_MAX_ATTEMPTS). Reporting a hardcoded
        // `false` for a non-existent `engine.autoReconnect` key was actively misleading.
        autoReconnect: true,
        debugMode: this.configService.get<boolean>('database.logging', false),
      },
      api: {
        rateLimit: this.configService.get<number>('api.rateLimit.mediumLimit', 100),
        rateLimitWindow: this.configService.get<number>('api.rateLimit.mediumTtl', 60000),
        // Reflect the REAL ENABLE_SWAGGER gate (off by default in production), not a hardcoded `true`
        // — otherwise the panel reports docs enabled in production where they are actually disabled.
        enableDocs: isSwaggerEnabled(process.env.ENABLE_SWAGGER, process.env.NODE_ENV),
      },
      notifications: {
        emailEnabled: false,
        notificationEmail: '',
        webhookAlerts: true,
      },
    };
  }

  @Get()
  @RequireRole(ApiKeyRole.ADMIN)
  @RequireUnscopedKey()
  @ApiOperation({ summary: 'Get application settings' })
  @ApiResponse({ status: 200, description: 'Current settings', type: SettingsResponseDto })
  get(): Settings {
    // Settings expose environment-derived configuration (debug flag, reconnect policy, rate-limit
    // thresholds, base URL) that describes the deployment rather than any one session. Gate the read
    // at ADMIN and require an unrestricted key: the role check alone does not exclude a key confined
    // to specific sessions, which has no claim on deployment-wide configuration.
    return this.settings;
  }
}
