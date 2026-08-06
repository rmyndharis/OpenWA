import { z } from 'zod';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import type { MessageService } from '../../../modules/message/message.service';
import { MESSAGE_TEXT_MAX_LENGTH } from '../../../modules/message/dto/send-message.dto';
import {
  CONTACT_NAME_MAX_LENGTH,
  CONTACT_NUMBER_MAX_LENGTH,
  LOCATION_TEXT_MAX_LENGTH,
  REACTION_EMOJI_MAX_LENGTH,
} from '../../../modules/message/dto/message-actions.dto';
import { defineTool, type AnyToolDescriptor } from '../tool-descriptor';

const sessionId = z.string().min(1).describe('Session UUID (the session id, not the name)');

export function messageTools(message: MessageService): AnyToolDescriptor[] {
  return [
    defineTool({
      name: 'MessageList',
      description:
        'List persisted messages for a session, optionally filtered by chatId or sender. Reads from the local DB.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().optional().describe('Filter to a specific chat JID'),
        from: z.string().optional().describe('Filter by sender phone or JID'),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      handler: input =>
        message.getMessages(input.sessionId, {
          chatId: input.chatId,
          from: input.from,
          limit: input.limit,
          offset: input.offset,
        }),
    }),
    defineTool({
      name: 'MessageHistory',
      description:
        'Fetch live chat history from WhatsApp for a specific chat. Bypasses the local DB — useful for messages that arrived before the gateway started.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID (e.g. 1234567890@c.us or groupId@g.us)'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe('Number of messages to fetch; without deep:true the engine caps at 100'),
        includeMedia: z.boolean().optional().describe('Download media as base64 (slower)'),
        deep: z.boolean().optional().describe('Raise limit ceiling to 2000 for reaching further back in history'),
      }),
      handler: input =>
        message.getChatHistory(input.sessionId, input.chatId, input.limit, input.includeMedia, input.deep),
    }),
    defineTool({
      name: 'MessageGetReactions',
      description: 'Get reactions for a specific message, including which contacts sent which emoji.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID containing the message'),
        messageId: z.string().describe('Message ID to get reactions for'),
      }),
      handler: input => message.getMessageReactions(input.sessionId, input.chatId, input.messageId),
    }),
    defineTool({
      name: 'MessageSendText',
      description: 'Send a plain text message to a chat or group. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID (e.g. 628123456789@c.us or groupId@g.us)'),
        text: z.string().min(1).max(4096).describe('Text message content'),
        linkPreview: z
          .boolean()
          .optional()
          .describe(
            'Set false to suppress the URL preview. Guaranteed only in that direction — leaving it ' +
              'unset means the engine default, and the engines differ.',
          ),
      }),
      handler: input =>
        message.sendText(input.sessionId, {
          chatId: input.chatId,
          text: input.text,
          ...(input.linkPreview === undefined ? {} : { linkPreview: input.linkPreview }),
        }),
    }),
    defineTool({
      name: 'MessageSendImage',
      description: 'Send an image message via URL or base64. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID'),
        url: z.string().url().optional().describe('Image URL (http/https)'),
        base64: z.string().optional().describe('Base64-encoded image data'),
        mimetype: z.string().optional().describe('MIME type (required when using base64)'),
        filename: z.string().max(255).optional(),
        caption: z.string().max(1024).optional(),
      }),
      handler: input =>
        message.sendImage(input.sessionId, {
          chatId: input.chatId,
          url: input.url,
          base64: input.base64,
          mimetype: input.mimetype,
          filename: input.filename,
          caption: input.caption,
        }),
    }),
    defineTool({
      name: 'MessageSendVideo',
      description: 'Send a video message via URL or base64. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID'),
        url: z.string().url().optional().describe('Video URL (http/https)'),
        base64: z.string().optional().describe('Base64-encoded video data'),
        mimetype: z.string().optional().describe('MIME type (required when using base64)'),
        filename: z.string().max(255).optional(),
        caption: z.string().max(1024).optional(),
      }),
      handler: input =>
        message.sendVideo(input.sessionId, {
          chatId: input.chatId,
          url: input.url,
          base64: input.base64,
          mimetype: input.mimetype,
          filename: input.filename,
          caption: input.caption,
        }),
    }),
    defineTool({
      name: 'MessageSendAudio',
      description: 'Send an audio/voice message via URL or base64. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID'),
        url: z.string().url().optional().describe('Audio URL (http/https)'),
        base64: z.string().optional().describe('Base64-encoded audio data'),
        mimetype: z.string().optional().describe('MIME type (required when using base64)'),
        filename: z.string().max(255).optional(),
        caption: z.string().max(1024).optional(),
        ptt: z.boolean().optional().describe('Send as a WhatsApp voice note (PTT)'),
      }),
      handler: input =>
        message.sendAudio(input.sessionId, {
          chatId: input.chatId,
          url: input.url,
          base64: input.base64,
          mimetype: input.mimetype,
          filename: input.filename,
          caption: input.caption,
          ptt: input.ptt,
        }),
    }),
    defineTool({
      name: 'MessageSendDocument',
      description: 'Send a document/file message via URL or base64. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID'),
        url: z.string().url().optional().describe('Document URL (http/https)'),
        base64: z.string().optional().describe('Base64-encoded document data'),
        mimetype: z.string().optional().describe('MIME type (required when using base64)'),
        filename: z.string().max(255).optional(),
        caption: z.string().max(1024).optional(),
      }),
      handler: input =>
        message.sendDocument(input.sessionId, {
          chatId: input.chatId,
          url: input.url,
          base64: input.base64,
          mimetype: input.mimetype,
          filename: input.filename,
          caption: input.caption,
        }),
    }),
    defineTool({
      name: 'MessageSendLocation',
      description: 'Send a location pin message. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID'),
        latitude: z.number().min(-90).max(90).describe('Latitude coordinate'),
        longitude: z.number().min(-180).max(180).describe('Longitude coordinate'),
        description: z.string().max(LOCATION_TEXT_MAX_LENGTH).optional().describe('Location label/description'),
        address: z.string().max(LOCATION_TEXT_MAX_LENGTH).optional().describe('Street address'),
      }),
      handler: input =>
        message.sendLocation(input.sessionId, {
          chatId: input.chatId,
          latitude: input.latitude,
          longitude: input.longitude,
          description: input.description,
          address: input.address,
        }),
    }),
    defineTool({
      name: 'MessageSendContact',
      description: 'Send a contact card message. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID'),
        contactName: z.string().min(1).max(CONTACT_NAME_MAX_LENGTH).describe('Display name of the contact to share'),
        contactNumber: z
          .string()
          .min(1)
          .max(CONTACT_NUMBER_MAX_LENGTH)
          .describe('Phone number of the contact to share'),
      }),
      handler: input =>
        message.sendContact(input.sessionId, {
          chatId: input.chatId,
          contactName: input.contactName,
          contactNumber: input.contactNumber,
        }),
    }),
    defineTool({
      name: 'MessageSendSticker',
      description: 'Send a sticker message via URL or base64. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID'),
        url: z.string().url().optional().describe('Sticker URL (http/https)'),
        base64: z.string().optional().describe('Base64-encoded sticker data'),
        mimetype: z.string().optional().describe('MIME type (required when using base64)'),
        filename: z.string().max(255).optional(),
        caption: z.string().max(1024).optional(),
      }),
      handler: input =>
        message.sendSticker(input.sessionId, {
          chatId: input.chatId,
          url: input.url,
          base64: input.base64,
          mimetype: input.mimetype,
          filename: input.filename,
          caption: input.caption,
        }),
    }),
    defineTool({
      name: 'MessageSendTemplate',
      description:
        'Render a stored text template and send it as a text message. Provide either templateId or templateName. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID'),
        templateId: z.string().optional().describe('Template UUID'),
        templateName: z.string().optional().describe('Template name slug'),
        vars: z
          .record(z.string(), z.string())
          .optional()
          .describe('Variables to substitute into {{placeholder}} tokens'),
      }),
      handler: input =>
        message.sendTemplate(input.sessionId, {
          chatId: input.chatId,
          templateId: input.templateId,
          templateName: input.templateName,
          vars: input.vars,
        }),
    }),
    defineTool({
      name: 'MessageReply',
      description: 'Reply to a specific message (quoted reply). Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID'),
        quotedMessageId: z.string().describe('ID of the message to quote/reply to'),
        text: z.string().min(1).max(MESSAGE_TEXT_MAX_LENGTH).describe('Reply text content'),
      }),
      handler: input =>
        message.reply(input.sessionId, {
          chatId: input.chatId,
          quotedMessageId: input.quotedMessageId,
          text: input.text,
        }),
    }),
    defineTool({
      name: 'MessageForward',
      description: 'Forward a message from one chat to another. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        fromChatId: z.string().describe('Source chat JID'),
        toChatId: z.string().describe('Destination chat JID'),
        messageId: z.string().describe('ID of the message to forward'),
      }),
      handler: input =>
        message.forward(input.sessionId, {
          fromChatId: input.fromChatId,
          toChatId: input.toChatId,
          messageId: input.messageId,
        }),
    }),
    defineTool({
      name: 'MessageReact',
      description:
        'Add or remove a reaction emoji on a message. Send empty string emoji to remove. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().describe('Chat JID containing the message'),
        messageId: z.string().describe('ID of the message to react to'),
        emoji: z
          .string()
          .max(REACTION_EMOJI_MAX_LENGTH)
          .describe('Emoji to react with. Empty string removes the reaction.'),
      }),
      handler: input =>
        message
          .reactToMessage(input.sessionId, { chatId: input.chatId, messageId: input.messageId, emoji: input.emoji })
          .then(() => ({ success: true })),
    }),
  ];
}
