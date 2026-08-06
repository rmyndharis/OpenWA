import {
  ConversationSendEnvelope,
  PluginCapabilityError,
  PluginCapabilityPermission,
  PluginManifest,
} from './plugin.interfaces';

export interface ConversationSendDeps {
  manifest: PluginManifest;
  assertPermission: (manifest: PluginManifest, permission: PluginCapabilityPermission) => void;
  // Full session gate for THIS plugin (manifest scope AND operator activation), bound to the plugin by
  // the loader — so conversation.send is confined to activated sessions like every other capability.
  assertSessionActive: (sessionId: string) => void;
  // Resolve the WA chat id from conversation_mappings when the envelope omits chatId.
  resolveChatId: (env: ConversationSendEnvelope) => Promise<string>;
  // Seed the hook in-flight set so an adapter's own outbound message:sending hook cannot echo-loop
  // back into this same send. Only 'message:sending' is reachable this way — MessageService fires it
  // synchronously inside sendText/reply. 'message:sent' is emitted later by SessionEngineLifecycle's
  // engine callback (onMessageCreate), outside this call's async scope, so seeding it here would be a no-op.
  runGuarded: <T>(events: string[], run: () => Promise<T>) => Promise<T>;
  sendText: (sessionId: string, opts: { chatId: string; text: string; linkPreview?: boolean }) => Promise<unknown>;
  reply: (sessionId: string, opts: { chatId: string; quotedMessageId: string; text: string }) => Promise<unknown>;
  // Media send by URL. The loader binds this to the per-type MessageService media methods
  // (sendImage/sendVideo/sendAudio/sendDocument) — the facade stays DTO-agnostic.
  sendMedia: (
    sessionId: string,
    opts: { chatId: string; url: string; type: ConversationMediaType; caption?: string },
  ) => Promise<unknown>;
  // Location send. The loader binds this to MessageService.sendLocation; `text` maps to the description.
  sendLocation: (
    sessionId: string,
    opts: { chatId: string; latitude: number; longitude: number; description?: string },
  ) => Promise<unknown>;
}

/**
 * Envelope types carried as media by URL. `voice` is a PTT audio note (the loader maps it to an audio
 * send with `ptt`). `location` is a non-text type but has no mediaUrl, so it is excluded.
 */
export type ConversationMediaType = 'image' | 'file' | 'audio' | 'video' | 'voice';

const MEDIA_TYPES: readonly ConversationMediaType[] = ['image', 'file', 'audio', 'video', 'voice'];

const isMediaType = (type: ConversationSendEnvelope['type']): type is ConversationMediaType =>
  (MEDIA_TYPES as readonly string[]).includes(type);

const isValidLatitude = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
const isValidLongitude = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;

const MESSAGE_HOOK_EVENTS = ['message:sending'];

export function buildConversationSendFacade(deps: ConversationSendDeps) {
  return {
    async send(env: ConversationSendEnvelope): Promise<unknown> {
      deps.assertPermission(deps.manifest, PluginCapabilityPermission.CONVERSATION_SEND);
      const sessionId = env.sessionId;
      if (!sessionId) throw new PluginCapabilityError('conversation.send: sessionId is required');
      deps.assertSessionActive(sessionId);
      const chatId = env.chatId ?? (await deps.resolveChatId(env));
      return deps.runGuarded(MESSAGE_HOOK_EVENTS, async () => {
        // A location envelope is delivered as a native location pin. Without valid coordinates there
        // is NOTHING to send — reject loudly instead of degrading to an empty text message.
        if (env.type === 'location') {
          // The engine location path cannot quote a message, so a location reply is not expressible.
          // Reject rather than silently drop the quote (same rule as media).
          if (env.replyTo) {
            throw new PluginCapabilityError('conversation.send: replyTo is not supported for location messages');
          }
          if (!isValidLatitude(env.latitude) || !isValidLongitude(env.longitude)) {
            throw new PluginCapabilityError(
              'conversation.send: type location requires latitude (-90..90) and longitude (-180..180)',
            );
          }
          return deps.sendLocation(sessionId, {
            chatId,
            latitude: env.latitude,
            longitude: env.longitude,
            description: env.text,
          });
        }
        // A media type carrying a mediaUrl is sent as native media. A media type WITHOUT a mediaUrl has
        // nothing to send as media, so it falls through to the text/reply path — a plugin that puts the
        // URL in `text` as a fallback still delivers a (text) message rather than erroring.
        if (isMediaType(env.type) && env.mediaUrl) {
          // The engine media path takes only (chatId, media) — it cannot quote a message, so a media
          // reply is not expressible. Reject rather than silently drop the quote.
          if (env.replyTo) {
            throw new PluginCapabilityError('conversation.send: replyTo is not supported for media messages');
          }
          return deps.sendMedia(sessionId, { chatId, url: env.mediaUrl, type: env.type, caption: env.text });
        }
        if (env.replyTo) {
          return deps.reply(sessionId, { chatId, quotedMessageId: env.replyTo, text: env.text ?? '' });
        }
        // Forwarded only when the plugin actually expressed a choice: MessageService widens the engine
        // call whenever the key is present, so a blanket `linkPreview: undefined` would rewrite the call
        // shape of every plugin send that never asked for a preview.
        return deps.sendText(sessionId, {
          chatId,
          text: env.text ?? '',
          ...(env.linkPreview === undefined ? {} : { linkPreview: env.linkPreview }),
        });
      });
    },
  };
}
