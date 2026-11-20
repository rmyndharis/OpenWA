/**
 * What Baileys' event buffer hands the adapter when several events of one kind arrive while it is on: from a linked
 * account's connect until the offline marker, and around every node the socket processes. Through the REAL library
 * buffer, as scripts/patch-baileys-event-buffer.js leaves it, into the compiled adapter (lifecycle listeners, group and
 * RSVP handlers, session store).
 *
 * Runs over dist/ and needs the install-time patches applied (npm install runs them):
 * `npm run build && node --test test/engine-real/baileys-event-buffer.spec.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startSession, until } from './support/baileys-session.mjs';

const GROUP = '120363000000000001@g.us';
const OTHER_GROUP = '120363000000000002@g.us';
const ADMIN = '111111111111111@lid';
const LID = '222222222222222@lid';
const PN = '6282222222222@s.whatsapp.net';

test('every change of a group that arrives in one buffer window is announced, in order', async t => {
  const reported = [];
  const { sock } = await startSession(t, { callbacks: { onGroupEvent: event => reported.push(event) } });
  sock.ev.buffer();
  sock.ev.emit('groups.update', [{ id: GROUP, subject: 'New name', author: ADMIN }]);
  sock.ev.emit('groups.update', [{ id: GROUP, desc: 'New description', author: ADMIN }]);
  sock.ev.emit('groups.update', [{ id: GROUP, announce: true, author: ADMIN }]);
  sock.ev.flush();
  assert.deepEqual(
    reported.map(event => [event.groupId, event.changes]),
    [
      [GROUP, { subject: 'New name' }],
      [GROUP, { description: 'New description' }],
      [GROUP, { announce: true }],
    ],
  );
});

test('a change that follows a snapshot of its group in one window is announced, and the snapshot is not', async t => {
  const reported = [];
  const { sock } = await startSession(t, { callbacks: { onGroupEvent: event => reported.push(event) } });
  sock.ev.buffer();
  // groupFetchAllParticipating emits the whole metadata of every group through the same event
  sock.ev.emit('groups.update', [
    { id: GROUP, subject: 'Old name', participants: [], creation: 1, subjectTime: 1, owner: ADMIN, size: 1 },
    { id: OTHER_GROUP, subject: 'Other', participants: [], creation: 1, subjectTime: 1, owner: ADMIN, size: 1 },
  ]);
  sock.ev.emit('groups.update', [{ id: GROUP, restrict: true, author: ADMIN }]);
  sock.ev.flush();
  assert.deepEqual(
    reported.map(event => [event.groupId, event.changes]),
    [[GROUP, { locked: true }]],
  );
});

test('the lid to phone pairs of a history sync emitted while the buffer is on are learned', async t => {
  const { adapter, sock } = await startSession(t);
  const history = pairs => ({ chats: [], contacts: [], messages: [], lidPnMappings: pairs, syncType: 0, progress: 50 });
  sock.ev.buffer();
  sock.ev.emit('messaging-history.set', history([{ lid: LID, pn: PN }]));
  sock.ev.emit('messaging-history.set', history([{ lid: ADMIN, pn: '6281111111111@s.whatsapp.net' }]));
  sock.ev.flush();
  assert.equal(adapter.sessionStore.resolvePhone(LID), '6282222222222');
  assert.equal(adapter.sessionStore.resolvePhone(ADMIN), '6281111111111');
});

test('every answer to one event that arrives in one buffer window is reported', async t => {
  const reported = [];
  const { sock } = await startSession(t, { callbacks: { onEventResponse: event => reported.push(event) } });
  const eventKey = { remoteJid: GROUP, id: 'EVENT1', fromMe: true };
  // One messages.update per decrypted RSVP, keyed by the event, as Utils/process-message.js emits it
  const rsvp = (guest, id, response) => [
    {
      key: eventKey,
      update: {
        eventResponses: [
          {
            eventResponseMessageKey: { remoteJid: GROUP, id, fromMe: false, participant: guest },
            senderTimestampMs: 1_786_000_000_000,
            response: { response, timestampMs: 1_786_000_000_000 },
          },
        ],
      },
    },
  ];
  sock.ev.buffer();
  sock.ev.emit('messages.update', rsvp(ADMIN, 'RSVP1', 1));
  sock.ev.emit('messages.update', rsvp(LID, 'RSVP2', 2));
  sock.ev.emit('messages.update', rsvp(ADMIN, 'RSVP3', 2));
  sock.ev.flush();
  await until(() => reported.length >= 3, 'three event responses', 10_000);
  assert.deepEqual(reported.map(event => event.responseMessageId).sort(), ['RSVP1', 'RSVP2', 'RSVP3']);
});
