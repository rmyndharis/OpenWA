import { z } from 'zod';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import type { WebhookService } from '../../../modules/webhook/webhook.service';
import { WebhookResponseDto } from '../../../modules/webhook/dto/webhook.dto';
import type { ToolDescriptor } from '../tool-descriptor';

const sessionId = z.string().min(1).describe('Session UUID (the session id, not the name)');

export function webhookTools(webhook: WebhookService): ToolDescriptor[] {
  return [
    {
      name: 'WebhooksList',
      description: 'List all webhooks the API key is allowed to see, across all its accessible sessions.',
      tier: 'read',
      requiredRole: ApiKeyRole.OPERATOR,
      inputSchema: z.object({}),
      handler: (_input, apiKey) =>
        webhook.findAll(apiKey.allowedSessions).then(ws => WebhookResponseDto.fromEntities(ws)),
    },
    {
      name: 'WebhookFindBySession',
      description: 'List all webhooks registered for a specific session.',
      tier: 'read',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({ sessionId }),
      handler: (input: { sessionId: string }) =>
        webhook.findBySession(input.sessionId).then(ws => WebhookResponseDto.fromEntities(ws)),
    },
    {
      name: 'WebhookFindOne',
      description: 'Get details for a specific webhook by ID within a session.',
      tier: 'read',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        webhookId: z.string().describe('Webhook UUID'),
      }),
      handler: (input: { sessionId: string; webhookId: string }) =>
        webhook.findOne(input.sessionId, input.webhookId).then(w => WebhookResponseDto.fromEntity(w)),
    },
  ];
}
