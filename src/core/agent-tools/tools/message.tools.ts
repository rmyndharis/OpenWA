import { z } from 'zod';
import { isMediaUrl, MEDIA_URL_MESSAGE } from '../../../common/media/media-url';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import type { MessageService } from '../../../modules/message/message.service';
import {
  CUSTOM_PREVIEW_DESCRIPTION_MAX_LENGTH,
  CUSTOM_PREVIEW_TITLE_MAX_LENGTH,
  CUSTOM_PREVIEW_URL_MAX_LENGTH,
  MENTIONS_MAX,
  MENTION_WID_MAX_LENGTH,
  MESSAGE_TEXT_MAX_LENGTH,
} from '../../../modules/message/dto/send-message.dto';
import { isMentionWid } from '../../../modules/message/dto/is-mention-wid.validator';
import {
  CONTACT_NAME_MAX_LENGTH,
  CONTACT_NUMBER_MAX_LENGTH,
  LOCATION_TEXT_MAX_LENGTH,
  REACTION_EMOJI_MAX_LENGTH,
} from '../../../modules/message/dto/message-actions.dto';
import { defineTool, type AnyToolDescriptor } from '../tool-descriptor';

const sessionId = z.string().min(1).describe('Session UUID (the session id, not the name)');

/**
 * Mirrors the REST `quotedMessageId` field so an agent can reply with media, a location, a contact
 * card or a poll — the same capability, on the same endpoints, through the MCP surface.
 */
const quotedMessageIdSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Quote an earlier message, making this send a reply. Engine-specific: whatsapp-web.js takes ' +
      'the serialized message id, Baileys the raw key id of a message it has already stored.',
  );

/**
 * The same media url rule as the REST routes: both engines fetch only a string that starts with
 * http(s):// and decode anything else as base64, so any other value would go out as garbage bytes.
 */
const mediaUrl = (label: string) =>
  z.string().refine(isMediaUrl, { error: MEDIA_URL_MESSAGE }).optional().describe(`${label} URL (http/https)`);

/**
 * Mirrors the REST `mentions` field. The element rule and both caps come from the DTO rather than
 * being restated here: a tool handler calls the service directly, so the ValidationPipe never runs
 * and this schema is the only thing standing between an agent and the engine.
 */
const mentionsSchema = z
  .array(z.string().max(MENTION_WID_MAX_LENGTH).refine(isMentionWid, 'must be an individual WID, e.g. 62811@c.us'))
  .max(MENTIONS_MAX)
  .optional()
  .describe(
    'WIDs to @mention (e.g. ["62811@c.us"]). The text or caption must also carry the matching ' +
      '@<number> token for WhatsApp to render the tag.',
  );

/**
 * Mirrors the REST `customLinkPreview` field, whose caps come from the DTO for the same reason as
 * `mentionsSchema` above. Baileys only: whatsapp-web.js takes a boolean and answers 501, and the
 * field cannot be combined with `linkPreview: false`, which asks for the opposite.
 */
const customLinkPreviewSchema = z
  .object({
    url: z
      .string()
      .min(1)
      .max(CUSTOM_PREVIEW_URL_MAX_LENGTH)
      .describe('The URL as it appears in the message text; WhatsApp anchors the preview to it.'),
    title: z
      .string()
      .min(1)
      .max(CUSTOM_PREVIEW_TITLE_MAX_LENGTH)
      .describe('Required: WhatsApp renders no preview without a title.'),
    description: z.string().max(CUSTOM_PREVIEW_DESCRIPTION_MAX_LENGTH).optional(),
  })
  .optional()
  .describe(
    'Attach a preview you supply instead of one fetched from the URL, so nothing is fetched and it ' +
      'works for a URL the gateway cannot reach. Baileys only: whatsapp-web.js answers 501.',
  );

