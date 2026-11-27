import { createCipheriv, createHmac } from 'node:crypto';
import { BufferJSON } from '@whiskeysockets/baileys';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysEvents, keptInboundRaw, revivedInbound, type BaileysEventsHost } from './baileys-events';
import { createLogger } from '../../common/services/logger.service';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

type Lib = Awaited<ReturnType<BaileysEventsHost['loadLib']>>;

/**
 * A change WhatsApp sends encrypted under the secret of the message it changes (an edit, a reaction, an RSVP) is read
 * with that message's stored secret. While the store cannot be read (the database refusing connections), the change is
 * kept for the session to hand back once it answers, and read then as it would have been; a store that answers that it
 * holds no such message drops it as before. What is kept is handed back through the JSON form the session keeps it in;
 * the protocol's own classes are not loaded here (test/engine-real reads kept messages with them).
 */
const normalizeMessageContent = (content: unknown): unknown => content;
const getContentType = (content: Record<string, unknown> | undefined): string | undefined =>
  Object.keys(content ?? {}).find(k => k === 'conversation' || k.endsWith('Message'));
const decryptEventResponse = jest.fn((_enc: unknown, ctx: { eventMsgId: string }) => ({
  response: 1,
  timestampMs: 1_786_000_000_500,
  eventMsgId: ctx.eventMsgId,
}));
const lib = {
  normalizeMessageContent,
  extractMessageContent: normalizeMessageContent,
  getContentType,
  BufferJSON,
  decryptEventResponse,
  jidNormalizedUser: (jid: string) => jid.replace(/:\d+@/, '@'),
  getKeyAuthor: (key: { fromMe?: boolean; participant?: string; remoteJid?: string } | undefined, meId = 'me') =>
    (key?.fromMe ? meId : key?.participant || key?.remoteJid) || '',
  isLidUser: (jid: string | undefined) => !!jid?.endsWith('@lid'),
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
const unavailable = () => Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNREFUSED' });

async function until(condition: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setImmediate(resolve));
  }
}

