import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysContacts, BaileysContactsHost } from './baileys-contacts';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { toNeutralJid } from '../identity/wa-id';

/**
 * `readMessages` reaches `fetchPrivacySettings`, whose body is
 * `const { content } = await query({...})`. On an unanswered query that destructure throws a raw
 * TypeError — no Boom, so nothing can classify it — and the caller gets a bare 500.
 *
 * Marking a chat read is idempotent in effect, so bounding it is safe: a repeat costs nothing.
 * The media send path is deliberately NOT bounded the same way — see the PR.
 */
const never = (): Promise<never> => new Promise<never>(() => undefined);

/**
 * The real fold, not an identity stub. A stub that returned its argument unchanged let the whole
 * suite pass with the `toEngineJid` call deleted outright, and left the fallback case asserting
 * `@s.whatsapp.net` while the supplied-id cases asserted `@c.us` for the same chat.
 */
const toEngineJid = (jid: string): string => {
  const [userPart, host] = jid.split('@');
  return host === 'c.us' || host === 's.whatsapp.net' ? `${userPart}@s.whatsapp.net` : jid;
};

function makeHost(overrides: Partial<Record<keyof BaileysContactsHost, unknown>>): BaileysContactsHost {
  const host = {
    ensureReady: () => undefined,
    logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
    normalizedSelfJid: () => '628177@s.whatsapp.net',
    listContacts: () => [],
    findContact: () => null,
    resolvePhone: () => null,
    listChats: () => [],
    lastInboundMessage: () => ({ key: { id: 'M1', remoteJid: '628123@s.whatsapp.net' }, timestamp: 1 }),
    getStoredMessages: () => Promise.resolve([]),
    toEngineJid,
    ...overrides,
  } as unknown as BaileysContactsHost;
  // Wired the way the adapter wires it: the real fold, reading the session's lid mapping through
  // this host's own resolvePhone, so a test can hand it a mapping and exercise the lid dialect.
  host.toNeutralJid = (jid: string): string => toNeutralJid(jid, id => host.resolvePhone(id));
  return host;
}

function contacts(sock: Record<string, jest.Mock>, budgetMs: number): BaileysContacts {
  return new BaileysContacts(makeHost({ getSocket: () => sock as unknown as WASocket }), budgetMs);
}

/** A stored message as the message store hands it back: the whole key, not a synthesised one. */
const stored = (key: WAMessage['key']): WAMessage => ({ key, message: {}, messageTimestamp: 1 });

