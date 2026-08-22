import { Controller, HttpCode, HttpStatus, Optional, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { SessionService } from '../session/session.service';
import { ShutdownService } from '../../common/services/shutdown.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { InfraDrainResponseDto } from './dto/infra-response.dto';
import { createLogger } from '../../common/services/logger.service';

/**
 * Node-level lifecycle verbs — the operator surface for taking THIS process out of a fleet without
 * killing it. Distinct from InfraConfigController's restart, which is about applying saved config;
 * a drain is about handing sessions to peers before a scale-down or maintenance window.
 */
@ApiTags('infrastructure')
@Controller('infra')
export class InfraNodeController {
  private readonly logger = createLogger('InfraNodeController');

  constructor(
    private readonly sessionService: SessionService,
    private readonly shutdownService: ShutdownService,
    @Optional()
    private readonly auditService?: AuditService,
  ) {}

  @Post('drain')
  @HttpCode(HttpStatus.OK)
  @RequireRole(ApiKeyRole.ADMIN)
  // Deployment-global: draining tears down EVERY session on the node, so a key scoped to a subset
  // of sessions must not reach it.
  @RequireUnscopedKey()
  @ApiOperation({
    summary: 'Drain this node: stop hosting sessions and hand them to peers via lease lapse',
    description:
      'Flips readiness to 503, tears down every local engine, stops lease renewal and forgets the claims ' +
      'WITHOUT clearing them, so peer nodes adopt the sessions once the leases lapse (within the lease TTL ' +
      'plus one takeover sweep). One-way for this process — terminate or restart it afterwards. In-flight ' +
      'HTTP requests keep being served while the load balancer reacts to the readiness change.',
  })
  @ApiResponse({ status: 200, description: 'Node drained', type: InfraDrainResponseDto })
  async drain(): Promise<InfraDrainResponseDto> {
    // Readiness flips FIRST so the LB starts pulling the node while the engines shut down; the
    // flag also stops the takeover sweep, which must not adopt anything mid-drain. markShuttingDown
    // (not shutdown()) — no exit is scheduled, the orchestrator owns process termination.
    this.shutdownService.markShuttingDown();
    this.logger.log('Drain requested — readiness flipped, tearing down local engines');

    const result = await this.sessionService.drain();

    await this.auditService?.logInfo(AuditAction.INFRA_NODE_DRAINED, {
      metadata: { ...result },
    });

    return {
      message: 'Node drained. Peers adopt the abandoned sessions once their leases lapse.',
      draining: true,
      ...result,
    };
  }
}
