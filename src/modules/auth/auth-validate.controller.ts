import { Controller, Post, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader } from '@nestjs/swagger';
import { CurrentApiKey } from './decorators/auth.decorators';
import { ApiKey } from './entities/api-key.entity';
import { ValidateApiKeyResponseDto } from './dto';
import { EngineFactory } from '../../engine/engine.factory';
import { apiKeyDeniedCapabilities, ApiKeyCapability } from './api-key-permissions';

@ApiTags('auth')
@Controller('auth')
export class AuthValidateController {
  constructor(private readonly engineFactory: EngineFactory) {}

  @Post('validate')
  // The key's own self-check names no data surface, so any capability-scoped key may use it.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate an API key' })
  @ApiHeader({ name: 'X-API-Key', description: 'API key to validate' })
  @ApiResponse({ status: 200, description: 'API key is valid', type: ValidateApiKeyResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid or missing API key' })
  @ApiResponse({
    status: 403,
    description:
      'The key is valid but refused here: its allowedIps exclude this client, or it is restricted to selected chats',
  })
  validate(@CurrentApiKey() apiKey?: ApiKey): {
    valid: boolean;
    role?: string;
    engineType?: string;
    scoped?: boolean;
    deniedPermissions?: ApiKeyCapability[];
  } {
    // This route is behind the global API-key guard, so only a validated key reaches this handler
    // (a missing/invalid key 401s first). The guard has already verified the key — including its
    // client-IP and session-scope restrictions — and attached it to the request. Re-validating here
    // would repeat that work without the client IP, double-counting usage and, for an IP-restricted
    // key, failing closed (no IP) and wrongly reporting valid:false. So we trust the guard's result.
    // The valid:false branch is unreachable in normal operation; it's retained as defense-in-depth in
    // case the guard config ever changes, keeping the endpoint safe to expose directly.
    if (!apiKey) {
      return { valid: false };
    }
    // The engine rides along because GET /infra/engines/current is admin-only, and the dashboard needs
    // it for every role that can post a status or read channels. `scoped` lets it skip the routes that
    // refuse a session-scoped key (@RequireUnscopedKey) instead of sending reads the guard rejects.
    return {
      valid: true,
      role: apiKey.role,
      engineType: this.engineFactory.getCurrentEngine(),
      scoped: (apiKey.allowedSessions?.length ?? 0) > 0,
      deniedPermissions: apiKeyDeniedCapabilities(apiKey),
    };
  }
}
