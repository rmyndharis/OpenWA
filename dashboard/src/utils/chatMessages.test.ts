import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMentionNameMap,
  resolveMentions,
  stripMentionDelimiters,
  mapEngineHistoryMessage,
  mergeChatMessages,
  mergeReactionSnapshot,
  liveMessageMetadata,
  type EngineHistoryMessage,
} from './chatMessages.ts';
import { MENTION_CLOSE, MENTION_OPEN } from './messageFormatter.ts';
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
  isGroup: true,
  kind: 'group',
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

test('liveMessageMetadata: carries inbound prompt buttons from the live WS payload', () => {
  const buttons = [
    { id: 'yes', text: 'Sim' },
    { id: 'no', text: 'Não' },
  ];
  assert.deepEqual(liveMessageMetadata({ buttons }), { buttons });
});

test('liveMessageMetadata: prefers an existing metadata bag over top-level fields', () => {
  const metadata = { quotedMessage: { id: 'q', body: 'hi' } };
  assert.deepEqual(liveMessageMetadata({ buttons: [{ id: 'yes', text: 'Sim' }], metadata }), metadata);
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
  // The optimistic send bubble holds the only base64 copy; a Baileys API-send echo carries just
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

test('mergeOrAppend: DB-persisted prompt buttons survive a button-less echo', () => {
  const buttons = [{ id: 'yes', text: 'Sim' }];
  const before = [msg({ id: 'm-1', metadata: { buttons } })];
  const echo = msg({ id: 'm-1', metadata: { media: undefined } });
  const after = mergeOrAppend(before, echo);
  assert.deepEqual(after[0].metadata?.buttons, buttons);
});

test('mergeOrAppend preserves poll choices across duplicate and partial echoes', () => {
  const poll = { name: 'Lunch?', options: ['Rice', 'Soup'], allowMultipleAnswers: false };
  const before = msg({ type: 'poll', metadata: { poll } });
  for (const metadata of [{ poll }, { media: undefined }]) {
    const after = mergeOrAppend([before], msg({ type: 'poll', metadata }));
    assert.deepEqual(after[0].metadata?.poll, poll);
    assert.deepEqual(before.metadata, { poll });
  }
  const updated = { ...poll, options: ['Rice', 'Soup', 'Salad'] };
  assert.deepEqual(
    mergeOrAppend([before], msg({ type: 'poll', metadata: { poll: updated } }))[0].metadata?.poll,
    updated,
  );
});

test('mergeOrAppend keeps revocation terminal and removes content metadata', () => {
  const original = msg({
    type: 'poll',
    metadata: {
      poll: { name: 'Lunch?', options: ['Rice', 'Soup'], allowMultipleAnswers: false },
      media: { mimetype: 'image/png', data: 'BASE64', archived: true },
      quotedMessage: { id: 'q', body: 'quote' },
      reactions: { me: 'yes' },
    },
  });
  const revoked = msg({ type: 'revoked', body: '', metadata: undefined });
  for (const [existing, incoming] of [
    [original, revoked],
    [revoked, original],
  ]) {
    const [result] = mergeOrAppend([existing], incoming);
    assert.equal(result.type, 'revoked');
    assert.equal(result.body, '');
    assert.equal(result.metadata, undefined);
  }
  const [newRevoked] = mergeOrAppend([], { ...original, type: 'revoked' });
  assert.equal(newRevoked.body, '');
  assert.equal(newRevoked.metadata, undefined);
  assert.equal(original.body, 'hello');
  assert.ok(original.metadata?.poll);
});

test('mergeChatMessages keeps every revoked copy terminal regardless of source or duplicate order', () => {
  const original = msg({
    type: 'poll',
    metadata: { poll: { name: 'Q', options: ['A'], allowMultipleAnswers: false } },
  });
  const revoked = { ...original, type: 'revoked' as const, body: '' };
  for (const [rows, history] of [
    [[original], [revoked]],
    [[revoked], [original]],
    [[revoked, original], []],
    [[original, revoked], []],
    [[], [revoked, original]],
    [[], [original, revoked]],
  ]) {
    const [result] = mergeChatMessages(rows, history);
    assert.equal(result.type, 'revoked');
    assert.equal(result.body, '');
    assert.equal(result.metadata, undefined);
  }
  assert.ok(original.metadata?.poll);
});

test('applyMessageEdit ignores a delayed edit for a revoked message', () => {
  const before = [msg({ type: 'revoked', body: '' })];
  assert.equal(applyMessageEdit(before, { messageId: before[0].waMessageId!, body: 'late' }), before);
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

test('capMediaPayloads bounds archived previews together with inline media', () => {
  const archive = mediaMsg('old-archive');
  archive.metadata!.media = { mimetype: 'image/jpeg', omitted: true, archived: true };
  const list = [archive, ...Array.from({ length: MEDIA_PAYLOAD_CACHE_LIMIT }, (_, i) => mediaMsg(`m-${i}`, 'X'))];
  const capped = capMediaPayloads(list);
  assert.equal(capped[0].metadata?.media?.archived, undefined);
  assert.equal(capped[0].metadata?.media?.omitted, true);
  assert.equal(list[0].metadata?.media?.archived, true, 'the source marker remains unchanged');
});

test('capMediaPayloads: under the limit the list is returned untouched (stable reference)', () => {
  const list = [mediaMsg('m-1', 'AAA'), mediaMsg('m-2', 'BBB'), msg({ id: 'm-3' })];
  assert.equal(capMediaPayloads(list), list);
});

test('the media cap is at least one fetched page (MESSAGE_PAGE_SIZE 100)', () => {
  // A cap below one page would strip payloads from the first page a chat opens with; past one page the
  // cap bounds the rendered set (see the MEDIA_PAYLOAD_CACHE_LIMIT doc).
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

// A `message.reaction` frame omits `reactions` when the gateway holds no stored copy of the message
// to snapshot from. Absent means "unknown", not "there are none" — and the difference is visible:
// the local user's own optimistic reaction lives under the `me` key in exactly that map.
test('mergeReactionSnapshot keeps the known map when the event carries no snapshot', () => {
  assert.deepEqual(mergeReactionSnapshot({ me: '👍' }, undefined), { me: '👍' });
});

test('mergeReactionSnapshot takes the snapshot when the event carries one', () => {
  assert.deepEqual(mergeReactionSnapshot({ me: '👍' }, { '628@c.us': '❤️' }), { '628@c.us': '❤️' });
});

test('mergeReactionSnapshot treats an EMPTY snapshot as an answer, not as absence', () => {
  // The last reaction being withdrawn is a real state the gateway reports as `{}`, and it must clear
  // the badge rather than fall back to the stale map. Note `{}` is truthy, so `||` and `??` agree
  // here — the absent-vs-empty distinction is destroyed one layer up if the socket mapper coerces
  // an absent key with `|| {}`, which is exactly the defect this function was extracted to expose.
  assert.deepEqual(mergeReactionSnapshot({ me: '👍' }, {}), {});
});

test('mergeReactionSnapshot stays undefined when neither side knows anything', () => {
  assert.equal(mergeReactionSnapshot(undefined, undefined), undefined);
});

test("buildMentionNameMap keys on the author JID's local part, stripped of a :device suffix", () => {
  const map = buildMentionNameMap([
    msg({ author: '166868170059932@lid', chatName: 'Sneha Desai' }),
    msg({ author: '628111:7@s.whatsapp.net', chatName: 'Group Admin' }),
  ]);
  assert.equal(map.get('166868170059932'), 'Sneha Desai');
  assert.equal(map.get('628111'), 'Group Admin');
});

test('buildMentionNameMap skips a row with no author or no resolved name', () => {
  const map = buildMentionNameMap([
    msg({ author: undefined, chatName: 'Sneha Desai' }),
    msg({ author: '628@c.us', chatName: undefined }),
  ]);
  assert.equal(map.size, 0);
});

// resolveMentions wraps a resolved name in the same PUA sentinels messageFormatter.ts's
// parseMessageBody splits into a `mention` node (rendered as a real <bdi>, outside Linkify's
// walk — see MessageBody.tsx). Tests assert against that wrapped form, not a plain "@Name" splice.
const wrap = (s: string) => `${MENTION_OPEN}${s}${MENTION_CLOSE}`;

test('resolveMentions replaces a matched @<digits> token with a mention-wrapped @<FirstName>', () => {
  const names = buildMentionNameMap([msg({ author: '166868170059932@lid', chatName: 'Sneha Desai' })]);
  assert.equal(resolveMentions('Hi @166868170059932, any update?', names), `Hi ${wrap('@Sneha')}, any update?`);
});

test('resolveMentions leaves an unmatched @<digits> token exactly as WhatsApp sent it', () => {
  const names = buildMentionNameMap([msg({ author: '166868170059932@lid', chatName: 'Sneha Desai' })]);
  assert.equal(resolveMentions('Hi @999999999, who is this?', names), 'Hi @999999999, who is this?');
});

test('resolveMentions does not touch a short @-token that is not a real mention (below the digit floor)', () => {
  const names = buildMentionNameMap([msg({ author: '166868170059932@lid', chatName: 'Sneha Desai' })]);
  assert.equal(resolveMentions('see item @42', names), 'see item @42');
});

test('resolveMentions is a no-op with an empty name map (skips the regex pass entirely)', () => {
  assert.equal(resolveMentions('Hi @166868170059932', new Map()), 'Hi @166868170059932');
});

test('buildMentionNameMap only keys a device-suffixed author when the :device part is stripped', () => {
  // Without .split(':')[0] the local part is '628111:7', fails /^\d+$/ and the entry is dropped.
  assert.equal(
    buildMentionNameMap([msg({ author: '628111:7@s.whatsapp.net', chatName: 'Ravi' })]).get('628111'),
    'Ravi',
  );
});

test('a push name is inserted verbatim, unstripped — a real <bdi> element is what keeps it from becoming a link, not character filtering', () => {
  const names = buildMentionNameMap([msg({ author: '6281112345@c.us', chatName: 'bit.ly/free' })]);
  assert.equal(resolveMentions('hi @6281112345', names), `hi ${wrap('@bit.ly/free')}`);
});

test('a push name that is a bare word linkify-react would auto-link ("localhost") is still mention-wrapped, not stripped', () => {
  const names = buildMentionNameMap([msg({ author: '6281112345@c.us', chatName: 'localhost' })]);
  assert.equal(resolveMentions('@6281112345', names), wrap('@localhost'));
});

test('resolveMentions needs a left boundary: start of text, whitespace, or opening punctuation', () => {
  const names = buildMentionNameMap([msg({ author: '12345678@c.us', chatName: 'Ravi' })]);
  assert.equal(resolveMentions('@12345678', names), wrap('@Ravi'));
  assert.equal(resolveMentions(' @12345678', names), ` ${wrap('@Ravi')}`);
  assert.equal(resolveMentions('(@12345678)', names), `(${wrap('@Ravi')})`);
  assert.equal(resolveMentions('[@12345678]', names), `[${wrap('@Ravi')}]`);
  assert.equal(resolveMentions('"@12345678"', names), `"${wrap('@Ravi')}"`);
  assert.equal(resolveMentions('*@12345678*', names), `*${wrap('@Ravi')}*`);
});

test('resolveMentions does not fire inside an email address', () => {
  const names = buildMentionNameMap([msg({ author: '12345678@c.us', chatName: 'Ravi' })]);
  assert.equal(resolveMentions('mail admin@12345678.com now', names), 'mail admin@12345678.com now');
});

test('resolveMentions does not fire in a URL path segment (a preceding "/" is not a left boundary)', () => {
  const names = buildMentionNameMap([msg({ author: '12345678@c.us', chatName: 'Ravi' })]);
  assert.equal(resolveMentions('see https://x.test/@12345678/profile', names), 'see https://x.test/@12345678/profile');
});

test('resolveMentions does not fire right after a backtick (an inline-code span is not a left boundary)', () => {
  const names = buildMentionNameMap([msg({ author: '12345678@c.us', chatName: 'Ravi' })]);
  assert.equal(resolveMentions('run `@12345678`', names), 'run `@12345678`');
});

test('resolveMentions resolves two mentions in the same message', () => {
  const names = buildMentionNameMap([
    msg({ author: '12345678@c.us', chatName: 'Ravi' }),
    msg({ author: '87654321@c.us', chatName: 'Sam' }),
  ]);
  assert.equal(resolveMentions('@12345678 @87654321', names), `${wrap('@Ravi')} ${wrap('@Sam')}`);
});

test('a push name blank after trimming is skipped, so the mention stays as WhatsApp sent it instead of a bare @', () => {
  const names = buildMentionNameMap([msg({ author: '6281112345@c.us', chatName: ' ' })]);
  assert.equal(names.size, 0);
  assert.equal(resolveMentions('@6281112345', names), '@6281112345');
});

test('a name made only of punctuation is not blank — it is a legitimate, if odd, push name now that character-stripping is gone', () => {
  const names = buildMentionNameMap([msg({ author: '6281112346@c.us', chatName: '///' })]);
  assert.equal(resolveMentions('@6281112346', names), wrap('@///'));
});

test('a push name of only U+3164 HANGUL FILLER is treated as blank, not as usable text', () => {
  // HANGUL FILLER renders as nothing but is not Unicode whitespace, so a plain .trim() check
  // alone would have let this through and rendered "@" with nothing after it.
  const names = buildMentionNameMap([msg({ author: '6281112345@c.us', chatName: 'ㅤㅤ' })]);
  assert.equal(names.size, 0);
  assert.equal(resolveMentions('@6281112345', names), '@6281112345');
});

test('a later usable name for the same participant is still picked up after a blank one', () => {
  const names = buildMentionNameMap([
    msg({ author: '6281112345@c.us', chatName: ' ' }),
    msg({ author: '6281112345@c.us', chatName: 'Ravi Kumar' }),
  ]);
  assert.equal(resolveMentions('@6281112345', names), wrap('@Ravi'));
});

test('a participant who changed their push name mid-thread resolves to the newest one, not the oldest', () => {
  const names = buildMentionNameMap([
    msg({ author: '6281112345@c.us', chatName: 'Ravi Kumar' }),
    msg({ author: '6281112345@c.us', chatName: 'RK Office' }),
    msg({ author: '6281112345@c.us', chatName: ' ' }),
  ]);
  assert.equal(resolveMentions('@6281112345', names), wrap('@RK'));
});

test('resolveMentions leaves a mention inside a ``` code block alone, so the block still renders as code', () => {
  const names = buildMentionNameMap([msg({ author: '12345678@c.us', chatName: 'Ravi' })]);
  assert.equal(resolveMentions('```\n@12345678\n```', names), '```\n@12345678\n```');
  assert.equal(resolveMentions('see `x` @12345678', names), `see \`x\` ${wrap('@Ravi')}`);
});

test('resolveMentions does not fire right after a closing backtick', () => {
  const names = buildMentionNameMap([msg({ author: '12345678@c.us', chatName: 'Ravi' })]);
  assert.equal(resolveMentions('`x`@12345678', names), '`x`@12345678');
});

test('a push name made only of other invisible code points is blank too, not just the Hangul filler', () => {
  for (const cp of [
    '\u200B',
    '\u00AD',
    '\u2060',
    '\u200E',
    '\u034F',
    '\u115F',
    '\u1160',
    '\uFFA0',
    '\u2800',
    '\u180E',
  ]) {
    const names = buildMentionNameMap([msg({ author: '6281112345@c.us', chatName: cp + cp })]);
    assert.equal(names.size, 0, `U+${cp.codePointAt(0)?.toString(16)} should count as blank`);
  }
  // A visible character among them keeps the name usable.
  const names = buildMentionNameMap([msg({ author: '6281112345@c.us', chatName: '\u200BRavi\u200B' })]);
  assert.equal(resolveMentions('@6281112345', names), wrap('@\u200BRavi\u200B'));
});

test('a push name carrying the span delimiters cannot close its own mention early', () => {
  const names = buildMentionNameMap([
    msg({ author: '6281112345@c.us', chatName: `X${MENTION_CLOSE}bit.ly/free ${MENTION_OPEN}Y` }),
  ]);
  assert.equal(resolveMentions('hi @6281112345', names), `hi ${wrap('@Xbit.ly/free')}`);
});

test('resolveMentions does not fire after "_" or "(" inside a URL, only when the opener run follows whitespace', () => {
  const names = buildMentionNameMap([msg({ author: '6281234567@c.us', chatName: 'Ann' })]);
  for (const body of ['https://x.example/p_@6281234567/doc', 'https://x.example/wiki/A_(@6281234567)']) {
    assert.equal(resolveMentions(body, names), body);
  }
  assert.equal(resolveMentions('hi _(@6281234567)_', names), `hi _(${wrap('@Ann')})_`);
  assert.equal(resolveMentions('`x`*@6281234567*', names), `\`x\`*${wrap('@Ann')}*`);
});

test('a span delimiter already in a raw body is dropped, so it can never parse as a mention', () => {
  const raw = `see ${MENTION_OPEN}*not bold* https://x.example${MENTION_CLOSE} end`;
  assert.equal(stripMentionDelimiters(raw), 'see *not bold* https://x.example end');
  assert.equal(resolveMentions(raw, new Map()), 'see *not bold* https://x.example end');
  const names = buildMentionNameMap([msg({ author: '6281112345@c.us', chatName: 'Ann' })]);
  assert.equal(resolveMentions(`${MENTION_OPEN} *hi* @6281112345`, names), ` *hi* ${wrap('@Ann')}`);
});

test('a push name whose first word is invisible renders its first visible word, not a bare @', () => {
  for (const blank of ['\u3164', '\u200B', '\u2800']) {
    const names = buildMentionNameMap([msg({ author: '6281112345@c.us', chatName: `${blank} Bob Smith` })]);
    assert.equal(resolveMentions('@6281112345', names), wrap('@Bob'));
  }
});

test('live and history poll choices survive metadata projection', () => {
  const poll = { name: 'Q', options: ['a', 'b'], allowMultipleAnswers: true };
  assert.deepEqual(liveMessageMetadata({ poll }), { poll });
  const mapped = mapEngineHistoryMessage({
    id: 'p',
    chatId: 'c@c.us',
    from: 'c@c.us',
    to: 'me',
    body: 'Q',
    type: 'poll',
    timestamp: 100,
    fromMe: false,
    isGroup: false,
    kind: 'individual',
    poll,
  });
  assert.deepEqual(mapped.metadata?.poll, poll);
});

test('legacy poll rows inherit available history choices without replacing stored state', () => {
  const poll = { name: 'Q', options: ['a', 'b'], allowMultipleAnswers: false };
  const historical = mapEngineHistoryMessage(hist({ type: 'poll', poll }));
  const stored = { ...historical, status: 'delivered' as const, metadata: { reactions: { sender: 'ok' } } };
  const merged = mergeChatMessages([stored], [historical])[0];
  assert.equal(merged.status, 'delivered');
  assert.deepEqual(merged.metadata, { reactions: { sender: 'ok' }, poll });
  const revoked = mergeChatMessages([{ ...stored, type: 'revoked', body: '', metadata: undefined }], [historical])[0];
  assert.equal(revoked.metadata?.poll, undefined);
});
