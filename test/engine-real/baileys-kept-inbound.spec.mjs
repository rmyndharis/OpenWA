/**
 * Messages kept while the store could not read the message they change, handed back through the REAL library.
 *
 * An encrypted edit or reaction, a poll vote and an RSVP are read with the secret of the message they change. While
 * the store fails, the adapter keeps such a message in the JSON form the session journals it in, and reads it once the
 * store answers. That form holds the protocol's 64-bit numbers and enums as strings and its bytes as base64, so each
 * kind is built here as the socket delivers it, kept, revived and read with the library's own classes and decryption,
 * and must land as it would have live.
 *
 * Runs over dist/, so it needs `npm run build` first: `npm run build && npm run test:engine-real`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac, hkdfSync } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = await import('@whiskeysockets/baileys');
const { BaileysEvents, keptInboundRaw, revivedInbound } = require('../../dist/engine/adapters/baileys-events.js');
const { ConcurrencyLimiter } = require('../../dist/common/utils/concurrency-limiter.js');

const SELF = '6280000000000@s.whatsapp.net';
const AUTHOR = '6281111111111@s.whatsapp.net';
const MEMBER = '6282222222222@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';
const SECRET = Buffer.alloc(32, 0x42);
const IV = Buffer.alloc(12, 5);
const silent = { log() {}, debug() {}, verbose() {}, warn() {}, error() {} };

/** Content in the form the socket hands over: encoded and decoded by the library's own classes. */
const wire = content =>
  lib.proto.Message.decode(lib.proto.Message.encode(lib.proto.Message.fromObject(content)).finish());

/** What the store holds: the messages changed, each with the secret its changes are read with. */
const stored = {
  ORIG1: { conversation: 'old text' },
  POLL1: { pollCreationMessageV3: { name: 'Lunch?', options: [{ optionName: 'Pizza' }, { optionName: 'Sushi' }] } },
  EVT1: { eventMessage: { name: 'Standup' } },
};
const storedMessage = id => ({
  key: { id, remoteJid: GROUP, participant: AUTHOR, fromMe: false },
  messageTimestamp: 1_786_000_000,
  message: { ...stored[id], messageContextInfo: { messageSecret: SECRET.toString('base64') } },
});

/** An edit or a reaction sealed under the original's secret (HKDF-SHA256, zero salt, AES-256-GCM, no AAD). */
function sealChange(label, plaintext) {
  const info = Buffer.from(`ORIG1${AUTHOR}${AUTHOR}${label}`);
  const key = Buffer.from(hkdfSync('sha256', SECRET, Buffer.alloc(32), info, 32));
  const cipher = createCipheriv('aes-256-gcm', key, IV);
  return { encPayload: Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]), encIv: IV };
}

/** A vote or an RSVP sealed as the library's decryptPollVote and decryptEventResponse read them. */
function sealResponse(label, targetId, responder, plaintext) {
  const key0 = createHmac('sha256', Buffer.alloc(32)).update(SECRET).digest();
  const sign = Buffer.concat([
    Buffer.from(targetId),
    Buffer.from(AUTHOR),
    Buffer.from(responder),
    Buffer.from(label),
    Buffer.from([1]),
  ]);
  const cipher = createCipheriv('aes-256-gcm', createHmac('sha256', key0).update(sign).digest(), IV);
  cipher.setAAD(Buffer.from(`${targetId}\u0000${responder}`));
  return { encPayload: Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]), encIv: IV };
}

const envelope = (id, sender, content) => ({
  key: { id, remoteJid: GROUP, participant: sender, fromMe: false },
  messageTimestamp: 1_786_000_100,
  message: wire(content),
});

