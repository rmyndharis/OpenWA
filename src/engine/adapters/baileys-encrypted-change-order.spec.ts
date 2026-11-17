import { createCipheriv, createHmac } from 'node:crypto';
import { BufferJSON } from '@whiskeysockets/baileys';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysEvents, type BaileysEventsHost } from './baileys-events';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import type { InboundTicket } from '../interfaces/whatsapp-engine.interface';

type Lib = Awaited<ReturnType<BaileysEventsHost['loadLib']>>;

/**
 * A contact's edit, and a reaction in some chats, arrive encrypted under the secret of the message they change, so
 * the adapter reads the message from its store to decrypt them. Two changes of one message that arrive together are
 * read concurrently; the pool of database connections may answer them in any order, and the changes must still be
 * applied and announced in the order they arrived in, as plain edits and reactions are.
 */
const normalizeMessageContent = (content: unknown): unknown => content;
const getContentType = (content: Record<string, unknown> | undefined): string | undefined =>
  Object.keys(content ?? {}).find(k => k === 'conversation' || k.endsWith('Message'));
const lib = {
  normalizeMessageContent,
  extractMessageContent: normalizeMessageContent,
  getContentType,
  BufferJSON,
  proto: {
    Message: {
      SecretEncryptedMessage: { SecretEncType: { UNKNOWN: 0, EVENT_EDIT: 1, MESSAGE_EDIT: 2 } },
      ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } },
      decode: (bytes: Uint8Array): unknown => JSON.parse(Buffer.from(bytes).toString()),
      ReactionMessage: { decode: (bytes: Uint8Array): unknown => JSON.parse(Buffer.from(bytes).toString()) },
    },
  },
  downloadMediaMessage: jest.fn(),
} as unknown as Lib;

const group = '120363000000000001@g.us';
const author = '39900313301142@lid';
const secret = Buffer.alloc(32, 0x42);

/** Waits for `condition` between event-loop turns and fails at the deadline instead of hanging. */
async function until(condition: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

/** Seals a payload as the library derives its key (HKDF-SHA256, zero salt, AES-256-GCM, no AAD). */
function seal(label: 'Message Edit' | 'Enc Reaction', modifier: string, plain: object) {
  const prk = createHmac('sha256', Buffer.alloc(32)).update(secret).digest();
  const info = Buffer.from(`ORIG1${author}${modifier}${label}`);
  const key = createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest();
  const iv = Buffer.alloc(12, 5);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encPayload = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(plain))),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { encPayload, encIv: iv };
}

const editEnvelope = (envelopeId: string, text: string, atMs: number, tamper = false): WAMessage => {
  const sealed = seal('Message Edit', author, {
    protocolMessage: { type: 14, key: { id: 'ORIG1' }, editedMessage: { conversation: text }, timestampMs: atMs },
  });
  if (tamper) sealed.encPayload[0] ^= 0xff;
  return {
    key: { id: envelopeId, remoteJid: group, participant: author, fromMe: false },
    messageTimestamp: 1_786_000_100,
    message: {
      secretEncryptedMessage: {
        targetMessageKey: { id: 'ORIG1', remoteJid: group, fromMe: false },
        ...sealed,
        secretEncType: 2,
      },
    },
  };
};

const plainEditEnvelope = (envelopeId: string, text: string, atMs: number): WAMessage => ({
  key: { id: envelopeId, remoteJid: group, participant: author, fromMe: false },
  messageTimestamp: 1_786_000_100,
  message: {
    protocolMessage: { type: 14, key: { id: 'ORIG1' }, editedMessage: { conversation: text }, timestampMs: atMs },
  },
});

const plainRevokeEnvelope = (envelopeId: string): WAMessage => ({
  key: { id: envelopeId, remoteJid: group, participant: author, fromMe: false },
  messageTimestamp: 1_786_000_150,
  message: { protocolMessage: { type: 0, key: { id: 'ORIG1', remoteJid: group, fromMe: false } } },
});

const reactionEnvelope = (envelopeId: string, text: string): WAMessage => ({
  key: { id: envelopeId, remoteJid: group, participant: author, fromMe: false },
  messageTimestamp: 1_786_000_200,
  message: {
    encReactionMessage: {
      targetMessageKey: { id: 'ORIG1', remoteJid: group, fromMe: false },
      ...seal('Enc Reaction', author, { text, senderTimestampMs: 1786000000999 }),
    },
  },
});

