import {
  ConversationSendEnvelope,
  PluginCapabilityError,
  PluginCapabilityPermission,
  PluginManifest,
} from './plugin.interfaces';

export interface ConversationSendDeps {
  manifest: PluginManifest;
  assertPermission: (manifest: PluginManifest, permission: string) => void;
  // Full session gate for THIS plugin (manifest scope AND operator activation), bound to the plugin by
  // the loader — so conversation.send is confined to activated sessions like every other capability.
  assertSessionActive: (sessionId: string) => void;
  // Resolve the WA chat id from conversation_mappings when the envelope omits chatId.
  resolveChatId: (env: ConversationSendEnvelope) => Promise<string>;
  // Seed the hook in-flight set so an adapter's own outbound message:sending hook cannot echo-loop
  // back into this same send. Only 'message:sending' is reachable this way — MessageService fires it
  // synchronously inside sendText/reply. 'message:sent' is emitted later by SessionService's engine
  // callback (onMessageCreate), outside this call's async scope, so seeding it here would be a no-op.
  runGuarded: <T>(events: string[], run: () => Promise<T>) => Promise<T>;
  sendText: (sessionId: string, opts: { chatId: string; text: string }) => Promise<unknown>;
  reply: (sessionId: string, opts: { chatId: string; quotedMessageId: string; text: string }) => Promise<unknown>;
  // Media send by URL. The loader binds this to the per-type MessageService media methods
  // (sendImage/sendVideo/sendAudio/sendDocument) — the facade stays DTO-agnostic.
  sendMedia: (
    sessionId: string,
    opts: { chatId: string; url: string; type: ConversationMediaType; caption?: string },
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
        return deps.sendText(sessionId, { chatId, text: env.text ?? '' });
      });
    },
  };
}
