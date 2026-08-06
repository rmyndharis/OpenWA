import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapEngineHistoryMessage, mergeChatMessages, type EngineHistoryMessage } from './chatMessages.ts';
import type { ChatMessage } from '../services/api';

const hist = (over: Partial<EngineHistoryMessage> = {}): EngineHistoryMessage => ({
  id: 'false_g@g.us_AAA',
  chatId: 'g@g.us',
  from: 'g@g.us',
  to: 'me@c.us',
  body: 'hello',
  type: 'text',
  timestamp: 1782053533,
  fromMe: false,
  ...over,
});

const db = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'row-1',
  waMessageId: 'true_g@g.us_BBB',
  chatId: 'g@g.us',
  from: 'me',
  to: 'g@g.us',
  body: 'sent',
  type: 'text',
  direction: 'outgoing',
  status: 'delivered',
  timestamp: 1782053999,
  createdAt: '2026-06-23T11:16:34.000Z',
  ...over,
});

test('mapEngineHistoryMessage: fromMe=true becomes an outgoing bubble', () => {
  assert.equal(mapEngineHistoryMessage(hist({ id: 'true_x', fromMe: true })).direction, 'outgoing');
});

test('mapEngineHistoryMessage: fromMe=false becomes an incoming bubble', () => {
  assert.equal(mapEngineHistoryMessage(hist({ fromMe: false })).direction, 'incoming');
});

test('mapEngineHistoryMessage: carries id into waMessageId so it dedups against DB rows', () => {
  const m = mapEngineHistoryMessage(hist({ id: 'false_g@g.us_ZZZ' }));
  assert.equal(m.waMessageId, 'false_g@g.us_ZZZ');
});

test('mapEngineHistoryMessage: derives createdAt from the unix timestamp', () => {
  const m = mapEngineHistoryMessage(hist({ timestamp: 1782053533 }));
  assert.equal(Date.parse(m.createdAt), 1782053533 * 1000);
});

test('mapEngineHistoryMessage: a media-type message with no loaded media gets an omitted marker', () => {
  // History is fetched without media (footprint), so an old media message arrives with no payload —
  // surface it as the omitted placeholder (📎 Media) instead of an empty bubble.
  const m = mapEngineHistoryMessage(hist({ type: 'image', media: undefined }));
  assert.equal(m.metadata?.media?.omitted, true);
});

test('mapEngineHistoryMessage: a media message that DID carry media keeps it (no marker override)', () => {
  const m = mapEngineHistoryMessage(hist({ type: 'image', media: { mimetype: 'image/png', data: 'BASE64' } }));
  assert.equal(m.metadata?.media?.data, 'BASE64');
  assert.equal(m.metadata?.media?.omitted, undefined);
});

test('mapEngineHistoryMessage: a text message gets no media metadata', () => {
  assert.equal(mapEngineHistoryMessage(hist({ type: 'text' })).metadata, undefined);
});

test('mergeChatMessages: an engine-only message (no DB row) is included — the backfill case', () => {
  const merged = mergeChatMessages([], [mapEngineHistoryMessage(hist())]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].body, 'hello');
});

test('mergeChatMessages: the DB row wins over the engine copy of the same message (keeps real status)', () => {
  const sameId = 'true_g@g.us_BBB';
  const fromEngine = mapEngineHistoryMessage(hist({ id: sameId, fromMe: true, body: 'sent' }));
  const merged = mergeChatMessages([db({ waMessageId: sameId, status: 'read' })], [fromEngine]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, 'read'); // DB status preserved, not the engine default
});

test('mergeChatMessages: returns ascending by timestamp (oldest first, newest last)', () => {
  const older = mapEngineHistoryMessage(hist({ id: 'a', timestamp: 1000 }));
  const newer = mapEngineHistoryMessage(hist({ id: 'b', timestamp: 2000 }));
  const merged = mergeChatMessages([], [newer, older]);
  assert.deepEqual(
    merged.map(m => m.id),
    ['a', 'b'],
  );
});

