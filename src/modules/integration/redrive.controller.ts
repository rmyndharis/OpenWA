import { Controller, Param, Post } from '@nestjs/common';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { RedriveService } from './redrive.service';

// Re-dispatching DLQ'd inbound payloads can cause real downstream sends, so this operator action is
// ADMIN-gated — matching the sibling IntegrationInstanceController. (A bare API key, even VIEWER,
// must NOT be able to trigger it.)
@Controller('integration/instances')
@RequireRole(ApiKeyRole.ADMIN)
export class RedriveController {
  constructor(private readonly redrive: RedriveService) {}

  @Post(':pluginId/:instanceId/redrive')
  redriveInstance(
    @Param('pluginId') pluginId: string,
    @Param('instanceId') instanceId: string,
  ): Promise<{ redriven: number }> {
    return this.redrive.redriveInstance(pluginId, instanceId);
  }
}
