import { z } from 'zod';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import type { LabelService } from '../../../modules/label/label.service';
import { defineTool, type AnyToolDescriptor } from '../tool-descriptor';

const sessionId = z.string().min(1).describe('Session UUID (the session id, not the name)');
const labelId = z.string().min(1).describe('Label id');
const chatId = z.string().min(1).describe('Chat JID, e.g. 628123456789@c.us or <id>@g.us');

/**
 * Labels are a WhatsApp Business feature, and the two engines split them almost exactly down the
 * middle: whatsapp-web.js can read labels but not edit them, Baileys can edit them but cannot read
 * them back. Each description says which, because an agent that does not know will read a `501` as
 * a transient failure and retry — and the retry cannot succeed on that engine.
 */
export function labelTools(labels: LabelService): AnyToolDescriptor[] {
  return [
    defineTool({
      name: 'LabelFindAll',
      description:
        'List every label on the account. WhatsApp Business only. Requires the whatsapp-web.js engine — ' +
        'Baileys exposes no label query at all and answers 501.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({ sessionId }),
      handler: input => labels.getLabels(input.sessionId),
    }),
    defineTool({
      name: 'LabelFindOne',
      description:
        'Get one label by id. Answers 404 when no label carries that id. WhatsApp Business only, and ' +
        'whatsapp-web.js only — Baileys answers 501.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({ sessionId, labelId }),
      handler: input => labels.getLabelById(input.sessionId, input.labelId),
    }),
    defineTool({
      name: 'LabelListChats',
      description:
        'List the chats carrying a label. Use it to answer "which conversations are tagged X". ' +
        'WhatsApp Business only, and whatsapp-web.js only — Baileys answers 501.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({ sessionId, labelId }),
      handler: input => labels.getChatsByLabel(input.sessionId, input.labelId),
    }),
    defineTool({
      name: 'LabelListForChat',
      description:
        'List the labels on one chat. WhatsApp Business only, and whatsapp-web.js only — Baileys answers 501.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({ sessionId, chatId }),
      handler: input => labels.getChatLabels(input.sessionId, input.chatId),
    }),
    defineTool({
      name: 'LabelUpsert',
      description:
        'Create or update a label. One operation on purpose: WhatsApp carries a single write keyed by the ' +
        'label id, so whether this creates or updates depends only on whether that id already exists — ' +
        'which is why the caller chooses the id. Requires the Baileys engine; whatsapp-web.js cannot edit ' +
        'labels and answers 501.',
      tier: 'write',
      sessionScoped: true,
      requiredRole: ApiKeyRole.OPERATOR,
      inputSchema: z.object({
        sessionId,
        labelId,
        name: z.string().min(1).max(100).optional().describe('Label text; left unchanged when omitted'),
        color: z
          .number()
          .int()
          .min(0)
          .max(19)
          .optional()
          .describe('WhatsApp colour index 0-19; left unchanged when omitted'),
      }),
      handler: input =>
        labels
          .upsertLabel(input.sessionId, input.labelId, { name: input.name, color: input.color })
          .then(() => ({ success: true })),
    }),
    defineTool({
      name: 'LabelDelete',
      description:
        'Delete a label from the account. This removes the label itself, not its use on one chat — use ' +
        'LabelRemoveFromChat for that. Requires the Baileys engine; whatsapp-web.js answers 501.',
      tier: 'write',
      sessionScoped: true,
      destructive: true,
      requiredRole: ApiKeyRole.OPERATOR,
      inputSchema: z.object({ sessionId, labelId }),
      handler: input => labels.deleteLabel(input.sessionId, input.labelId).then(() => ({ success: true })),
    }),
    defineTool({
      name: 'LabelAddToChat',
      description: 'Tag a chat with an existing label. Works on both engines. WhatsApp Business only.',
      tier: 'write',
      sessionScoped: true,
      requiredRole: ApiKeyRole.OPERATOR,
      inputSchema: z.object({ sessionId, chatId, labelId }),
      handler: input =>
        labels.addLabelToChat(input.sessionId, input.chatId, input.labelId).then(() => ({ success: true })),
    }),
    defineTool({
      name: 'LabelRemoveFromChat',
      description:
        'Remove a label from a chat, leaving the label itself in place. Works on both engines. ' +
        'WhatsApp Business only.',
      tier: 'write',
      sessionScoped: true,
      requiredRole: ApiKeyRole.OPERATOR,
      inputSchema: z.object({ sessionId, chatId, labelId }),
      handler: input =>
        labels.removeLabelFromChat(input.sessionId, input.chatId, input.labelId).then(() => ({ success: true })),
    }),
  ];
}
