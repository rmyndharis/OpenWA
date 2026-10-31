import { ConflictException, Controller, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiTags, ApiResponse } from '@nestjs/swagger';
import { CurrentApiKey, RequireRole } from '../auth/decorators/auth.decorators';
import { type ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { sessionScopeVisible } from '../../common/security/session-scope';
import { PluginInstanceService } from './plugin-instance.service';
import { RedriveService } from './redrive.service';
import { RedriveResultDto } from './dto/instance.dto';

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
    type: RedriveResultDto,
  })
  @ApiResponse({
    status: 404,
    description: "Session-restricted key: the instance does not exist or is bound outside the key's allowedSessions.",
  })
  @ApiResponse({
    status: 409,
    description: 'The instance is disabled or deleted; its dead-lettered deliveries cannot be re-dispatched.',
  })
  async redriveInstance(
    @Param('pluginId') pluginId: string,
    @Param('instanceId') instanceId: string,
    @CurrentApiKey() apiKey?: ApiKey,
  ): Promise<{ redriven: number; remaining: number; batchSize: number }> {
    // Session-scoped keys may only redrive instances bound inside their own fence; an out-of-scope
    // instance answers 404 (same as a missing one) so redrive can't be used to probe other sessions.
    // A MISSING instance row is refused too: its retained DLQ rows still carry the deleted instance's
    // sessionId and would be re-dispatched unscoped.
    const inst = await this.instances.resolve(pluginId, instanceId);
    const scoped = (apiKey?.allowedSessions?.length ?? 0) > 0;
    if (scoped && (!inst || !sessionScopeVisible(apiKey?.allowedSessions, inst.sessionScope))) {
      throw new NotFoundException('instance not found');
    }
    // Dispatch refuses a deleted or disabled instance, so every replayed row would only fail again. A
    // queued replay still counts as redriven and retires its DLQ row before the job fails, which would
    // report success for deliveries that are then dead-lettered anew. Refuse up front instead; re-enable
    // the instance first to replay its backlog.
    if (!inst || inst.enabled === false) {
      throw new ConflictException(
        `instance ${instanceId} of plugin ${pluginId} is ${inst ? 'disabled' : 'deleted'}; its dead-lettered deliveries cannot be redriven`,
      );
    }
    // Thread the instance's CURRENT binding down as the DLQ provenance filter, for every key. Retained DLQ
    // rows still carry the sessionId of whatever binding wrote them; without this filter a rebind
    // sess-old -> sess-current lets a sess-current key replay historical sess-old rows, and lets an
    // unrestricted key replay them too, although dispatch refuses a delivery of an earlier binding, so
    // each would be retired here and dead-lettered again. The binding is read from the PERSISTED instance
    // (not the request body).
    const result = await this.redrive.redriveInstance(pluginId, instanceId, inst.sessionScope);
    // A redrive can trigger real downstream sends, so every successful batch is audited with its
    // outcome counts (no payload content — the DLQ rows themselves hold those).
    void this.audit.logInfo(AuditAction.INTEGRATION_INSTANCE_REDRIVEN, {
      metadata: { pluginId, instanceId, redriven: result.redriven, remaining: result.remaining },
    });
    return result;
  }
}