describe('sendSeen', () => {
  it('reports an unanswered read receipt instead of a bare 500', async () => {
    await expect(contacts({ readMessages: jest.fn(never) }, 15).sendSeen('628123@c.us')).rejects.toBeInstanceOf(
      EngineTransportError,
    );
  });

  it('still resolves when WhatsApp answers inside the budget', async () => {
    const readMessages = jest.fn().mockResolvedValue(undefined);
    await expect(contacts({ readMessages }, 500).sendSeen('628123@c.us')).resolves.toBe(true);
  });

  it('acknowledges every supplied message, not just the newest one', async () => {
    // The whole point of the caller-supplied list: a burst of three inbound messages used to leave
    // the first two unread forever, because only lastMessage() was ever acknowledged.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    await expect(contacts({ readMessages }, 500).sendSeen('628123@c.us', ['M1', 'M2', 'M3'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([
      { remoteJid: '628123@s.whatsapp.net', id: 'M1', fromMe: false },
      { remoteJid: '628123@s.whatsapp.net', id: 'M2', fromMe: false },
      { remoteJid: '628123@s.whatsapp.net', id: 'M3', fromMe: false },
    ]);
  });

  it('never sends the receipt to another chat, even when the store resolves the id', async () => {
    // The stored key carries its own remoteJid. Used unchecked, an id belonging to a different chat
    // in the same session acknowledged THAT chat while the route answered success for the one the
    // caller named, and the caller's own chat stayed unread.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      getStoredMessages: () =>
        Promise.resolve([stored({ id: 'X1', remoteJid: '628999@s.whatsapp.net', fromMe: false })]),
    });

    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['X1'])).resolves.toBe(true);

    // Falls back to the synthesised key for the ADDRESSED chat rather than the stored one.
    expect(readMessages).toHaveBeenCalledWith([{ remoteJid: '628123@s.whatsapp.net', id: 'X1', fromMe: false }]);
  });

  it('still uses a stored key stored under the peer lid for the addressed chat', async () => {
    // Baileys addresses a DM by the peer's lid, so the stored key's remoteJid is `<lid>@lid` while
    // the caller names the chat by phone number. Folding through the ENGINE dialect cannot reduce a
    // lid, so every stored key was discarded and the receipt fell back to a synthesised key that
    // lost the real fromMe and participant.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      resolvePhone: (jid: string) => (jid === '9988@lid' ? '628123' : null),
      getStoredMessages: () =>
        Promise.resolve([stored({ id: 'L1', remoteJid: '9988@lid', fromMe: true, participant: '9988@lid' })]),
    });

    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['L1'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([
      { id: 'L1', remoteJid: '9988@lid', fromMe: true, participant: '9988@lid' },
    ]);
  });

  it('still rejects a lid-addressed key from another chat', async () => {
    // Negative twin of the case above: reducing through the neutral dialect must not turn the scope
    // check into "accept anything spelled @lid". An unmapped lid stays itself and cannot match.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      getStoredMessages: () => Promise.resolve([stored({ id: 'L2', remoteJid: '7777@lid', fromMe: true })]),
    });

    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['L2'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([{ remoteJid: '628123@s.whatsapp.net', id: 'L2', fromMe: false }]);
  });

  it('still uses a stored key whose chat is spelled in the other dialect', async () => {
    // Control for the check above: the same chat written @c.us must still resolve, or the fix would
    // have cost every receipt its participant and fromMe.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      getStoredMessages: () => Promise.resolve([stored({ id: 'D1', remoteJid: '628123@c.us', fromMe: true })]),
    });

    await expect(new BaileysContacts(host, 500).sendSeen('628123@s.whatsapp.net', ['D1'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([{ id: 'D1', remoteJid: '628123@c.us', fromMe: true }]);
  });

  it('keeps the stored key of a received broadcast-list message addressed by its sender chat', async () => {
    // The message is reported under the sender's chat, but its key names the list and the sender.
    // Synthesising a key for the sender's chat dropped the participant the receipt needs.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const key = { id: 'B1', remoteJid: '1700000000@broadcast', participant: '628123@s.whatsapp.net', fromMe: false };
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      getStoredMessages: () => Promise.resolve([stored(key)]),
    });

    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['B1'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([key]);
  });

  it('treats a null id list as absent rather than dereferencing it', async () => {
    // The REST body rejects an explicit null, but this is the engine boundary; it used to throw a
    // TypeError here and surface as a 500.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({ getSocket: () => ({ readMessages }) as unknown as WASocket });

    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', null as unknown as string[])).resolves.toBe(
      true,
    );
    expect(readMessages).toHaveBeenCalledWith([{ id: 'M1', remoteJid: '628123@s.whatsapp.net' }]);
  });

  it('carries the participant on a group receipt, which a synthesised key cannot', async () => {
    // A group receipt with no `participant` names no sender, so WhatsApp cannot attribute it and
    // the message stays unread on the sender's side while the API answers success: true.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      getStoredMessages: () =>
        Promise.resolve([
          stored({ id: 'G1', remoteJid: '628999-1@g.us', fromMe: false, participant: '628123@s.whatsapp.net' }),
        ]),
    });
    await expect(new BaileysContacts(host, 500).sendSeen('628999-1@g.us', ['G1'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([
      { id: 'G1', remoteJid: '628999-1@g.us', fromMe: false, participant: '628123@s.whatsapp.net' },
    ]);
  });

  it('takes fromMe from the stored key rather than assuming inbound', async () => {
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      getStoredMessages: () =>
        Promise.resolve([stored({ id: 'O1', remoteJid: '628123@s.whatsapp.net', fromMe: true })]),
    });
    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['O1'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([{ id: 'O1', remoteJid: '628123@s.whatsapp.net', fromMe: true }]);
  });

  it('synthesises a key only for ids the store has never seen', async () => {
    // History-sync backfill is emitted but never persisted, so a legitimate id can miss. Falling
    // back keeps the 1:1 case working instead of silently dropping the message from the receipt.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      getStoredMessages: () =>
        Promise.resolve([stored({ id: 'K1', remoteJid: '628123@s.whatsapp.net', fromMe: true })]),
    });
    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['K1', 'MISSING'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([
      { id: 'K1', remoteJid: '628123@s.whatsapp.net', fromMe: true },
      { remoteJid: '628123@s.whatsapp.net', id: 'MISSING', fromMe: false },
    ]);
  });

  it('marks supplied messages even when the store has nothing cached', async () => {
    // The restart case: the in-memory store is empty, so the old code returned false under a 200
    // and no receipt was ever sent. A caller that persisted the IDs is not subject to that.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      lastInboundMessage: () => null,
    });
    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['M9'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([{ remoteJid: '628123@s.whatsapp.net', id: 'M9', fromMe: false }]);
  });

  it('works without a message store at all', async () => {
    const readMessages = jest.fn().mockResolvedValue(undefined);
    const host = makeHost({
      getSocket: () => ({ readMessages }) as unknown as WASocket,
      getStoredMessages: () => undefined,
    });
    await expect(new BaileysContacts(host, 500).sendSeen('628123@c.us', ['M9'])).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([{ remoteJid: '628123@s.whatsapp.net', id: 'M9', fromMe: false }]);
  });

  it('acknowledges nothing when the caller supplies an empty list', async () => {
    // An empty list is a caller that computed its unread set and found none. Folding it into the
    // no-list branch would acknowledge the newest message, which is the opposite of the request.
    const readMessages = jest.fn().mockResolvedValue(undefined);
    await expect(contacts({ readMessages }, 500).sendSeen('628123@c.us', [])).resolves.toBe(false);
    expect(readMessages).not.toHaveBeenCalled();
  });

  it('falls back to the newest received message when no list is supplied', async () => {
    const readMessages = jest.fn().mockResolvedValue(undefined);
    await expect(contacts({ readMessages }, 500).sendSeen('628123@c.us')).resolves.toBe(true);
    expect(readMessages).toHaveBeenCalledWith([{ id: 'M1', remoteJid: '628123@s.whatsapp.net' }]);
  });

  it('still short-circuits when no received message is known', async () => {
    const host = makeHost({ getSocket: () => ({}) as unknown as WASocket, lastInboundMessage: () => null });
    await expect(new BaileysContacts(host, 15).sendSeen('628123@c.us')).resolves.toBe(false);
  });
});
