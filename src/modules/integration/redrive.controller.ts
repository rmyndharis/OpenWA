import { Controller, Param, Post } from '@nestjs/common';
import { RedriveService } from './redrive.service';

// NOT @Public — this is an operator action guarded by the global ApiKeyGuard (X-API-Key header).
@Controller('integration/instances')
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
