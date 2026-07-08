import { Controller, Param, Post } from '@nestjs/common';
import { ApiTags, ApiResponse } from '@nestjs/swagger';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { RedriveService } from './redrive.service';

// Re-dispatching DLQ'd inbound payloads can cause real downstream sends, so this operator action is
// ADMIN-gated — matching the sibling IntegrationInstanceController. (A bare API key, even VIEWER,
// must NOT be able to trigger it.)
@ApiTags('integration')
@Controller('integration/instances')
@RequireRole(ApiKeyRole.ADMIN)
export class RedriveController {
  constructor(private readonly redrive: RedriveService) {}

  @Post(':pluginId/:instanceId/redrive')
  @ApiResponse({
    status: 201,
    description: 'Dead-lettered ingress deliveries for the instance re-dispatched. Returns the count redriven.',
  })
  redriveInstance(
    @Param('pluginId') pluginId: string,
    @Param('instanceId') instanceId: string,
  ): Promise<{ redriven: number }> {
    return this.redrive.redriveInstance(pluginId, instanceId);
  }
}
