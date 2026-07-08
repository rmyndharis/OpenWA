import { Controller, Get, Put, NotImplementedException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { isSwaggerEnabled } from '../../config/bootstrap-security';

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
        // The real advertised base URL (BASE_URL — the same value the startup banner and ingress URLs
        // use), not a hardcoded localhost guess that ignores the operator's configured host.
        apiBaseUrl: process.env.BASE_URL || `http://localhost:${port}`,
        sessionTimeout: Math.floor(this.configService.get<number>('webhook.timeout', 300000) / 60000),
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
  @ApiOperation({ summary: 'Get application settings' })
  @ApiResponse({ status: 200, description: 'Current settings' })
  get(): Settings {
    // Settings expose environment-derived configuration (debug flag, reconnect policy, rate-limit
    // thresholds, base URL). Gate the read at ADMIN, matching the PUT below and the rest of the
    // admin-config surface — a VIEWER or session-scoped key has no business reading server config.
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
