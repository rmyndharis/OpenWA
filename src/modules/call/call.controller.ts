import { Controller, Post, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { CallService } from './call.service';
import { RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('calls')
@Controller('sessions/:sessionId/calls')
export class CallController {
  constructor(private readonly callService: CallService) {}

  @Post(':callId/reject')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a ringing incoming call' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiParam({ name: 'callId', description: 'Call ID from the call.received event' })
  @ApiResponse({ status: 200, description: 'Call rejected' })
  @ApiResponse({ status: 400, description: 'Session is not started' })
  @ApiResponse({ status: 404, description: 'Call not found or no longer ringing' })
  async reject(@Param('sessionId') sessionId: string, @Param('callId') callId: string) {
    await this.callService.rejectCall(sessionId, callId);
    return { success: true };
  }
}