import {
  mergeOrAppend,
  updateMessageById,
  removeMessageById,
  findRevokedIndex,
  applyMessageEdit,
  senderKey,
  type ChatMessageView,
} from './chatMessages.ts';

const msg = (over: Partial<ChatMessageView> = {}): ChatMessageView => ({
  id: 'm-1',
  // Derive a distinct waMessageId per id by default (each WhatsApp message has its own), so dedup
  // keyed on `waMessageId ?? id` treats different ids as different messages. Override explicitly to
  // exercise the live-WS-vs-DB-copy case.
  waMessageId: `true_g@g.us_${over.id ?? 'm-1'}`,
  chatId: 'g@g.us',
  from: 'me',
  to: 'g@g.us',
  body: 'hello',
  type: 'text',
  direction: 'outgoing',
  status: 'sent',
  timestamp: 1782053999,
  createdAt: '2026-06-23T11:16:34.000Z',
  ...over,
});

test('mergeOrAppend appends when id is new', () => {
  const before = [msg({ id: 'm-1' })];
  const after = mergeOrAppend(before, msg({ id: 'm-2', body: 'world' }));
  assert.equal(after.length, 2);
  assert.equal(after[1].body, 'world');
});

test('mergeOrAppend replaces in place when id matches', () => {
  const before = [msg({ id: 'm-1', body: 'old' }), msg({ id: 'm-2' })];
  const after = mergeOrAppend(before, msg({ id: 'm-1', body: 'new' }));
  assert.equal(after.length, 2);
  assert.equal(after[0].body, 'new');
  assert.equal(after[1].id, 'm-2');
});

test('mergeOrAppend does NOT downgrade delivery status (a replayed "sent" echo keeps "read")', () => {
  const before = [msg({ id: 'm-1', status: 'read' })];
  const after = mergeOrAppend(before, msg({ id: 'm-1', status: 'sent', body: 'echo' }));
  assert.equal(after.length, 1);
  assert.equal(after[0].status, 'read'); // forward-only: not downgraded to sent
  assert.equal(after[0].body, 'echo'); // other fields still update
});

test('mergeOrAppend keeps existing metadata when the incoming copy carries none', () => {
  const before = [msg({ id: 'm-1', metadata: { media: { mimetype: 'image/png' } } })];
  const after = mergeOrAppend(before, msg({ id: 'm-1', metadata: undefined }));
  assert.deepEqual(after[0].metadata, { media: { mimetype: 'image/png' } });
});

test('mergeOrAppend: an omitted-media echo does NOT clobber the copy holding the payload', () => {
  // The optimistic send bubble holds the only base64 copy; the engine's own-send echo carries just
  // `{media: {omitted: true}}` (no data). Replacing wholesale would blank the sent image.
  const optimistic = msg({
    id: 'm-1',
    type: 'image',
    metadata: { media: { mimetype: 'image/png', filename: 'a.png', data: 'BASE64' } },
  });
  const echo = msg({
    id: 'm-1',
    type: 'image',
    metadata: { media: { mimetype: 'image/png', omitted: true, sizeBytes: 1234 } },
  });
  const after = mergeOrAppend([optimistic], echo);
  assert.equal(after.length, 1);
  assert.equal(after[0].metadata?.media?.data, 'BASE64');
  assert.equal(after[0].metadata?.media?.omitted, undefined);
});

test('mergeOrAppend: incoming media WITH a payload replaces the existing marker', () => {
  const before = [msg({ id: 'm-1', type: 'image', metadata: { media: { mimetype: 'image/png', omitted: true } } })];
  const live = msg({
    id: 'm-1',
    type: 'image',
    metadata: { media: { mimetype: 'image/png', data: 'FRESH' } },
  });
  const after = mergeOrAppend(before, live);
  assert.equal(after[0].metadata?.media?.data, 'FRESH');
});