/** A message of another chat that nothing orders against the changes: it is processed whenever it is let in. */
const bystander = (): WAMessage => ({
  key: { id: 'OTHER1', remoteJid: '120363000000000002@g.us', participant: author, fromMe: false },
  messageTimestamp: 1_786_000_300,
  message: { conversation: 'unrelated' },
});

/**
 * The store holds the original. The first read of it is held until the test releases it, so the read the first
 * change makes to decrypt it answers after the second change's own read would have, as two queries over a pool of
 * connections may.
 */
function setup(options: { ticket?: InboundTicket } = {}) {
  const stored = {
    key: { id: 'ORIG1', remoteJid: group, participant: author, fromMe: false },
    messageTimestamp: 1_786_000_000,
    message: { conversation: 'old text', messageContextInfo: { messageSecret: secret.toString('base64') } },
  } as unknown as WAMessage;
  const seen: string[] = [];
  const edited: string[] = [];
  const reacted: string[] = [];
  const messages: string[] = [];
  let reads = 0;
  let releaseFirstRead: () => void = () => undefined;
  const logger = createLogger('BaileysEncryptedChangeOrderSpec');
  const debug = jest.spyOn(logger, 'debug');
  const host = {
    getSocket: () => ({}) as WASocket,
    getSocketOrNull: () => null,
    logger,
    loadLib: () => Promise.resolve(lib),
    getFetchDispatcher: () => undefined,
    toNeutralJid: (jid: string) => jid,
    normalizedSelfJid: () => '6280000000000@s.whatsapp.net',
    inboundLimiter: new ConcurrencyLimiter(4),
    recordKeyLidMappings: () => undefined,
    recordMessage: () => undefined,
    recordMessageEdit: () => undefined,
    consumeOwnSend: () => false,
    getAdmitInbound: () => (options.ticket ? () => options.ticket : undefined),
    getStoredMessage: (id: string) => {
      if (id !== 'ORIG1') return Promise.resolve(null);
      reads += 1;
      if (reads === 1) return new Promise<WAMessage>(resolve => (releaseFirstRead = () => resolve(stored)));
      return Promise.resolve(stored);
    },
    putStoredMessage: () => undefined,
    updateStoredMessage: (_id: string, change: (m: WAMessage) => WAMessage | null) => {
      change(stored);
      return Promise.resolve();
    },
    removeStoredMessage: () => undefined,
    getOnMessage: () => (m: { id: string }) => messages.push(m.id),
    getOnMessageCreate: () => undefined,
    getOnMessageRevoked: () => () => seen.push('revoked'),
    getOnMessageEdited: () => (e: { body: string }) => {
      edited.push(e.body);
      seen.push(`edited: ${e.body}`);
    },
    getOnMessageReaction: () => (r: { reaction: string }) => reacted.push(r.reaction),
    getOnMessageAck: () => undefined,
    getOnMessageReceipt: () => undefined,
    getOnGroupEvent: () => undefined,
    getOnEventResponse: () => undefined,
    getOnPollVote: () => undefined,
    findContact: () => null,
    getOnCall: () => undefined,
    getOnPresenceUpdate: () => undefined,
    getOnCallOutcome: () => undefined,
  } as unknown as BaileysEventsHost;
  const events = new BaileysEvents(host);
  const upsert = (...batch: WAMessage[]): void => events.handleMessagesUpsert({ type: 'notify', messages: batch });
  return {
    events,
    upsert,
    stored,
    seen,
    edited,
    reacted,
    debug,
    reads: () => reads,
    releaseFirstRead: () => releaseFirstRead(),
    /**
     * Lets everything that is not held by the first read run: the second change when nothing orders it behind the
     * first, and a message of another chat that is queued behind both and cannot finish before they could.
     */
    letOthersRun: async (): Promise<void> => {
      await until(() => reads >= 1, 'the first read of the original');
      upsert(bystander());
      await until(() => messages.length === 1, 'a message of another chat');
    },
  };
}

