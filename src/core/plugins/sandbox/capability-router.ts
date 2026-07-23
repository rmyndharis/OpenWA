import { ConversationSendEnvelope, PluginContext } from '../plugin.interfaces';
import { HandoverState } from '../../../modules/integration/entities/conversation-mapping.entity';

/** The subset of the plugin context a sandboxed plugin reaches across the bridge. */
export type CapabilityContext = Pick<PluginContext, 'messages' | 'engine' | 'storage' | 'net'> & {
  conversations: {
    send(env: ConversationSendEnvelope): Promise<unknown>;
  };
  handover: {
    set(key: { sessionId: string; chatId: string; instanceId: string }, state: HandoverState): Promise<unknown>;
  };
  mappings: {
    upsert(
      key: { sessionId: string; chatId: string; instanceId: string },
      providerConversationId: string,
    ): Promise<unknown>;
    get(key: { sessionId: string; chatId: string; instanceId: string }): Promise<unknown>;
    getByProvider(instanceId: string, providerConversationId: string): Promise<unknown>;
  };
};

/**
 * Dispatch a worker-initiated capability `verb` to the live, permission-enforcing context the loader
 * built for this plugin. Allowlisted by design: only the verbs below are reachable, so a hostile
 * worker cannot invoke an arbitrary method on the context. Args are positional, one per signature.
 *
 * Permission + session-scope checks are NOT here — they live inside the context's own verbs
 * (assertPermission / assertSessionActive), so a sandboxed call is gated exactly like an in-process
 * one. This router is purely the wire-to-method mapping.
 */
export async function dispatchCapabilityVerb(
  context: CapabilityContext,
  verb: string,
  args: unknown[],
): Promise<unknown> {
  // Worker args cross a trust boundary: validate here so a malformed RPC fails the calling plugin
  // with a clear error instead of reaching the ORM with undefined criteria (TypeORM 1.x throws on
  // those, and older versions silently DROPPED them — matching rows it should never have matched).
  const s = (index: number): string => {
    const v = args[index];
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`Capability ${verb}: argument ${index} must be a non-empty string`);
    }
    return v;
  };
  const mappingKey = (index: number): { sessionId: string; chatId: string; instanceId: string } => {
    const k = args[index] as { sessionId?: unknown; chatId?: unknown; instanceId?: unknown } | null | undefined;
    if (!k || [k.sessionId, k.chatId, k.instanceId].some(v => typeof v !== 'string' || v.length === 0)) {
      throw new Error(`Capability ${verb}: argument ${index} must be { sessionId, chatId, instanceId } strings`);
    }
    return k as { sessionId: string; chatId: string; instanceId: string };
  };
  switch (verb) {
    case 'messages.sendText':
      return context.messages.sendText(s(0), s(1), s(2));
    case 'messages.reply':
      return context.messages.reply(s(0), s(1), s(2), s(3));
    case 'engine.getGroupInfo':
      return context.engine.getGroupInfo(s(0), s(1));
    case 'engine.getContacts':
      return context.engine.getContacts(s(0));
    case 'engine.getContactById':
      return context.engine.getContactById(s(0), s(1));
    case 'engine.checkNumberExists':
      return context.engine.checkNumberExists(s(0), s(1));
    case 'engine.getChats':
      return context.engine.getChats(s(0));
    case 'engine.getChatHistory':
      return context.engine.getChatHistory(s(0), s(1), args[2] as number | undefined, args[3] as boolean | undefined);
    case 'engine.canonicalChatId':
      return context.engine.canonicalChatId(s(0), s(1));
    case 'storage.get':
      return context.storage.get(s(0));
    case 'storage.set':
      return context.storage.set(s(0), args[1]);
    case 'storage.delete':
      return context.storage.delete(s(0));
    case 'storage.list':
      return context.storage.list(args[0] as string | undefined);
    case 'net.fetch':
      return context.net.fetch(s(0), args[1] as Parameters<typeof context.net.fetch>[1]);
    case 'conversation.send':
      return context.conversations.send(args[0] as ConversationSendEnvelope);
    case 'handover.set':
      return context.handover.set(mappingKey(0), args[1] as HandoverState);
    case 'mappings.upsert':
      return context.mappings.upsert(mappingKey(0), s(1));
    case 'mappings.get':
      return context.mappings.get(mappingKey(0));
    case 'mappings.getByProvider':
      return context.mappings.getByProvider(s(0), s(1));
    default:
      throw new Error(`Unknown capability verb: ${verb}`);
  }
}