export function messageTools(message: MessageService): AnyToolDescriptor[] {
  return [
    defineTool({
      name: 'MessageList',
      chatScope: ['chatId'],
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
      chatScope: ['chatId'],
      description:
        'Fetch live chat history from WhatsApp for a specific chat. Bypasses the local DB — useful for messages that arrived before the gateway started.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().min(1).describe('Chat JID (e.g. 1234567890@c.us or groupId@g.us)'),
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
      chatScope: ['chatId'],
      description: 'Get reactions for a specific message, including which contacts sent which emoji.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().min(1).describe('Chat JID containing the message'),
        messageId: z.string().min(1).describe('Message ID to get reactions for'),
      }),
      handler: input => message.getMessageReactions(input.sessionId, input.chatId, input.messageId),
    }),
    defineTool({
      name: 'MessageSendText',
      chatScope: ['chatId'],
      description: 'Send a plain text message to a chat or group. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().min(1).describe('Chat JID (e.g. 628123456789@c.us or groupId@g.us)'),
        text: z.string().min(1).max(MESSAGE_TEXT_MAX_LENGTH).describe('Text message content'),
        linkPreview: z
          .boolean()
          .optional()
          .describe(
            'Set false to suppress the URL preview. Guaranteed only in that direction — leaving it ' +
              'unset means the engine default, and the engines differ.',
          ),
        quotedMessageId: quotedMessageIdSchema,
        mentions: mentionsSchema,
        customLinkPreview: customLinkPreviewSchema,
      }),
      handler: input =>
        message.sendText(input.sessionId, {
          chatId: input.chatId,
          text: input.text,
          ...(input.linkPreview === undefined ? {} : { linkPreview: input.linkPreview }),
          quotedMessageId: input.quotedMessageId,
          mentions: input.mentions,
          customLinkPreview: input.customLinkPreview,
        }),
    }),
    defineTool({
      name: 'MessageSendImage',
      chatScope: ['chatId'],
      description: 'Send an image message via URL or base64. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().min(1).describe('Chat JID'),
        url: mediaUrl('Image'),
        base64: z.string().optional().describe('Base64-encoded image data'),
        mimetype: z.string().optional().describe('MIME type (required when using base64)'),
        filename: z.string().max(255).optional(),
        caption: z.string().max(1024).optional(),
        quotedMessageId: quotedMessageIdSchema,
        mentions: mentionsSchema,
      }),
      handler: input =>
        message.sendImage(input.sessionId, {
          chatId: input.chatId,
          url: input.url,
          base64: input.base64,
          mimetype: input.mimetype,
          filename: input.filename,
          caption: input.caption,
          quotedMessageId: input.quotedMessageId,
          mentions: input.mentions,
        }),
    }),
    defineTool({
      name: 'MessageSendVideo',
      chatScope: ['chatId'],
      description: 'Send a video message via URL or base64. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().min(1).describe('Chat JID'),
        url: mediaUrl('Video'),
        base64: z.string().optional().describe('Base64-encoded video data'),
        mimetype: z.string().optional().describe('MIME type (required when using base64)'),
        filename: z.string().max(255).optional(),
        caption: z.string().max(1024).optional(),
        quotedMessageId: quotedMessageIdSchema,
        mentions: mentionsSchema,
      }),
      handler: input =>
        message.sendVideo(input.sessionId, {
          chatId: input.chatId,
          url: input.url,
          base64: input.base64,
          mimetype: input.mimetype,
          filename: input.filename,
          caption: input.caption,
          quotedMessageId: input.quotedMessageId,
          mentions: input.mentions,
        }),
    }),
    defineTool({
      name: 'MessageSendAudio',
      chatScope: ['chatId'],
      description: 'Send an audio/voice message via URL or base64. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().min(1).describe('Chat JID'),
        url: mediaUrl('Audio'),
        base64: z.string().optional().describe('Base64-encoded audio data'),
        mimetype: z.string().optional().describe('MIME type (required when using base64)'),
        filename: z.string().max(255).optional(),
        caption: z.string().max(1024).optional(),
        ptt: z.boolean().optional().describe('Send as a WhatsApp voice note (PTT)'),
        quotedMessageId: quotedMessageIdSchema,
        mentions: mentionsSchema,
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
          quotedMessageId: input.quotedMessageId,
          mentions: input.mentions,
        }),
    }),
    defineTool({
      name: 'MessageSendDocument',
      chatScope: ['chatId'],
      description: 'Send a document/file message via URL or base64. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().min(1).describe('Chat JID'),
        url: mediaUrl('Document'),
        base64: z.string().optional().describe('Base64-encoded document data'),
        mimetype: z.string().optional().describe('MIME type (required when using base64)'),
        filename: z.string().max(255).optional(),
        caption: z.string().max(1024).optional(),
        quotedMessageId: quotedMessageIdSchema,
        mentions: mentionsSchema,
      }),
      handler: input =>
        message.sendDocument(input.sessionId, {
          chatId: input.chatId,
          url: input.url,
          base64: input.base64,
          mimetype: input.mimetype,
          filename: input.filename,
          caption: input.caption,
          quotedMessageId: input.quotedMessageId,
          mentions: input.mentions,
        }),
    }),
    defineTool({
      name: 'MessageSendLocation',
      chatScope: ['chatId'],
      description: 'Send a location pin message. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().min(1).describe('Chat JID'),
        latitude: z.number().min(-90).max(90).describe('Latitude coordinate'),
        longitude: z.number().min(-180).max(180).describe('Longitude coordinate'),
        description: z.string().max(LOCATION_TEXT_MAX_LENGTH).optional().describe('Location label/description'),
        address: z.string().max(LOCATION_TEXT_MAX_LENGTH).optional().describe('Street address'),
        quotedMessageId: quotedMessageIdSchema,
      }),
      handler: input =>
        message.sendLocation(input.sessionId, {
          chatId: input.chatId,
          latitude: input.latitude,
          longitude: input.longitude,
          description: input.description,
          address: input.address,
          quotedMessageId: input.quotedMessageId,
        }),
    }),
    defineTool({
      name: 'MessageSendContact',
      chatScope: ['chatId'],
      description: 'Send a contact card message. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().min(1).describe('Chat JID'),
        contactName: z.string().min(1).max(CONTACT_NAME_MAX_LENGTH).describe('Display name of the contact to share'),
        contactNumber: z
          .string()
          .min(1)
          .max(CONTACT_NUMBER_MAX_LENGTH)
          .describe('Phone number of the contact to share'),
        quotedMessageId: quotedMessageIdSchema,
      }),
      handler: input =>
        message.sendContact(input.sessionId, {
          chatId: input.chatId,
          contactName: input.contactName,
          contactNumber: input.contactNumber,
          quotedMessageId: input.quotedMessageId,
        }),
    }),
    defineTool({
      name: 'MessageSendSticker',
      chatScope: ['chatId'],
      description: 'Send a sticker message via URL or base64. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().min(1).describe('Chat JID'),
        url: mediaUrl('Sticker'),
        base64: z.string().optional().describe('Base64-encoded sticker data'),
        mimetype: z.string().optional().describe('MIME type (required when using base64)'),
        filename: z.string().max(255).optional(),
        caption: z.string().max(1024).optional(),
        quotedMessageId: quotedMessageIdSchema,
        mentions: mentionsSchema,
      }),
      handler: input =>
        message.sendSticker(input.sessionId, {
          chatId: input.chatId,
          url: input.url,
          base64: input.base64,
          mimetype: input.mimetype,
          filename: input.filename,
          caption: input.caption,
          quotedMessageId: input.quotedMessageId,
          mentions: input.mentions,
        }),
    }),
    defineTool({
      name: 'MessageSendTemplate',
      chatScope: ['chatId'],
      description:
        'Render a stored text template and send it as a text message. Provide either templateId or templateName. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().min(1).describe('Chat JID'),
        templateId: z.string().optional().describe('Template UUID'),
        templateName: z.string().optional().describe('Template name slug'),
        vars: z
          .record(z.string(), z.string())
          .optional()
          .describe('Variables to substitute into {{placeholder}} tokens'),
        mentions: mentionsSchema,
      }),
      handler: input =>
        message.sendTemplate(input.sessionId, {
          chatId: input.chatId,
          templateId: input.templateId,
          templateName: input.templateName,
          vars: input.vars,
          mentions: input.mentions,
        }),
    }),
    defineTool({
      name: 'MessageReply',
      chatQuotedAllowed: true,
      chatScope: ['chatId'],
      description: 'Reply to a specific message (quoted reply). Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().min(1).describe('Chat JID'),
        quotedMessageId: z.string().min(1).describe('ID of the message to quote/reply to'),
        text: z.string().min(1).max(MESSAGE_TEXT_MAX_LENGTH).describe('Reply text content'),
        mentions: mentionsSchema,
      }),
      handler: input =>
        message.reply(input.sessionId, {
          chatId: input.chatId,
          quotedMessageId: input.quotedMessageId,
          text: input.text,
          mentions: input.mentions,
        }),
    }),
    defineTool({
      name: 'MessageForward',
      chatScope: ['fromChatId', 'toChatId'],
      description: 'Forward a message from one chat to another. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        fromChatId: z.string().min(1).describe('Source chat JID'),
        toChatId: z.string().min(1).describe('Destination chat JID'),
        messageId: z.string().min(1).describe('ID of the message to forward'),
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
      chatScope: ['chatId'],
      description:
        'Add or remove a reaction emoji on a message. Send empty string emoji to remove. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().min(1).describe('Chat JID containing the message'),
        messageId: z.string().min(1).describe('ID of the message to react to'),
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