/** Seals a payload as the library derives its key (HKDF-SHA256, zero salt, AES-256-GCM, no AAD). */
function seal(label: 'Message Edit' | 'Enc Reaction', plain: object) {
  const prk = createHmac('sha256', Buffer.alloc(32)).update(secret).digest();
  const info = Buffer.from(`ORIG1${author}${author}${label}`);
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

// The JSON form the adapter keeps a message in; its content revived as it is (the classes are not loaded here).
const real = { BufferJSON, proto: { Message: { fromObject: (content: unknown) => content } } } as unknown as Lib;

const edit = (): WAMessage => ({
  key: { id: 'ENV-A', remoteJid: group, participant: author, fromMe: false },
  messageTimestamp: 1_786_000_100,
  message: {
    secretEncryptedMessage: {
      targetMessageKey: { id: 'ORIG1', remoteJid: group, fromMe: false },
      ...seal('Message Edit', {
        protocolMessage: {
          type: 14,
          key: { id: 'ORIG1' },
          editedMessage: { conversation: 'edited text' },
          timestampMs: 1_786_000_000_100,
        },
      }),
      secretEncType: 2,
    },
  },
});

const plainEdit = (text: string): WAMessage => ({
  key: { id: 'ENV-B', remoteJid: group, participant: author, fromMe: false },
  messageTimestamp: 1_786_000_150,
  message: {
    protocolMessage: {
      type: 14,
      key: { id: 'ORIG1' },
      editedMessage: { conversation: text },
      timestampMs: 1_786_000_000_200,
    },
  },
});

const plainRevoke = (): WAMessage => ({
  key: { id: 'ENV-D', remoteJid: group, participant: author, fromMe: false },
  messageTimestamp: 1_786_000_160,
  message: { protocolMessage: { type: 0, key: { id: 'ORIG1', remoteJid: group, fromMe: false } } },
});

const reaction = (): WAMessage => ({
  key: { id: 'REACT-A', remoteJid: group, participant: author, fromMe: false },
  messageTimestamp: 1_786_000_200,
  message: {
    encReactionMessage: {
      targetMessageKey: { id: 'ORIG1', remoteJid: group, fromMe: false },
      ...seal('Enc Reaction', { text: 'heart', senderTimestampMs: 1786000000999 }),
    },
  },
});

const rsvp = (): WAMessage => ({
  key: { id: 'RSVP-A', remoteJid: group, participant: author, fromMe: false },
  messageTimestamp: 1_786_000_300,
  message: {
    encEventResponseMessage: {
      eventCreationMessageKey: { id: 'ORIG1', remoteJid: group, participant: author, fromMe: false },
      encPayload: Buffer.alloc(20, 1),
      encIv: Buffer.alloc(12, 2),
    },
  },
});

function setup() {
  const stored = {
    key: { id: 'ORIG1', remoteJid: group, participant: author, fromMe: false },
    messageTimestamp: 1_786_000_000,
    message: { conversation: 'old text', messageContextInfo: { messageSecret: secret.toString('base64') } },
  } as unknown as WAMessage;
  // How the store answers: with the message, with nothing, or by failing.
  let store: 'answers' | 'empty' | 'fails' = 'answers';
  const edited: string[] = [];
  const reacted: string[] = [];
  const responded: string[] = [];
  const revoked: string[] = [];
  // What the session keeps, and whether it was handed back yet.
  const kept: Array<{ msg: WAMessage; targetId?: string; handed: boolean }> = [];
  // The library maps the event creator's lid to the phone number the RSVP is sealed with.
  const socket = {
    user: { id: '6280000000000:1@s.whatsapp.net' },
    signalRepository: { lidMapping: { getPNForLID: () => Promise.resolve('6281111111111@s.whatsapp.net') } },
  } as unknown as WASocket;
  const logger = createLogger('BaileysUnreadableTargetSpec');
  const debug = jest.spyOn(logger, 'debug');
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const host = {
    getSocket: () => socket,
    getSocketOrNull: () => socket,
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
    getAdmitInbound: () => undefined,
    getStoredMessage: (id: string) => {
      if (store === 'fails') return Promise.reject(unavailable());
      return Promise.resolve(store === 'answers' && id === 'ORIG1' ? stored : null);
    },
    putStoredMessage: () => undefined,
    updateStoredMessage: (_id: string, change: (m: WAMessage) => WAMessage | null) => {
      const next = change(stored);
      if (next) Object.assign(stored, next);
      return Promise.resolve();
    },
    removeStoredMessage: () => undefined,
    keepUnreadInbound: (msg: WAMessage, targetId?: string) => kept.push({ msg, targetId, handed: false }),
    isChangeKept: (targetId: string) => kept.some(entry => !entry.handed && entry.targetId === targetId),
    getOnMessage: () => () => undefined,
    getOnMessageCreate: () => undefined,
    getOnMessageRevoked: () => (r: { id: string }) => revoked.push(r.id),
    getOnMessageEdited: () => (e: { body: string }) => edited.push(e.body),
    getOnMessageReaction: () => (r: { reaction: string }) => reacted.push(r.reaction),
    getOnMessageAck: () => undefined,
    getOnMessageReceipt: () => undefined,
    getOnGroupEvent: () => undefined,
    getOnEventResponse: () => (e: { response: string; responseMessageId: string }) =>
      responded.push(`${e.responseMessageId} ${e.response}`),
    getOnPollVote: () => undefined,
    findContact: () => null,
    getOnCall: () => undefined,
    getOnPresenceUpdate: () => undefined,
    getOnCallOutcome: () => undefined,
  } as unknown as BaileysEventsHost;
  const events = new BaileysEvents(host);
  const upsert = (msg: WAMessage): void => events.handleMessagesUpsert({ type: 'notify', messages: [msg] });
  return {
    events,
    upsert,
    stored,
    edited,
    reacted,
    responded,
    revoked,
    kept,
    debug,
    store: (answer: 'answers' | 'empty' | 'fails') => (store = answer),
    /** Hand back what the session kept, in the order it kept it, as the session does: through the JSON form. */
    handBack: async (): Promise<void> => {
      for (const entry of kept.filter(e => !e.handed)) {
        await events.redeliverInbound(revivedInbound(real, keptInboundRaw(real, entry.msg)));
        entry.handed = true;
      }
    },
  };
}

describe('an encrypted change whose target the store cannot read', () => {
  it.each([
    ['an edit', edit, 'edited', 'edited text'],
    ['a reaction', reaction, 'reacted', 'heart'],
  ] as const)(
    'keeps %s while the store fails, and reads it as it would have once handed back',
    async (_l, make, list, landed) => {
      const run = setup();
      run.store('fails');

      run.upsert(make());
      await until(() => run.kept.length === 1, 'the change to be kept');
      expect(run[list]).toEqual([]);
      expect(run.kept[0].targetId).toBe('ORIG1');

      run.store('answers');
      await run.handBack();

      expect(run[list]).toEqual([landed]);
      expect(run.kept).toHaveLength(1);
    },
  );

  it('hands back the store failure, keeping nothing more, while the store still fails', async () => {
    const run = setup();
    run.store('fails');
    run.upsert(edit());
    await until(() => run.kept.length === 1, 'the edit to be kept');

    await expect(run.events.redeliverInbound(run.kept[0].msg)).rejects.toMatchObject({ code: 'ECONNREFUSED' });

    expect(run.kept).toHaveLength(1);
    expect(run.edited).toEqual([]);
  });

  it('reads an encrypted change with the copy of its original still being processed, though the store fails', async () => {
    const run = setup();
    run.store('fails');
    const original = {
      key: { id: 'ORIG1', remoteJid: group, participant: author, fromMe: false },
      messageTimestamp: 1_786_000_000,
      message: { conversation: 'old text', messageContextInfo: { messageSecret: secret } },
    } as unknown as WAMessage;

    run.events.handleMessagesUpsert({ type: 'notify', messages: [original, edit()] });
    await until(() => run.edited.length === 1, 'the edit');

    expect(run.edited).toEqual(['edited text']);
    expect(run.kept).toEqual([]);
  });

  it('drops an encrypted change whose target the store answers it does not hold, as before', async () => {
    const run = setup();
    run.store('empty');

    run.upsert(edit());
    await until(
      () =>
        run.debug.mock.calls.some(
          ([, fields]) => (fields as { action?: string } | undefined)?.action === 'baileys_encrypted_unreadable',
        ),
      'the drop',
    );

    expect(run.kept).toEqual([]);
    expect(run.edited).toEqual([]);
  });

  it('keeps a later edit of the message behind the kept one, so the older one handed back does not undo it', async () => {
    const run = setup();
    run.store('fails');
    run.upsert(edit());
    await until(() => run.kept.length === 1, 'the encrypted edit to be kept');

    run.store('answers');
    run.upsert(plainEdit('second edit'));
    await until(() => run.kept.length === 2, 'the later edit to be kept behind it');
    expect(run.edited).toEqual([]);
    await run.handBack();

    expect(run.edited).toEqual(['edited text', 'second edit']);
    expect((run.stored.message as { conversation?: string }).conversation).toBe('second edit');
  });

  it('lands a delete at once though an edit of the message is kept, and refuses the edit handed back after it', async () => {
    const run = setup();
    run.store('fails');
    run.upsert(edit());
    await until(() => run.kept.length === 1, 'the edit to be kept');

    run.store('answers');
    run.upsert(plainRevoke());
    await until(() => run.revoked.length === 1, 'the delete');
    expect(run.kept).toHaveLength(1);

    // Handed back after the delete, the edit is refused: the taken-back message is not announced edited.
    await run.handBack();
    for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));

    expect(run.edited).toEqual([]);
  });

  it('keeps an RSVP the library could not read for a failed store read, and reads it once handed back', async () => {
    const run = setup();
    const message = rsvp();
    // The library read the event through the store first, with the key the RSVP carries, and the read failed.
    run.events.noteUnreadStoredMessage(message.message!.encEventResponseMessage!.eventCreationMessageKey!);

    run.upsert(message);
    await until(() => run.kept.length === 1, 'the RSVP to be kept');
    expect(run.responded).toEqual([]);

    await run.handBack();

    expect(run.responded).toEqual(['RSVP-A going']);
    expect(decryptEventResponse).toHaveBeenCalledWith(
      { encPayload: Buffer.alloc(20, 1), encIv: Buffer.alloc(12, 2) },
      expect.objectContaining({
        eventMsgId: 'ORIG1',
        eventEncKey: secret,
        eventCreatorJid: '6281111111111@s.whatsapp.net',
        responderJid: author,
      }),
    );
  });

  it.each([
    ['its event the store still cannot read, handing the failure back', 'fails', undefined, undefined],
    [
      'its event the store does not hold, as the library drops it',
      'empty',
      undefined,
      'baileys_event_response_unreadable',
    ],
    [
      'a response that does not read, as the library drops it',
      'answers',
      'unreadable',
      'baileys_event_response_failed',
    ],
  ] as const)('reads nothing of a kept RSVP with %s', async (_l, answer, decrypt, action) => {
    const run = setup();
    const message = rsvp();
    run.events.noteUnreadStoredMessage(message.message!.encEventResponseMessage!.eventCreationMessageKey!);
    run.upsert(message);
    await until(() => run.kept.length === 1, 'the RSVP to be kept');
    run.store(answer);
    if (decrypt)
      decryptEventResponse.mockImplementationOnce(() => {
        throw new Error('Unsupported state or unable to authenticate data');
      });

    const handedBack = run.handBack();

    if (answer === 'fails') await expect(handedBack).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    else await handedBack;
    expect(run.responded).toEqual([]);
    if (action) {
      expect(run.debug.mock.calls.map(([, fields]) => (fields as { action?: string } | undefined)?.action)).toContain(
        action,
      );
    }
  });

  it('keeps nothing of an RSVP the library read, though a read of its event failed before', async () => {
    const run = setup();
    // A read of the same event failed before (a retry receipt), with a key of its own.
    run.events.noteUnreadStoredMessage({ ...rsvp().message!.encEventResponseMessage!.eventCreationMessageKey! });

    run.upsert(rsvp());
    for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));

    expect(run.kept).toEqual([]);
  });
});