const edit = () =>
  envelope('ENV-A', AUTHOR, {
    secretEncryptedMessage: {
      targetMessageKey: { id: 'ORIG1', remoteJid: GROUP, participant: AUTHOR, fromMe: false },
      secretEncType: lib.proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT,
      ...sealChange(
        'Message Edit',
        lib.proto.Message.encode({
          protocolMessage: {
            type: lib.proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
            key: { id: 'ORIG1', remoteJid: GROUP, participant: AUTHOR, fromMe: false },
            editedMessage: { conversation: 'edited text' },
            timestampMs: 1_786_000_000_250,
          },
        }).finish(),
      ),
    },
  });

const reaction = () =>
  envelope('REACT-A', AUTHOR, {
    encReactionMessage: {
      targetMessageKey: { id: 'ORIG1', remoteJid: GROUP, participant: AUTHOR, fromMe: false },
      ...sealChange(
        'Enc Reaction',
        lib.proto.Message.ReactionMessage.encode({ text: 'heart', senderTimestampMs: 1_786_000_000_999 }).finish(),
      ),
    },
  });

const vote = () =>
  envelope('VOTE-A', MEMBER, {
    pollUpdateMessage: {
      pollCreationMessageKey: { id: 'POLL1', remoteJid: GROUP, participant: AUTHOR, fromMe: false },
      senderTimestampMs: 1_786_000_000_123,
      vote: sealResponse(
        'Poll Vote',
        'POLL1',
        MEMBER,
        lib.proto.Message.PollVoteMessage.encode({
          selectedOptions: [createHash('sha256').update('Sushi').digest()],
        }).finish(),
      ),
    },
  });

const rsvp = () =>
  envelope('RSVP-A', MEMBER, {
    encEventResponseMessage: {
      eventCreationMessageKey: { id: 'EVT1', remoteJid: GROUP, participant: AUTHOR, fromMe: false },
      ...sealResponse(
        'Event Response',
        'EVT1',
        MEMBER,
        lib.proto.Message.EventResponseMessage.encode({
          response: lib.proto.Message.EventResponseMessage.EventResponseType.GOING,
          timestampMs: 1_786_000_000_500,
        }).finish(),
      ),
    },
  });

/** A session whose store fails until `answer()`, keeping what the adapter hands it, and reporting what lands. */
function session({ changeKept = false } = {}) {
  let failing = true;
  const kept = [];
  const landed = [];
  const to = kind => payload => landed.push({ kind, payload });
  const noop = () => undefined;
  const socket = { user: { id: '6280000000000:1@s.whatsapp.net' }, updateMediaMessage: noop };
  const events = new BaileysEvents({
    getSocket: () => socket,
    getSocketOrNull: () => socket,
    logger: silent,
    toNeutralJid: jid => jid.replace('@s.whatsapp.net', '@c.us'),
    normalizedSelfJid: () => SELF,
    loadLib: () => Promise.resolve(lib),
    getFetchDispatcher: () => undefined,
    inboundLimiter: new ConcurrencyLimiter(2),
    recordKeyLidMappings: noop,
    recordMessage: noop,
    recordMessageEdit: noop,
    putStoredMessage: () => undefined,
    updateStoredMessage: () => Promise.resolve(),
    consumeOwnSend: () => false,
    getStoredMessage: id =>
      failing
        ? Promise.reject(Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNREFUSED' }))
        : Promise.resolve(stored[id] ? storedMessage(id) : null),
    keepUnreadInbound: (msg, targetId) => kept.push({ raw: keptInboundRaw(lib, msg), targetId }),
    isChangeKept: () => changeKept,
    findContact: () => null,
    getOnMessage: () => to('message'),
    getOnMessageCreate: () => to('create'),
    getOnMessageRevoked: () => to('revoked'),
    getOnMessageEdited: () => to('edited'),
    getOnMessageReaction: () => to('reaction'),
    getOnPollVote: () => to('vote'),
    getOnEventResponse: () => to('rsvp'),
    getOnMessageAck: () => undefined,
    getOnGroupEvent: () => undefined,
    getOnCall: () => undefined,
    getOnPresenceUpdate: () => undefined,
    getOnCallOutcome: () => undefined,
  });
  return {
    events,
    kept,
    landed,
    answer: () => (failing = false),
    /** Waits for something to be kept, or to land, failing at a deadline rather than hanging. */
    until: async condition => {
      const deadline = Date.now() + 5_000;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error('Timed out');
        await new Promise(resolve => setImmediate(resolve));
      }
    },
  };
}

