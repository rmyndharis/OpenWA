import { NotImplementedException } from '@nestjs/common';
import { z } from 'zod';
import { isMediaUrl, MEDIA_URL_MESSAGE } from '../../../common/media/media-url';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import { stripBase64DataUri } from '../../../modules/message/media-cap.util';
import type { MessageService } from '../../../modules/message/message.service';
import { runIdempotentSend } from '../../../modules/message/idempotency/run-idempotent-send';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
  type SendIdempotencyService,
} from '../../../modules/message/idempotency/send-idempotency.service';
import {
  CHAT_ID_MAX_LENGTH,
  CUSTOM_PREVIEW_DESCRIPTION_MAX_LENGTH,
  CUSTOM_PREVIEW_TITLE_MAX_LENGTH,
  CUSTOM_PREVIEW_URL_MAX_LENGTH,
  MEDIA_CAPTION_MAX_LENGTH,
  MEDIA_FILENAME_MAX_LENGTH,
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
import { MessageDirection } from '../../../modules/message/entities/message.entity';
import { MESSAGE_REFERENCE_MAX_LENGTH, MESSAGE_TYPE_MAX_LENGTH } from '../../../modules/message/message-window';
import { chatIdSchema, chatJidSchema } from '../chat-id-schema';
import { defineTool, refuseUnknownArguments, type AnyToolDescriptor } from '../tool-descriptor';

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

const mediaUrl = (label: string) => z.string().optional().describe(`${label} URL (http/https)`);

/** The filters of the REST message list. Its service validates them again, so these only bound the input. */
const MESSAGE_CURSOR_MAX_LENGTH = 128;
const messageTimeSchema = z.number().min(0).max(Number.MAX_SAFE_INTEGER).optional();

/**
 * The same media url rule as the REST routes: both engines fetch only a string that starts with
 * http(s):// and decode anything else as base64, so any other value would go out as garbage bytes.
 * It is checked with the whole body, as the REST DTO does: base64 that holds data wins, so a url left
 * next to it (often an empty string from an agent filling every optional field) is neither fetched nor
 * an error.
 */
const hasValidMediaUrl = (input: { url?: string; base64?: string }): boolean =>
  !!stripBase64DataUri(input.base64) || input.url === undefined || isMediaUrl(input.url);

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
const customLinkPreviewSchema = refuseUnknownArguments(
  z.object({
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
    thumbnailUrl: z
      .string()
      .optional()
      .describe('Preview image URL (http/https), fetched under the media SSRF rules; renders the large card.'),
    thumbnailBase64: z
      .string()
      .optional()
      .describe('Preview image as base64, at most 5 MiB decoded. Wins over thumbnailUrl.'),
  }),
)
  .refine(p => hasValidMediaUrl({ url: p.thumbnailUrl, base64: p.thumbnailBase64 }), {
    error: MEDIA_URL_MESSAGE,
    path: ['thumbnailUrl'],
  })
  .optional()
  .describe(
    'Attach a preview you supply instead of one fetched from the URL, so the page is not fetched and ' +
      'it works for a URL the gateway cannot reach. Only an optional thumbnail image is fetched. ' +
      'Baileys only: whatsapp-web.js answers 501.',
  );

/**
 * Mirrors the REST `linkPreview` field of the two routes that carry text (send-text, send-template). The engines
 * differ, and the description is all an agent has to go on: whatsapp-web.js builds a preview by default, Baileys
 * only when it is asked to.
 */
const linkPreviewSchema = z
  .boolean()
  .optional()
  .describe(
    'Controls the URL preview, and the engines differ. whatsapp-web.js builds one by default and false ' +
      'suppresses it. On Baileys a preview is opt-in: true fetches the page and attaches one, while unset or ' +
      'false sends none.',
  );

/**
 * The optional field of the send tools whose REST routes take an `Idempotency-Key` header, with the same key
 * syntax. It is declared on each of those schemas, so an agent reads it in the published input, and acted on by
 * withSendIdempotency below.
 */
const idempotencyKeySchema = z
  .string()
  .max(IDEMPOTENCY_KEY_MAX_LENGTH)
  .regex(IDEMPOTENCY_KEY_PATTERN, 'must be 1-255 visible ASCII characters')
  .optional()
  .describe(
    'Makes the send safe to retry: pass a string that is unique to this intended send. A retry with the same ' +
      'key and the same arguments returns the first result and sends nothing. The same key with other arguments ' +
      'is refused, and so is a retry while the first call still runs or after a failure that may have sent the ' +
      'message (check the chat, then send again with a new key). A key lasts 24 hours and belongs to its session.',
  );

/** The tools that carry `idempotencyKey`: the REST send routes with an `Idempotency-Key` header, minus poll. */
const SEND_IDEMPOTENT_TOOLS: ReadonlySet<string> = new Set([
  'MessageSendText',
  'MessageSendImage',
  'MessageSendVideo',
  'MessageSendAudio',
  'MessageSendDocument',
  'MessageSendLocation',
  'MessageSendContact',
  'MessageSendSticker',
  'MessageSendTemplate',
  'MessageReply',
  'MessageForward',
]);

/**
 * Run a send tool under its `idempotencyKey`, as SendIdempotencyInterceptor does for the REST route. It runs
 * inside the handler, so the key is claimed only after the invoker has authorized the call and validated its
 * input, and the handler never sees the key. The route is the tool name, so a key used over REST does not match
 * a tool call and is refused as reused, not replayed. A call without a key runs untouched; with a key and no
 * store the call is refused, never sent unclaimed.
 */
function withSendIdempotency(tool: AnyToolDescriptor, store: SendIdempotencyService | undefined): AnyToolDescriptor {
  return {
    ...tool,
    handler: async (input, apiKey, chatScope, signal) => {
      const { idempotencyKey, ...rest } = input as { sessionId: string; idempotencyKey?: string };
      if (idempotencyKey === undefined) return tool.handler(rest as never, apiKey, chatScope, signal);
      if (!store) throw new NotImplementedException('Idempotent sends are not available on this server.');
      const { body } = await runIdempotentSend(
        store,
        { sessionId: rest.sessionId, key: idempotencyKey, route: `mcp:${tool.name}`, body: rest },
        () => tool.handler(rest as never, apiKey, chatScope, signal),
      );
      return body;
    },
  };
}

export function messageTools(message: MessageService, idempotency?: SendIdempotencyService): AnyToolDescriptor[] {
  const tools: AnyToolDescriptor[] = [
    defineTool({
      name: 'MessageList',
      chatScope: ['chatId'],
      description:
        'List persisted messages for a session, newest first, optionally filtered by chatId, sender, direction, ' +
        'type, message time or an exact message reference. Reads from the local DB. Page with limit and offset, or ' +
        'walk with after (the id of the last message of the previous page) so a message arriving mid-walk cannot ' +
        'shift the window. A message with media carries it inline as base64, up to a per-response budget ' +
        '(8 MiB by default), which makes a result large; pass inlineMedia false to get the rows without the media.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().max(CHAT_ID_MAX_LENGTH).optional().describe('Filter to a specific chat JID'),
        from: z.string().max(CHAT_ID_MAX_LENGTH).optional().describe('Filter by sender phone or JID'),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
        after: z
          .string()
          .max(MESSAGE_CURSOR_MAX_LENGTH)
          .optional()
          .describe('Keyset cursor: the id of the last message of the previous page. Takes precedence over offset.'),
        since: messageTimeSchema.describe('Inclusive message-time lower bound, Unix epoch milliseconds.'),
        until: messageTimeSchema.describe('Exclusive message-time upper bound, Unix epoch milliseconds.'),
        direction: z.enum(MessageDirection).optional().describe('Only incoming or only outgoing messages.'),
        type: z
          .string()
          .max(MESSAGE_TYPE_MAX_LENGTH)
          .optional()
          .describe('Exact stored message type token, e.g. text, image or voice.'),
        orderBy: z
          .enum(['createdAt', 'timestamp'])
          .optional()
          .describe(
            'Newest first either way. createdAt (default) is the order the gateway stored them in; timestamp is ' +
              'the time on the message and leaves out rows with no known timestamp.',
          ),
        messageId: z
          .string()
          .max(MESSAGE_REFERENCE_MAX_LENGTH)
          .optional()
          .describe('Exact WhatsApp message reference; the lookup stays inside the session and chat filters.'),
        inlineMedia: z
          .boolean()
          .optional()
          .describe(
            'Set false to leave inline media payloads out: each media row then keeps an { omitted, sizeBytes } ' +
              'marker. Media is only available inline over MCP, so leave it unset when you need the bytes.',
          ),
      }),
      handler: ({ sessionId, after, inlineMedia, ...filters }) =>
        message.getMessages(sessionId, {
          ...filters,
          // REST reads a blank cursor as absent, and an agent often fills every optional field.
          after: after?.trim() || undefined,
          ...(inlineMedia === undefined ? {} : { inlineMedia }),
        }),
    }),
    defineTool({
      name: 'MessageHistory',
      chatScope: ['chatId'],
      description:
        'Fetch live chat history from WhatsApp for a specific chat. Bypasses the local DB — useful for messages that arrived before the gateway started. ' +
        'Requires the whatsapp-web.js engine; Baileys answers 501 and a retry cannot succeed, so use MessageList for stored messages.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: chatIdSchema.describe('Chat JID (e.g. 1234567890@c.us or groupId@g.us)'),
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
      handler: (input, _apiKey, _chatScope, signal) =>
        message.getChatHistory(input.sessionId, input.chatId, input.limit, input.includeMedia, input.deep, signal),
    }),
    defineTool({
      name: 'MessageGetReactions',
      chatScope: ['chatId'],
      description:
        'Get reactions for a specific message, including which contacts sent which emoji. ' +
        'Requires the whatsapp-web.js engine; Baileys answers 501 and a retry cannot succeed.',
      tier: 'read',
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: chatIdSchema.describe('Chat JID containing the message'),
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
        chatId: chatJidSchema.describe('Chat JID (e.g. 628123456789@c.us or groupId@g.us)'),
        text: z.string().min(1).max(MESSAGE_TEXT_MAX_LENGTH).describe('Text message content'),
        linkPreview: linkPreviewSchema,
        quotedMessageId: quotedMessageIdSchema,
        mentions: mentionsSchema,
        customLinkPreview: customLinkPreviewSchema,
        idempotencyKey: idempotencyKeySchema,
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
      inputSchema: z
        .object({
          sessionId,
          chatId: chatJidSchema.describe('Chat JID'),
          url: mediaUrl('Image'),
          base64: z.string().optional().describe('Base64-encoded image data'),
          mimetype: z.string().optional().describe('MIME type (required when using base64)'),
          filename: z.string().max(MEDIA_FILENAME_MAX_LENGTH).optional(),
          caption: z.string().max(MEDIA_CAPTION_MAX_LENGTH).optional(),
          quotedMessageId: quotedMessageIdSchema,
          mentions: mentionsSchema,
          idempotencyKey: idempotencyKeySchema,
        })
        .refine(hasValidMediaUrl, { error: MEDIA_URL_MESSAGE, path: ['url'] }),
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
      inputSchema: z
        .object({
          sessionId,
          chatId: chatJidSchema.describe('Chat JID'),
          url: mediaUrl('Video'),
          base64: z.string().optional().describe('Base64-encoded video data'),
          mimetype: z.string().optional().describe('MIME type (required when using base64)'),
          filename: z.string().max(MEDIA_FILENAME_MAX_LENGTH).optional(),
          caption: z.string().max(MEDIA_CAPTION_MAX_LENGTH).optional(),
          quotedMessageId: quotedMessageIdSchema,
          mentions: mentionsSchema,
          idempotencyKey: idempotencyKeySchema,
        })
        .refine(hasValidMediaUrl, { error: MEDIA_URL_MESSAGE, path: ['url'] }),
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
      inputSchema: z
        .object({
          sessionId,
          chatId: chatJidSchema.describe('Chat JID'),
          url: mediaUrl('Audio'),
          base64: z.string().optional().describe('Base64-encoded audio data'),
          mimetype: z.string().optional().describe('MIME type (required when using base64)'),
          filename: z.string().max(MEDIA_FILENAME_MAX_LENGTH).optional(),
          caption: z.string().max(MEDIA_CAPTION_MAX_LENGTH).optional(),
          ptt: z.boolean().optional().describe('Send as a WhatsApp voice note (PTT)'),
          quotedMessageId: quotedMessageIdSchema,
          mentions: mentionsSchema,
          idempotencyKey: idempotencyKeySchema,
        })
        .refine(hasValidMediaUrl, { error: MEDIA_URL_MESSAGE, path: ['url'] }),
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
      inputSchema: z
        .object({
          sessionId,
          chatId: chatJidSchema.describe('Chat JID'),
          url: mediaUrl('Document'),
          base64: z.string().optional().describe('Base64-encoded document data'),
          mimetype: z.string().optional().describe('MIME type (required when using base64)'),
          filename: z.string().max(MEDIA_FILENAME_MAX_LENGTH).optional(),
          caption: z.string().max(MEDIA_CAPTION_MAX_LENGTH).optional(),
          quotedMessageId: quotedMessageIdSchema,
          mentions: mentionsSchema,
          idempotencyKey: idempotencyKeySchema,
        })
        .refine(hasValidMediaUrl, { error: MEDIA_URL_MESSAGE, path: ['url'] }),
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
        chatId: chatJidSchema.describe('Chat JID'),
        latitude: z.number().min(-90).max(90).describe('Latitude coordinate'),
        longitude: z.number().min(-180).max(180).describe('Longitude coordinate'),
        description: z.string().max(LOCATION_TEXT_MAX_LENGTH).optional().describe('Location label/description'),
        address: z.string().max(LOCATION_TEXT_MAX_LENGTH).optional().describe('Street address'),
        quotedMessageId: quotedMessageIdSchema,
        idempotencyKey: idempotencyKeySchema,
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
        chatId: chatJidSchema.describe('Chat JID'),
        contactName: z.string().min(1).max(CONTACT_NAME_MAX_LENGTH).describe('Display name of the contact to share'),
        contactNumber: z
          .string()
          .min(1)
          .max(CONTACT_NUMBER_MAX_LENGTH)
          .describe('Phone number of the contact to share'),
        quotedMessageId: quotedMessageIdSchema,
        idempotencyKey: idempotencyKeySchema,
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
      inputSchema: z
        .object({
          sessionId,
          chatId: chatJidSchema.describe('Chat JID'),
          url: mediaUrl('Sticker'),
          base64: z.string().optional().describe('Base64-encoded sticker data'),
          mimetype: z.string().optional().describe('MIME type (required when using base64)'),
          filename: z.string().max(MEDIA_FILENAME_MAX_LENGTH).optional(),
          caption: z.string().max(MEDIA_CAPTION_MAX_LENGTH).optional(),
          quotedMessageId: quotedMessageIdSchema,
          mentions: mentionsSchema,
          idempotencyKey: idempotencyKeySchema,
        })
        .refine(hasValidMediaUrl, { error: MEDIA_URL_MESSAGE, path: ['url'] }),
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
        chatId: chatJidSchema.describe('Chat JID'),
        templateId: z.string().optional().describe('Template UUID'),
        templateName: z.string().optional().describe('Template name slug'),
        vars: z
          .record(z.string(), z.string())
          .optional()
          .describe('Variables to substitute into {{placeholder}} tokens'),
        mentions: mentionsSchema,
        linkPreview: linkPreviewSchema,
        idempotencyKey: idempotencyKeySchema,
      }),
      handler: input =>
        message.sendTemplate(input.sessionId, {
          chatId: input.chatId,
          templateId: input.templateId,
          templateName: input.templateName,
          vars: input.vars,
          mentions: input.mentions,
          ...(input.linkPreview === undefined ? {} : { linkPreview: input.linkPreview }),
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
        chatId: chatJidSchema.describe('Chat JID'),
        quotedMessageId: z.string().min(1).describe('ID of the message to quote/reply to'),
        text: z.string().min(1).max(MESSAGE_TEXT_MAX_LENGTH).describe('Reply text content'),
        mentions: mentionsSchema,
        idempotencyKey: idempotencyKeySchema,
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
        fromChatId: chatJidSchema.describe('Source chat JID'),
        toChatId: chatJidSchema.describe('Destination chat JID'),
        messageId: z.string().min(1).describe('ID of the message to forward'),
        idempotencyKey: idempotencyKeySchema,
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
        chatId: chatJidSchema.describe('Chat JID containing the message'),
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

  return tools.map(tool => (SEND_IDEMPOTENT_TOOLS.has(tool.name) ? withSendIdempotency(tool, idempotency) : tool));
}
