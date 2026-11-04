/**
 * Inbound Baileys messages through the REAL library and the compiled adapter code.
 *
 * Every jest lane maps @whiskeysockets/baileys to a stub whose getContentType is a bare mock and whose
 * normalizeMessageContent is a hand-written copy, so no test ever ran the helpers that decide an
 * inbound message's type in production. This lane imports the real library, builds each message with
 * its own protobuf classes, and feeds it through the compiled BaileysEvents.handleMessagesUpsert, the
 * handler the socket's messages.upsert event reaches. A library upgrade that changes how a message is
 * typed or unwrapped fails here, not on a user's session.
 *
 * Runs over dist/, so it needs `npm run build` first: `npm run build && npm run test:engine-real`.
 * No network, no socket, no WhatsApp account: media downloads are switched off, so a media message
 * resolves to the omitted marker.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.MEDIA_DOWNLOAD_ENABLED = 'false';

const require = createRequire(import.meta.url);
const lib = await import('@whiskeysockets/baileys');
const { BaileysEvents } = require('../../dist/engine/adapters/baileys-events.js');
const { ConcurrencyLimiter } = require('../../dist/common/utils/concurrency-limiter.js');
const { baileysMessageText, extractBaileysBody } = require('../../dist/engine/adapters/baileys-message-mapper.js');

const SELF = '6280000000000@s.whatsapp.net';
const PEER = '6281111111111@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';
const LID = '123456789012345@lid';
const silent = { log() {}, debug() {}, verbose() {}, warn() {}, error() {} };

/**
 * Feed one message through the upsert handler and resolve with whichever callback it reaches first.
 * A message that reaches none resolves as 'none' once the handler has had time to settle.
 */
function deliver(object, { wire = false } = {}) {
  let message = lib.proto.WebMessageInfo.fromObject({ messageTimestamp: 1_700_000_000, ...object });
  // Encoded and decoded again, the message is in the form the socket hands over after reading the bytes.
  if (wire) message = lib.proto.WebMessageInfo.decode(lib.proto.WebMessageInfo.encode(message).finish());
  return new Promise(resolve => {
    const to = kind => payload => resolve({ kind, payload });
    const noop = () => undefined;
    const events = new BaileysEvents({
      getSocket: () => ({ updateMediaMessage: noop }),
      getSocketOrNull: () => null,
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
      updateStoredMessage: () => undefined,
      consumeOwnSend: () => false,
      getStoredMessage: () => undefined,
      getOnMessage: () => to('message'),
      getOnMessageCreate: () => to('create'),
      getOnMessageRevoked: () => to('revoked'),
      getOnMessageEdited: () => to('edited'),
      getOnMessageReaction: () => to('reaction'),
      getOnMessageAck: () => undefined,
      getOnGroupEvent: () => undefined,
      getOnCall: () => undefined,
      getOnPresenceUpdate: () => undefined,
      getOnCallOutcome: () => undefined,
    });
    events.handleMessagesUpsert({ messages: [message], type: 'notify' });
    setTimeout(() => resolve({ kind: 'none' }), 2000).unref();
  });
}

const inbound = (id, message, key = {}) => ({ key: { id, remoteJid: PEER, fromMe: false, ...key }, message });

test('a conversation message is text with its body', async () => {
  const { kind, payload } = await deliver(inbound('A1', { conversation: 'hello' }));
  assert.equal(kind, 'message');
  assert.equal(payload.type, 'text');
  assert.equal(payload.body, 'hello');
  assert.equal(payload.from, '6281111111111@c.us');
});

test('an extendedText message is text with its body', async () => {
  const { payload } = await deliver(inbound('A2', { extendedTextMessage: { text: 'see https://example.com' } }));
  assert.equal(payload.type, 'text');
  assert.equal(payload.body, 'see https://example.com');
});

test('an image is an image with its caption and the omitted media marker', async () => {
  const { payload } = await deliver(
    inbound('A3', { imageMessage: { caption: 'a photo', mimetype: 'image/jpeg', fileLength: 1024 } }),
  );
  assert.equal(payload.type, 'image');
  assert.equal(payload.body, 'a photo');
  assert.equal(payload.media?.omitted, true);
  assert.equal(payload.media?.mimetype, 'image/jpeg');
});

test('a push-to-talk audio is a voice message', async () => {
  const { payload } = await deliver(inbound('A4', { audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } }));
  assert.equal(payload.type, 'voice');
  assert.equal(payload.media?.omitted, true);
});

test('a plain document is a document with its mimetype', async () => {
  const { payload } = await deliver(
    inbound('A5', { documentMessage: { mimetype: 'application/pdf', fileName: 'a.pdf' } }),
  );
  assert.equal(payload.type, 'document');
  assert.equal(payload.media?.mimetype, 'application/pdf');
});

test('a captioned document is unwrapped, with the caption as its body', async () => {
  const { payload } = await deliver(
    inbound('A6', {
      documentWithCaptionMessage: {
        message: { documentMessage: { mimetype: 'application/pdf', fileName: 'b.pdf', caption: 'the report' } },
      },
    }),
  );
  assert.equal(payload.type, 'document');
  assert.equal(payload.body, 'the report');
});

test('a disappearing-chat wrapper is typed by its inner content', async () => {
  const { payload } = await deliver(
    inbound('A7', { ephemeralMessage: { message: { extendedTextMessage: { text: 'gone soon' } } } }),
  );
  assert.equal(payload.type, 'text');
  assert.equal(payload.body, 'gone soon');
});