/** Keeps `msg` while the store fails, then hands its kept form back once the store answers; resolves what landed. */
async function keepAndHandBack(msg, { beforeUpsert, changeKept } = {}) {
  const s = session({ changeKept });
  beforeUpsert?.(s, msg);
  s.events.handleMessagesUpsert({ messages: [msg], type: 'notify' });
  await s.until(() => s.kept.length === 1);
  assert.deepEqual(s.landed, []);
  s.answer();
  await s.events.redeliverInbound(revivedInbound(lib, s.kept[0].raw));
  return { landed: s.landed, kept: s.kept };
}

test('an encrypted edit kept while its original could not be read lands with its text and time', async () => {
  const { landed, kept } = await keepAndHandBack(edit());
  assert.equal(kept[0].targetId, 'ORIG1');
  // The JSON form names the enum and spells the bytes as text: the round trip is what is checked.
  assert.match(kept[0].raw, /"secretEncType":"MESSAGE_EDIT"/);
  assert.equal(landed.length, 1);
  assert.equal(landed[0].kind, 'edited');
  assert.equal(landed[0].payload.messageId, 'ORIG1');
  assert.equal(landed[0].payload.body, 'edited text');
  assert.equal(landed[0].payload.timestamp, 1_786_000_000);
});

test('an encrypted reaction kept while its original could not be read lands with its emoji', async () => {
  const { landed } = await keepAndHandBack(reaction());
  assert.equal(landed.length, 1);
  assert.equal(landed[0].kind, 'reaction');
  assert.equal(landed[0].payload.messageId, 'ORIG1');
  assert.equal(landed[0].payload.reaction, 'heart');
});

test('a poll vote kept while its poll could not be read lands with its choice and its time to the millisecond', async () => {
  const { landed, kept } = await keepAndHandBack(vote());
  assert.match(kept[0].raw, /"senderTimestampMs":"1786000000123"/);
  assert.equal(landed.length, 1);
  assert.equal(landed[0].kind, 'vote');
  assert.deepEqual(landed[0].payload.selectedOptions, ['Sushi']);
  assert.equal(landed[0].payload.timestampMs, 1_786_000_000_123);
});

test('an RSVP the library could not read for a failed read of its event lands with its answer and time', async () => {
  const { landed } = await keepAndHandBack(rsvp(), {
    // The library reads the event with the key the RSVP carries, before the RSVP reaches the adapter.
    beforeUpsert: (s, msg) =>
      s.events.noteUnreadStoredMessage(msg.message.encEventResponseMessage.eventCreationMessageKey),
  });
  assert.equal(landed.length, 1);
  assert.equal(landed[0].kind, 'rsvp');
  assert.equal(landed[0].payload.eventMessageId, 'EVT1');
  assert.equal(landed[0].payload.response, 'going');
  assert.equal(landed[0].payload.timestamp, 1_786_000_000);
});

test('a plain edit kept behind a kept change of its message lands as an edit, its type read back from its name', async () => {
  const plain = envelope('ENV-B', AUTHOR, {
    protocolMessage: {
      type: lib.proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
      key: { id: 'ORIG1', remoteJid: GROUP, participant: AUTHOR, fromMe: false },
      editedMessage: { conversation: 'second edit' },
      timestampMs: 1_786_000_000_300,
    },
  });
  const { landed, kept } = await keepAndHandBack(plain, { changeKept: true });
  assert.match(kept[0].raw, /"type":"MESSAGE_EDIT"/);
  assert.equal(landed.length, 1);
  assert.equal(landed[0].kind, 'edited');
  assert.equal(landed[0].payload.body, 'second edit');
});