test('mergeOrAppend: an echo with undefined leaves keeps the existing quote/call fields', () => {
  // The WS mapper builds metadata as `{media, quotedMessage, call}` with undefined leaves — those
  // must not erase fields the existing copy has (a wholesale spread would overwrite with undefined).
  const before = [msg({ id: 'm-1', metadata: { quotedMessage: { id: 'q-1', body: 'quoted' } } })];
  const echo = msg({ id: 'm-1', metadata: { media: undefined } });
  const after = mergeOrAppend(before, echo);
  assert.deepEqual(after[0].metadata, { quotedMessage: { id: 'q-1', body: 'quoted' } });
});

test('mergeOrAppend dedupes a live WS message against its DB copy (id != id but same waMessageId)', () => {
  // DB-persisted copy: id = UUID, waMessageId = WA serialized id.
  const dbCopy = msg({ id: 'uuid-1', waMessageId: 'true_g@g.us_WA1', body: 'persisted' });
  // The same WhatsApp message arriving live over WS, carrying the WA id.
  const live = msg({ id: 'true_g@g.us_WA1', waMessageId: 'true_g@g.us_WA1', body: 'live' });
  const after = mergeOrAppend([dbCopy], live);
  assert.equal(after.length, 1); // must NOT double-add the same message
  assert.equal(after[0].body, 'live');
});

test('mergeOrAppend does not mutate the input array', () => {
  const before = [msg({ id: 'm-1' })];
  const after = mergeOrAppend(before, msg({ id: 'm-2' }));
  assert.notEqual(after, before);
  assert.equal(before.length, 1);
});

test('updateMessageById applies a partial patch by id', () => {
  const before = [msg({ id: 'm-1', status: 'pending' })];
  const after = updateMessageById(before, 'm-1', { status: 'failed' });
  assert.equal(after[0].status, 'failed');
  assert.equal(after[0].body, 'hello'); // other fields unchanged
});

test('updateMessageById is a no-op when id is not present', () => {
  const before = [msg({ id: 'm-1' })];
  const after = updateMessageById(before, 'missing', { status: 'failed' });
  assert.deepEqual(after, before);
});

test('removeMessageById filters out the matching id', () => {
  const before = [msg({ id: 'm-1' }), msg({ id: 'm-2' })];
  const after = removeMessageById(before, 'm-1');
  assert.equal(after.length, 1);
  assert.equal(after[0].id, 'm-2');
});

test('removeMessageById is a no-op when id is not present', () => {
  const before = [msg({ id: 'm-1' })];
  const after = removeMessageById(before, 'missing');
  assert.deepEqual(after, before);
});

// message.revoked carries TWO candidate ids: `id` and `revokedId` (the original deleted message,
// when the engine could resolve it). Match on either — see findRevokedIndex for why not `?? `.

test('findRevokedIndex matches the original via revokedId when it differs from id (wwebjs)', () => {
  const list = [msg({ id: 'row-1', waMessageId: 'ORIGINAL' })];
  assert.equal(findRevokedIndex(list, { id: 'REVOKE_NOTIF', revokedId: 'ORIGINAL' }), 0);
});

test('findRevokedIndex still matches when id === revokedId (Baileys — guards the working path)', () => {
  const list = [msg({ id: 'row-1', waMessageId: 'ORIGINAL' })];
  assert.equal(findRevokedIndex(list, { id: 'ORIGINAL', revokedId: 'ORIGINAL' }), 0);
});

test('findRevokedIndex matches on id when revokedId is absent (original not in the engine store)', () => {
  const list = [msg({ id: 'row-1', waMessageId: 'ORIGINAL' })];
  assert.equal(findRevokedIndex(list, { id: 'ORIGINAL' }), 0);
});

test('findRevokedIndex matches the DB row id, not just waMessageId', () => {
  const list = [msg({ id: 'row-1', waMessageId: 'ORIGINAL' })];
  assert.equal(findRevokedIndex(list, { id: 'row-1' }), 0);
});

test('findRevokedIndex returns -1 when neither id matches', () => {
  const list = [msg({ id: 'row-1', waMessageId: 'ORIGINAL' })];
  assert.equal(findRevokedIndex(list, { id: 'REVOKE_NOTIF', revokedId: 'OTHER' }), -1);
});

