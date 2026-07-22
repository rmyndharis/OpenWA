import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AgentContextService, AgentContextV1 } from './agent-context.service';

/**
 * This controller is registered only when AGENT_CONTEXT_ENABLED=true. It has one GET operation and
 * intentionally does not share MessageController/MessageService, which own broad history and sends.
 * The global ApiKeyGuard scopes the `:sessionId` parameter against a key's allowedSessions list.
 */
@ApiTags('agent-context')
@Controller('sessions/:sessionId/agent-context')
export class AgentContextController {
  constructor(private readonly agentContextService: AgentContextService) {}

  @Get('messages/:messageId')
  @ApiOperation({ summary: 'Get a bounded read-only context for one inbound message' })
  @ApiParam({ name: 'sessionId', description: 'WhatsApp session ID; enforced against API-key session scope.' })
  @ApiParam({ name: 'messageId', description: 'Persisted incoming message UUID.' })
  @ApiResponse({ status: 200, description: 'Bounded v1 agent context.' })
  @ApiResponse({ status: 400, description: 'The selected message is not incoming.' })
  @ApiResponse({ status: 404, description: 'The message is absent from this session, or the feature is disabled.' })
  getMessageContext(
    @Param('sessionId') sessionId: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<AgentContextV1> {
    return this.agentContextService.getMessageContext(sessionId, messageId);
  }
}
