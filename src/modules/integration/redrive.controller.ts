import { Controller, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiTags, ApiResponse } from '@nestjs/swagger';
import { CurrentApiKey, RequireRole } from '../auth/decorators/auth.decorators';
import { type ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { sessionScopeVisible } from '../../common/security/session-scope';
import { PluginInstanceService } from './plugin-instance.service';
import { RedriveService } from './redrive.service';

// Re-dispatching DLQ'd inbound payloads can cause real downstream sends, so this operator action is
// ADMIN-gated — matching the sibling IntegrationInstanceController. (A bare API key, even VIEWER,
// must NOT be able to trigger it.)
@ApiTags('integration')
@Controller('integration/instances')
@RequireRole(ApiKeyRole.ADMIN)
export class RedriveController {
  constructor(
    private readonly redrive: RedriveService,
    private readonly instances: PluginInstanceService,
  ) {}

  @Post(':pluginId/:instanceId/redrive')
  @ApiResponse({
    status: 201,
    description: 'One bounded batch of dead-lettered ingress deliveries re-dispatched, with remaining depth.',
  })
  async redriveInstance(
    @Param('pluginId') pluginId: string,
    @Param('instanceId') instanceId: string,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<{ redriven: number; remaining: number; batchSize: number }> {
    // Session-scoped keys may only redrive instances bound inside their own fence; an out-of-scope
    // instance answers 404 (same as a missing one) so redrive can't be used to probe other sessions.
    const inst = await this.instances.resolve(pluginId, instanceId);
    if (inst && !sessionScopeVisible(apiKey?.allowedSessions, inst.sessionScope)) {
      throw new NotFoundException('instance not found');
    }
    return this.redrive.redriveInstance(pluginId, instanceId);
  }
}