test('findRevokedIndex ignores an undefined revokedId rather than matching a row with no waMessageId', () => {
  // A row whose waMessageId is undefined must not be matched by an absent revokedId (undefined ===
  // undefined would otherwise revoke an arbitrary bubble).
  const list = [msg({ id: 'row-1', waMessageId: undefined })];
  assert.equal(findRevokedIndex(list, { id: 'REVOKE_NOTIF' }), -1);
});

test('applyMessageEdit updates a persisted row by waMessageId without mutating the input', () => {
  const before = [msg({ id: 'row-uuid', waMessageId: 'WA_EDIT_1', body: 'old' })];
  const after = applyMessageEdit(before, { messageId: 'WA_EDIT_1', body: 'new' });

  assert.notEqual(after, before);
  assert.equal(after[0].body, 'new');
  assert.equal(before[0].body, 'old');
});

test('applyMessageEdit updates a live row by id', () => {
  const before = [msg({ id: 'WA_EDIT_1', waMessageId: undefined, body: 'old' })];
  const after = applyMessageEdit(before, { messageId: 'WA_EDIT_1', body: '' });
  assert.equal(after[0].body, '');
});

test('applyMessageEdit is a referential no-op for an empty or unknown target id', () => {
  const before = [msg({ id: 'm-1', body: 'old' })];
  assert.equal(applyMessageEdit(before, { messageId: '', body: 'new' }), before);
  assert.equal(applyMessageEdit(before, { messageId: 'missing', body: 'new' }), before);
});

test('mapEngineHistoryMessage: carries the group participant JID as author', () => {
  const m = mapEngineHistoryMessage(hist({ author: '628111@c.us' }));
  assert.equal(m.author, '628111@c.us');
});

test('mergeChatMessages: salvages author from the engine copy when the DB row predates the column', () => {
  // A legacy DB row (no stable sender id) merged over an engine-history copy that has one must not
  // lose it — that id is what keeps same-named participants in separate attribution runs.
  const history = [mapEngineHistoryMessage(hist({ id: 'WA_S1', author: '628111@c.us' }))];
  const rows = [db({ waMessageId: 'WA_S1', author: undefined })];
  const merged = mergeChatMessages(rows, history);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].author, '628111@c.us');
  // …while the rest of the winning DB row (authoritative status) is untouched.
  assert.equal(merged[0].status, 'delivered');
});

test('mergeChatMessages: a DB-persisted author wins over the engine copy', () => {
  const history = [mapEngineHistoryMessage(hist({ id: 'WA_S2', author: '628111@c.us' }))];
  const rows = [db({ waMessageId: 'WA_S2', author: '628222@c.us' })];
  assert.equal(mergeChatMessages(rows, history)[0].author, '628222@c.us');
});

test('mergeOrAppend: an author-less echo keeps the cached author', () => {
  const list = [msg({ id: 'WA_E1', waMessageId: 'WA_E1', author: '628111@c.us' })];
  const echo = msg({ id: 'WA_E1', waMessageId: 'WA_E1', author: undefined, body: 'echo' });
  const out = mergeOrAppend(list, echo);
  assert.equal(out[0].author, '628111@c.us');
});

test('senderKey prefers the participant JID and falls back to the display name', () => {
  assert.equal(senderKey({ author: '628111@c.us', chatName: 'Alice' }), '628111@c.us');
  assert.equal(senderKey({ chatName: 'Alice' }), 'Alice');
  assert.equal(senderKey({}), undefined);
});

import { capMediaPayloads, MEDIA_PAYLOAD_CACHE_LIMIT } from './chatMessages.ts';

const mediaMsg = (id: string, data?: string): ChatMessageView =>
  msg({ id, type: 'image', metadata: { media: { mimetype: 'image/jpeg', filename: `${id}.jpg`, data } } });

test('capMediaPayloads: under the limit the list is returned untouched (stable reference)', () => {
  const list = [mediaMsg('m-1', 'AAA'), mediaMsg('m-2', 'BBB'), msg({ id: 'm-3' })];
  assert.equal(capMediaPayloads(list), list);
});

