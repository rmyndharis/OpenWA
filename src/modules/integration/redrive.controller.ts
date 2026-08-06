import { Controller, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiTags, ApiResponse } from '@nestjs/swagger';
import { CurrentApiKey, RequireRole } from '../auth/decorators/auth.decorators';
import { type ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
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
    private readonly audit: AuditService,
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
    // A MISSING instance row is refused too: its retained DLQ rows still carry the deleted instance's
    // sessionId and would be re-dispatched unscoped. Only an unrestricted key may drain those.
    const inst = await this.instances.resolve(pluginId, instanceId);
    const scoped = (apiKey?.allowedSessions?.length ?? 0) > 0;
    if (scoped && (!inst || !sessionScopeVisible(apiKey?.allowedSessions, inst.sessionScope))) {
      throw new NotFoundException('instance not found');
    }
    // Thread the authorized binding down as an explicit DLQ provenance filter. A scoped key is
    // authorized against the instance's CURRENT sessionScope, but retained DLQ rows still carry the
    // sessionId of whatever binding wrote them; without this filter a rebind sess-old -> sess-current
    // lets a sess-current key replay historical sess-old rows. The filter is derived from the
    // PERSISTED current instance (not the request body), and null means an unrestricted caller may
    // drain every retained row — never undefined, which would silently fail open.
    const sessionIdFilter = scoped ? inst!.sessionScope : null;
    const result = await this.redrive.redriveInstance(pluginId, instanceId, sessionIdFilter);
    // A redrive can trigger real downstream sends, so every successful batch is audited with its
    // outcome counts (no payload content — the DLQ rows themselves hold those).
    void this.audit.logInfo(AuditAction.INTEGRATION_INSTANCE_REDRIVEN, {
      metadata: { pluginId, instanceId, redriven: result.redriven, remaining: result.remaining },
    });
    return result;
  }
}