describe('encrypted changes of one message keep the order they arrived in', () => {
  it('announces two encrypted edits in arrival order when the first one decrypts after the second', async () => {
    const { upsert, edited, letOthersRun, releaseFirstRead } = setup();

    upsert(
      editEnvelope('ENV-A', 'first edit', 1_786_000_000_100),
      editEnvelope('ENV-B', 'second edit', 1_786_000_000_200),
    );
    await letOthersRun();
    releaseFirstRead();
    await until(() => edited.length === 2, 'both edits');

    expect(edited).toEqual(['first edit', 'second edit']);
  });

  it('leaves the stored copy with the later of two encrypted edits when the first one decrypts after the second', async () => {
    const { upsert, edited, stored, letOthersRun, releaseFirstRead } = setup();

    upsert(
      editEnvelope('ENV-A', 'first edit', 1_786_000_000_100),
      editEnvelope('ENV-B', 'second edit', 1_786_000_000_200),
    );
    await letOthersRun();
    releaseFirstRead();
    await until(() => edited.length === 2, 'both edits');

    expect((stored.message as { conversation?: string }).conversation).toBe('second edit');
  });

  it('keeps the arrival order of two plain edits when the first one reads the store more slowly', async () => {
    const { upsert, edited, stored, letOthersRun, releaseFirstRead } = setup();

    upsert(
      plainEditEnvelope('ENV-A', 'first edit', 1_786_000_000_100),
      plainEditEnvelope('ENV-B', 'second edit', 1_786_000_000_200),
    );
    await letOthersRun();
    releaseFirstRead();
    await until(() => edited.length === 2, 'both edits');

    expect(edited).toEqual(['first edit', 'second edit']);
    expect((stored.message as { conversation?: string }).conversation).toBe('second edit');
  });

  it('announces two encrypted reactions of one reactor in arrival order when the first one decrypts after the second', async () => {
    const { upsert, reacted, letOthersRun, releaseFirstRead } = setup();

    upsert(reactionEnvelope('REACT-A', 'thumbs up'), reactionEnvelope('REACT-B', 'heart'));
    await letOthersRun();
    releaseFirstRead();
    await until(() => reacted.length === 2, 'both reactions');

    expect(reacted).toEqual(['thumbs up', 'heart']);
  });

  it('announces an encrypted edit before a delete that arrived after it', async () => {
    const { upsert, seen, letOthersRun, releaseFirstRead } = setup();

    upsert(editEnvelope('ENV-A', 'first edit', 1_786_000_000_100), plainRevokeEnvelope('ENV-D'));
    await letOthersRun();
    releaseFirstRead();
    await until(() => seen.length === 2, 'the edit and the delete');

    expect(seen).toEqual(['edited: first edit', 'revoked']);
  });

  it('does not hold a readable change behind an earlier one that cannot be read', async () => {
    const { upsert, edited, seen, debug, letOthersRun, releaseFirstRead } = setup();

    upsert(
      editEnvelope('ENV-A', 'forged edit', 1_786_000_000_100, true),
      editEnvelope('ENV-B', 'second edit', 1_786_000_000_200),
    );
    await letOthersRun();
    releaseFirstRead();
    const forgedDropped = (): boolean =>
      debug.mock.calls.some(
        ([message, fields]) =>
          message === 'An encrypted edit or reaction did not authenticate against its target' &&
          (fields as { msgId?: string } | undefined)?.msgId === 'ENV-A',
      );
    await until(() => edited.length === 1 && forgedDropped(), 'the readable edit and the drop of the forged one');

    expect(seen).toEqual(['edited: second edit']);
  });

  it('drops the turn of the chat before the read of the target, not after it', async () => {
    const ticket = { reserve: () => false, holdUntil: jest.fn(), drop: jest.fn(), revoked: false };
    const { upsert, reads, edited, releaseFirstRead } = setup({ ticket });

    upsert(editEnvelope('ENV-A', 'first edit', 1_786_000_000_100));
    await until(() => reads() === 1, 'the read of the original');

    expect(ticket.drop).toHaveBeenCalled();
    releaseFirstRead();
    await until(() => edited.length === 1, 'the edit');
  });

  it('announces nothing of a change whose read was out when the store was wiped, and does not block the next one', async () => {
    const { events, upsert, edited, seen, letOthersRun, releaseFirstRead } = setup();

    upsert(editEnvelope('ENV-A', 'old generation edit', 1_786_000_000_100));
    await letOthersRun();
    events.fenceStoredWrites();
    upsert(editEnvelope('ENV-B', 'new generation edit', 1_786_000_000_200));
    await until(() => edited.length === 1, 'the edit of the new generation');
    releaseFirstRead();
    // The read that was out answers last; everything behind it has run by the time a later read is made.
    upsert(editEnvelope('ENV-C', 'later edit', 1_786_000_000_300));
    await until(() => edited.length === 2, 'the later edit');

    expect(seen).toEqual(['edited: new generation edit', 'edited: later edit']);
  });
});
