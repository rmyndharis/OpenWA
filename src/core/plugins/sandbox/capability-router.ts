import { ConversationSendEnvelope, PluginContext } from '../plugin.interfaces';

/** The subset of the plugin context a sandboxed plugin reaches across the bridge. */
export type CapabilityContext = Pick<PluginContext, 'messages' | 'engine' | 'storage' | 'net'> & {
  conversations: {
    send(env: ConversationSendEnvelope): Promise<unknown>;
  };
};

/**
 * Dispatch a worker-initiated capability `verb` to the live, permission-enforcing context the loader
 * built for this plugin. Allowlisted by design: only the verbs below are reachable, so a hostile
 * worker cannot invoke an arbitrary method on the context. Args are positional, one per signature.
 *
 * Permission + session-scope checks are NOT here — they live inside the context's own verbs
 * (assertPermission / assertSessionAllowed), so a sandboxed call is gated exactly like an in-process
 * one. This router is purely the wire-to-method mapping.
 */
export async function dispatchCapabilityVerb(
  context: CapabilityContext,
  verb: string,
  args: unknown[],
): Promise<unknown> {
  const s = (index: number): string => args[index] as string;
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
    default:
      throw new Error(`Unknown capability verb: ${verb}`);
  }
}
