import type { Client } from 'whatsapp-web.js';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { WwebjsChats } from './wwebjs-chats';
import { WwebjsContacts } from './wwebjs-contacts';
import { WwebjsChannels } from './wwebjs-channels';
import type { WwebjsMessaging } from './wwebjs-messaging';
import type { WwebjsEngineHost } from './wwebjs-host';

/**
 * A chat, contact or channel write looks its target up first and then acts through the object that lookup
 * returned, which carries its own client: the host's readiness check on getClient never sees that second call. A
 * session stopped while the lookup was in flight must answer the retryable 409 and leave the write unsent, as the
 * group writes and the message mutations already do.
 */
const CHAT = '628111@c.us';
const CHANNEL = '120363000000000001@newsletter';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => {
    resolve = yes;
  });
  return { promise, resolve };
};

type Write = 'sendSeen' | 'clearChatMessages' | 'markUnread' | 'deleteChat' | 'block' | 'unblock' | 'muteChannel';
const writes: Write[] = [
  'sendSeen',
  'clearChatMessages',
  'markUnread',
  'deleteChat',
  'block',
  'unblock',
  'muteChannel',
];

/** A READY session whose lookup is held until the test releases it; the looked-up object records the write. */
function fixture() {
  const entered = deferred<void>();
  const gate = deferred<void>();
  const write = jest.fn().mockResolvedValue(true);
  const target = {
    sendSeen: write,
    clearMessages: write,
    markUnread: write,
    delete: write,
    block: write,
    unblock: write,
    mute: write,
  };
  const held = async (): Promise<typeof target> => {
    entered.resolve();
    await gate.promise;
    return target;
  };
  const client = { getChatById: jest.fn(held), getContactById: jest.fn(held) };
  let ready = true;
  const host = {
    ensureReady() {
      if (!ready) throw new EngineNotReadyError();
    },
    getClient() {
      host.ensureReady();
      return client as unknown as Client;
    },
    isPageTransportError: () => false,
    reportIfPageTransportError: jest.fn(),
    logger: { debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    config: { sessionId: 'sess-writes' },
  } as unknown as WwebjsEngineHost;
  const chats = new WwebjsChats(host, {} as WwebjsMessaging);
  const contacts = new WwebjsContacts(host);
  const channels = new WwebjsChannels(host);
  const invoke = (name: Write): Promise<unknown> => {
    switch (name) {
      case 'sendSeen':
        return chats.sendSeen(CHAT);
      case 'clearChatMessages':
        return chats.clearChatMessages(CHAT);
      case 'markUnread':
        return chats.markUnread(CHAT);
      case 'deleteChat':
        return chats.deleteChat(CHAT);
      case 'block':
        return contacts.blockContact(CHAT);
      case 'unblock':
        return contacts.unblockContact(CHAT);
      case 'muteChannel':
        return channels.muteChannel(CHANNEL, true);
    }
  };
  return {
    invoke,
    write,
    entered,
    gate,
    stopSession: () => {
      ready = false;
    },
  };
}

describe('chat, contact and channel writes when the session stops during their lookup', () => {
  it.each(writes)('runs %s on a session that stays ready', async name => {
    const test = fixture();
    const done = test.invoke(name);
    test.gate.resolve();
    await done;
    expect(test.write).toHaveBeenCalledTimes(1);
  });

  it.each(writes)('refuses %s after the session stopped during the lookup, without sending it', async name => {
    const test = fixture();
    const done = test.invoke(name).catch((error: unknown) => error);
    await test.entered.promise;
    test.stopSession();
    test.gate.resolve();

    const outcome = await done;
    expect({ outcome: outcome instanceof EngineNotReadyError, writes: test.write.mock.calls.length }).toEqual({
      outcome: true,
      writes: 0,
    });
  });
});
