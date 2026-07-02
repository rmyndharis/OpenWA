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
}

const MESSAGE_HOOK_EVENTS = ['message:sending'];

export function buildConversationSendFacade(deps: ConversationSendDeps) {
  return {
    async send(env: ConversationSendEnvelope): Promise<unknown> {
      deps.assertPermission(deps.manifest, PluginCapabilityPermission.CONVERSATION_SEND);
      const sessionId = env.sessionId;
      if (!sessionId) throw new PluginCapabilityError('conversation.send: sessionId is required');
      deps.assertSessionActive(sessionId);
      const chatId = env.chatId ?? (await deps.resolveChatId(env));
      // Only text/reply are wired in P0; media types are additive in a later minor.
      return deps.runGuarded(MESSAGE_HOOK_EVENTS, async () => {
        if (env.replyTo) {
          return deps.reply(sessionId, { chatId, quotedMessageId: env.replyTo, text: env.text ?? '' });
        }
        return deps.sendText(sessionId, { chatId, text: env.text ?? '' });
      });
    },
  };
}
