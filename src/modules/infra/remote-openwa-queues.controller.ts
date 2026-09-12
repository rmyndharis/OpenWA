import { Controller, Get, ForbiddenException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireRole, RequireUnscopedKey, CurrentApiKey } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { AuthService } from '../auth/auth.service';
import { RemoteOpenWaQueuesService } from './remote-openwa-queues.service';

@ApiTags('admin')
@Controller('admin/openwa-remote-queues')
@RequireUnscopedKey()
export class RemoteOpenWaQueuesController {
  constructor(
    private readonly remoteQueues: RemoteOpenWaQueuesService,
    private readonly authService: AuthService,
  ) {}

  @Get()
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Proxy remote OpenWA queue depths (server-side credentials)' })
  async getStatus(@CurrentApiKey() apiKey: ApiKey) {
    if (!this.authService.canAccessOpenWaRemoteQueues(apiKey)) {
      throw new ForbiddenException('Admin or companion operator role required');
    }
    return this.remoteQueues.getStatus();
  }
}
