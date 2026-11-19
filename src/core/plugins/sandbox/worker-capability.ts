import { WorkerToHostMessage, HostToWorkerMessage, SANDBOX_MAX_PENDING_CAPS, SANDBOX_MAX_HELD_CAPS } from './protocol';
import { hookConfigStore } from './worker-hooks';
import { ConversationSendEnvelope } from '../plugin.interfaces';
import { HandoverState } from '../../../modules/integration/entities/conversation-mapping.entity';

interface Waiter {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface Call {
  verb: string;
  args: unknown[];
  inFlight?: string[];
  waiter: Waiter;
}

/**
 * Worker-side correlation for capability calls. Each `call` posts a `cap` request and resolves when
 * the host's matching `cap-result` arrives. The mirror of the host's PluginWorkerHost correlation.
 *
 * At most SANDBOX_MAX_PENDING_CAPS calls are unanswered at once. A call made while that many are waiting
 * is held, and posted in the order it was made as each reply frees a slot: a loop that does not await its
 * calls then hands the host a bounded number of messages, and no call is refused until
 * SANDBOX_MAX_HELD_CAPS are held.
 */
export class WorkerCapabilityClient {
  private nextId = 1;
  private readonly pending = new Map<number, Waiter>();
  // Calls waiting for a slot, oldest first. Never non-empty while a slot is free: handleResult fills a slot at once.
  private readonly held: Call[] = [];

  constructor(private readonly post: (message: WorkerToHostMessage) => void) {}

  call(verb: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      // Read now: a held call is posted from handleResult, which runs outside the hook dispatch that made it.
      const call: Call = { verb, args, inFlight: hookConfigStore.getStore()?.inFlight, waiter: { resolve, reject } };
      if (this.pending.size < SANDBOX_MAX_PENDING_CAPS) {
        this.send(call);
        return;
      }
      if (this.held.length >= SANDBOX_MAX_HELD_CAPS) {
        reject(new Error(`capability call rejected: too many held capability calls (limit ${SANDBOX_MAX_HELD_CAPS})`));
        return;
      }
      try {
        // postMessage copies the args when it is called; a call posted later must send them as they are now.
        // An uncloneable arg throws here, rejecting this call before it takes a place in the queue.
        call.args = structuredClone(args);
        this.held.push(call);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  handleResult(message: Extract<HostToWorkerMessage, { kind: 'cap-result' }>): void {
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new Error(message.error));
    // The slot goes to the call that has waited longest. A call that cannot be posted takes none, so the next one tries.
    while (this.held.length > 0 && this.pending.size < SANDBOX_MAX_PENDING_CAPS) this.send(this.held.shift()!);
  }

  private send({ verb, args, inFlight, waiter }: Call): void {
    const id = this.nextId++;
    try {
      // Post before registering: an uncloneable arg throws here (rejecting this call alone), and an entry
      // registered first would never be removed, since no cap-result can come back for it.
      this.post(inFlight ? { kind: 'cap', id, verb, args, inFlight } : { kind: 'cap', id, verb, args });
      this.pending.set(id, waiter);
    } catch (error) {
      waiter.reject(error);
    }
  }
}

/** The capability surface a sandboxed plugin sees — every method round-trips to the host. */
export interface SandboxCapabilityContext {
  messages: {
    sendText(sessionId: string, chatId: string, text: string): Promise<unknown>;
    reply(sessionId: string, chatId: string, quotedMessageId: string, text: string): Promise<unknown>;
  };
  engine: {
    getGroupInfo(sessionId: string, groupId: string): Promise<unknown>;
    getContacts(sessionId: string): Promise<unknown>;
    getContactById(sessionId: string, contactId: string): Promise<unknown>;
    checkNumberExists(sessionId: string, phone: string): Promise<unknown>;
    getChats(sessionId: string): Promise<unknown>;
    getChatHistory(sessionId: string, chatId: string, limit?: number, includeMedia?: boolean): Promise<unknown>;
    canonicalChatId(sessionId: string, chatId: string): Promise<unknown>;
  };
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<unknown>;
    delete(key: string): Promise<unknown>;
    list(prefix?: string): Promise<unknown>;
  };
  net: {
    fetch(url: string, init?: unknown): Promise<unknown>;
  };
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
}

/** Build the proxy capability context handed to a sandboxed plugin in the worker. */
export function buildSandboxContext(client: WorkerCapabilityClient): SandboxCapabilityContext {
  return {
    messages: {
      sendText: (sessionId, chatId, text) => client.call('messages.sendText', [sessionId, chatId, text]),
      reply: (sessionId, chatId, quotedMessageId, text) =>
        client.call('messages.reply', [sessionId, chatId, quotedMessageId, text]),
    },
    engine: {
      getGroupInfo: (sessionId, groupId) => client.call('engine.getGroupInfo', [sessionId, groupId]),
      getContacts: sessionId => client.call('engine.getContacts', [sessionId]),
      getContactById: (sessionId, contactId) => client.call('engine.getContactById', [sessionId, contactId]),
      checkNumberExists: (sessionId, phone) => client.call('engine.checkNumberExists', [sessionId, phone]),
      getChats: sessionId => client.call('engine.getChats', [sessionId]),
      getChatHistory: (sessionId, chatId, limit, includeMedia) =>
        client.call('engine.getChatHistory', [sessionId, chatId, limit, includeMedia]),
      canonicalChatId: (sessionId, chatId) => client.call('engine.canonicalChatId', [sessionId, chatId]),
    },
    storage: {
      get: key => client.call('storage.get', [key]),
      set: (key, value) => client.call('storage.set', [key, value]),
      delete: key => client.call('storage.delete', [key]),
      list: prefix => client.call('storage.list', [prefix]),
    },
    net: {
      fetch: (url, init) => client.call('net.fetch', [url, init]),
    },
    conversations: {
      send: env => client.call('conversation.send', [env]),
    },
    handover: {
      set: (key, state) => client.call('handover.set', [key, state]),
    },
    mappings: {
      upsert: (key, providerConversationId) => client.call('mappings.upsert', [key, providerConversationId]),
      get: key => client.call('mappings.get', [key]),
      getByProvider: (instanceId, providerConversationId) =>
        client.call('mappings.getByProvider', [instanceId, providerConversationId]),
    },
  };
}