test('a view-once wrapper is typed by its inner content', async () => {
  const { payload } = await deliver(
    inbound('A8', { viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/jpeg', viewOnce: true } } } }),
  );
  assert.equal(payload.type, 'image');
});

// Real messages carry these sidecar keys beside the content; the real getContentType skips them.
test('messageContextInfo and senderKeyDistributionMessage do not change the type', async () => {
  const { payload } = await deliver(
    inbound('A9', {
      senderKeyDistributionMessage: { groupId: GROUP },
      messageContextInfo: { messageSecret: Buffer.alloc(32, 1) },
      conversation: 'with sidecars',
    }),
  );
  assert.equal(payload.type, 'text');
  assert.equal(payload.body, 'with sidecars');
});

test('a reaction reaches the reaction callback, not onMessage', async () => {
  const { kind, payload } = await deliver(
    inbound('A10', { reactionMessage: { key: { id: 'TARGET1', remoteJid: PEER, fromMe: true }, text: '👍' } }),
  );
  assert.equal(kind, 'reaction');
  assert.equal(payload.messageId, 'TARGET1');
  assert.equal(payload.reaction, '👍');
});

test('an edit reaches the edited callback with the new text', async () => {
  const { kind, payload } = await deliver(
    inbound('A11', {
      protocolMessage: {
        type: lib.proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
        key: { id: 'TARGET2', remoteJid: PEER, fromMe: false },
        editedMessage: { conversation: 'fixed typo' },
      },
    }),
  );
  assert.equal(kind, 'edited');
  assert.equal(payload.messageId, 'TARGET2');
  assert.equal(payload.body, 'fixed typo');
});

test('a delete for everyone reaches the revoked callback', async () => {
  const { kind, payload } = await deliver(
    inbound('A12', {
      protocolMessage: {
        type: lib.proto.Message.ProtocolMessage.Type.REVOKE,
        key: { id: 'TARGET3', remoteJid: PEER, fromMe: false },
      },
    }),
  );
  assert.equal(kind, 'revoked');
  assert.equal(payload.revokedId, 'TARGET3');
});

// pollCreationMessageV4 wraps a whole message that the library's normalizeMessageContent does not open, and
// pollCreationMessageV5 adds quiz fields. Both come from the proto schema; no live capture of either exists.
const POLL = {
  name: 'Lunch?',
  options: [{ optionName: 'Rice' }, { optionName: 'Noodles' }],
  selectableOptionsCount: 1,
};
for (const [label, message] of [
  ['pollCreationMessage', { pollCreationMessage: POLL }],
  ['pollCreationMessageV2', { pollCreationMessageV2: POLL }],
  ['pollCreationMessageV3', { pollCreationMessageV3: POLL }],
  ['pollCreationMessageV4', { pollCreationMessageV4: { message: { pollCreationMessage: POLL } } }],
  [
    'pollCreationMessageV5',
    {
      pollCreationMessageV5: {
        ...POLL,
        pollType: lib.proto.Message.PollType.QUIZ,
        correctAnswer: { optionName: 'Rice' },
      },
    },
  ],
]) {
  test(`a poll under ${label}, read from its wire bytes, is a poll with its question and options`, async () => {
    const { kind, payload } = await deliver(inbound(`P-${label}`, message), { wire: true });
    assert.equal(kind, 'message');
    assert.equal(payload.type, 'poll');
    assert.equal(payload.body, 'Lunch?');
    assert.deepEqual(payload.poll, { name: 'Lunch?', options: ['Rice', 'Noodles'], allowMultipleAnswers: false });
  });
}

test('a poll vote does not reach onMessage', async () => {
  // deliver's settle timer is unref'd, so hold the event loop open until it fires.
  const hold = setTimeout(() => undefined, 3000);
  const { kind } = await deliver(
    inbound('P-vote', {
      pollUpdateMessage: {
        pollCreationMessageKey: { id: 'POLL1', remoteJid: PEER, fromMe: true },
        vote: { encPayload: Buffer.alloc(16, 1), encIv: Buffer.alloc(12, 2) },
        senderTimestampMs: 1_700_000_000_000,
      },
    }),
    { wire: true },
  );
  clearTimeout(hold);
  assert.equal(kind, 'none');
});

test('a group message from an @lid participant names its author and flags the lid sender', async () => {
  const { payload } = await deliver(
    inbound('A13', { conversation: 'hi group' }, { remoteJid: GROUP, participant: LID }),
  );
  assert.equal(payload.isGroup, true);
  assert.equal(payload.type, 'text');
  assert.equal(payload.author, LID);
  assert.equal(payload.isLidSender, true);
});

// The chat preview reads a message's text without the library at hand, so it opens the envelopes itself; it must
// open them as the library's normalizeMessageContent does, or a wrapped message previews blank again.
for (const [label, message] of [
  ['a disappearing-chat text', { ephemeralMessage: { message: { extendedTextMessage: { text: 'gone soon' } } } }],
  ['a captioned photo', { imageMessage: { caption: 'the receipt', mimetype: 'image/jpeg' } }],
  [
    'a captioned document',
    {
      documentWithCaptionMessage: {
        message: { documentMessage: { caption: 'the report', mimetype: 'application/pdf' } },
      },
    },
  ],
  ['a view-once video', { viewOnceMessageV2: { message: { videoMessage: { caption: 'look once' } } } }],
  [
    'a view-once photo in a disappearing chat',
    { ephemeralMessage: { message: { viewOnceMessage: { message: { imageMessage: { caption: 'twice wrapped' } } } } } },
  ],
]) {
  test(`the preview text of ${label}, read from its wire bytes, is the body the library unwraps`, () => {
    const decoded = lib.proto.Message.decode(lib.proto.Message.encode(lib.proto.Message.fromObject(message)).finish());
    const expected = extractBaileysBody(lib.normalizeMessageContent(decoded));
    assert.notEqual(expected, '');
    assert.equal(baileysMessageText(decoded), expected);
  });
}
