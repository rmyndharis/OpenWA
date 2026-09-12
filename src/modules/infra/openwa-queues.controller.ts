import { Controller, Get, ForbiddenException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireRole, RequireUnscopedKey, CurrentApiKey } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { AuthService } from '../auth/auth.service';
import { OpenWaQueuesService } from './openwa-queues.service';

@ApiTags('admin')
@Controller('admin/openwa-queues')
@RequireUnscopedKey()
export class OpenWaQueuesController {
  constructor(
    private readonly queues: OpenWaQueuesService,
    private readonly authService: AuthService,
  ) {}

  @Get()
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Same-instance OpenWA queue depths (session API key)' })
  async getStatus(@CurrentApiKey() apiKey: ApiKey) {
    if (!this.authService.canAccessOpenWaQueues(apiKey)) {
      throw new ForbiddenException('Admin or companion operator role required');
    }
    return this.queues.getStatus();
  }
}