test('the media cap covers the whole fetch window (no dead-end placeholder inside it)', () => {
  // useChatMessages fetches a 100-message slice WITH media and caches it at staleTime: Infinity.
  // A cap below the window strips payloads the user can scroll to, with no refetch path — the
  // stripped rows render the 📎 placeholder forever even though the payload was fetched.
  assert.ok(MEDIA_PAYLOAD_CACHE_LIMIT >= 100);
});

test('capMediaPayloads: past the limit the OLDEST payloads strip to the omitted marker, newest stay', () => {
  // One over the cap, so exactly the oldest payload must go.
  const list = Array.from({ length: MEDIA_PAYLOAD_CACHE_LIMIT + 1 }, (_, i) => mediaMsg(`m-${i}`, `PAYLOAD_${i}`));
  const capped = capMediaPayloads(list);
  const stripped = capped[0].metadata?.media;
  assert.equal(stripped?.data, undefined);
  assert.equal(stripped?.omitted, true); // renders the 📎 placeholder, not an empty bubble
  assert.equal(stripped?.mimetype, 'image/jpeg'); // type/filename survive the strip
  assert.equal(capped[1].metadata?.media?.data, 'PAYLOAD_1');
  assert.equal(capped[MEDIA_PAYLOAD_CACHE_LIMIT].metadata?.media?.data, `PAYLOAD_${MEDIA_PAYLOAD_CACHE_LIMIT}`);
  // The retained payload count is exactly the cap.
  assert.equal(capped.filter(m => m.metadata?.media?.data).length, MEDIA_PAYLOAD_CACHE_LIMIT);
  // Input is not mutated.
  assert.equal(list[0].metadata?.media?.data, 'PAYLOAD_0');
});

test('capMediaPayloads: rows already carrying only the omitted marker are not counted as payloads', () => {
  const omitted = mediaMsg('m-0', undefined);
  omitted.metadata = { media: { mimetype: '', omitted: true } };
  const list = [omitted, ...Array.from({ length: MEDIA_PAYLOAD_CACHE_LIMIT }, (_, i) => mediaMsg(`m-${i}`, 'X'))];
  const capped = capMediaPayloads(list);
  assert.equal(capped.filter(m => m.metadata?.media?.data).length, MEDIA_PAYLOAD_CACHE_LIMIT);
  assert.equal(capped[0].metadata?.media?.omitted, true);
});

test('mergeOrAppend enforces the payload cap on a live media append', () => {
  const list = Array.from({ length: MEDIA_PAYLOAD_CACHE_LIMIT }, (_, i) => mediaMsg(`m-${i}`, `PAYLOAD_${i}`));
  const after = mergeOrAppend(list, mediaMsg('m-new', 'NEW'));
  assert.equal(after.filter(m => m.metadata?.media?.data).length, MEDIA_PAYLOAD_CACHE_LIMIT);
  assert.equal(after[0].metadata?.media?.data, undefined); // oldest stripped
  assert.equal(after[0].metadata?.media?.omitted, true);
  assert.equal(after[after.length - 1].metadata?.media?.data, 'NEW'); // fresh append keeps its payload
});

test('mergeChatMessages enforces the payload cap on the initial load', () => {
  const rows = Array.from({ length: MEDIA_PAYLOAD_CACHE_LIMIT + 2 }, (_, i) =>
    db({
      id: `row-${i}`,
      waMessageId: `WA_${i}`,
      type: 'image',
      timestamp: 1782053999 + i,
      metadata: { media: { mimetype: 'image/jpeg', data: `DB_${i}` } },
    }),
  );
  const merged = mergeChatMessages(rows, []);
  assert.equal(merged.filter(m => m.metadata?.media?.data).length, MEDIA_PAYLOAD_CACHE_LIMIT);
  assert.equal(merged[0].metadata?.media?.omitted, true);
  assert.equal(merged[1].metadata?.media?.omitted, true);
  assert.equal(merged[2].metadata?.media?.data, 'DB_2'); // newest MEDIA_PAYLOAD_CACHE_LIMIT survive
});
