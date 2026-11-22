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
  unacknowledgedIncomingIds,
  getMediaSrc,
  inertMediaMimetype,
  inlineMediaToBlob,
  normalizeSessionPhone,
  isOwnReactionSender,
  ownReactionKey,
  toggleOwnReaction,
  applyOwnReaction,
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
  isRenderableMessage,
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

test('applyMessageEdit does not label a message whose text the event repeats', () => {
  const before = [msg({ id: 'm-1', waMessageId: 'WA_EDIT_2', body: 'same', metadata: { reactions: { me: 'x' } } })];
  const after = applyMessageEdit(before, { messageId: 'WA_EDIT_2', body: 'same' });
  // The same list, so nothing renders again; compared as a boolean, since a failed deepEqual of rows is slow to print.
  assert.ok(after === before, 'an unchanged text produced a new list');
  assert.equal(after[0].metadata?.edited, undefined);
  assert.deepEqual(after[0].metadata?.reactions, { me: 'x' });
});

test('liveMessageMetadata: carries the edited mark of a message announced as edited', () => {
  const media = { mimetype: 'image/png', data: 'QUJD' };
  assert.deepEqual(liveMessageMetadata({ edited: true }), { edited: true });
  assert.deepEqual(liveMessageMetadata({ media, edited: true }), { media, edited: true });
  assert.deepEqual(liveMessageMetadata({ metadata: { reactions: { me: 'x' } }, edited: true }), {
    reactions: { me: 'x' },
    edited: true,
  });
  assert.equal(liveMessageMetadata({}), undefined);
});

// The gateway announces the edit of a message it had not stored yet before the message itself, which then carries
// the edited text and the mark.
test('a message announced as edited after its edit missed the thread is labelled edited', () => {
  const missed = applyMessageEdit([], { messageId: 'WA_EDIT_3', body: 'fixed' });
  const live = { body: 'fixed', edited: true as const };
  const after = mergeOrAppend(missed, msg({ id: 'WA_EDIT_3', body: live.body, metadata: liveMessageMetadata(live) }));

  assert.equal(after[0].metadata?.edited, true);
  const echo = mergeOrAppend(after, msg({ id: 'WA_EDIT_3', body: 'fixed', metadata: liveMessageMetadata({}) }));
  assert.equal(echo[0].metadata?.edited, true, 'a later copy without the mark took it away');
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

import { capMediaPayloads, MEDIA_PAYLOAD_CACHE_LIMIT, mergeDeliveryStatus } from './chatMessages.ts';

const mediaMsg = (id: string, data?: string): ChatMessageView =>
  msg({ id, type: 'image', metadata: { media: { mimetype: 'image/jpeg', filename: `${id}.jpg`, data } } });

test('capMediaPayloads bounds archived previews together with inline media', () => {
  const archive = { ...mediaMsg('old-archive'), mediaPath: 'media/old-archive.jpg' };
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

test('capMediaPayloads: archived documents are download buttons, not previews, and are not counted', () => {
  const document = (id: string): ChatMessageView =>
    msg({ id, type: 'document', metadata: { media: { mimetype: 'application/pdf', omitted: true, archived: true } } });
  const images = Array.from({ length: MEDIA_PAYLOAD_CACHE_LIMIT }, (_, i) => mediaMsg(`m-${i}`, 'X'));
  const list = [...Array.from({ length: 5 }, (_, i) => document(`d-${i}`)), ...images];
  assert.equal(capMediaPayloads(list), list, 'only the images count, and they fit');
});

// Retention deletes an archived copy and nulls the row's mediaPath, while a row an older gateway wrote can keep its
// archived marker. Such a row is a download button, not a preview, so it takes no place a payload could hold.
test('capMediaPayloads: an archived marker whose copy is gone is not counted', () => {
  const purged = msg({
    id: 'purged',
    type: 'image',
    mediaPath: null,
    metadata: { media: { mimetype: 'image/jpeg', omitted: true, archived: true } },
  });
  const images = Array.from({ length: MEDIA_PAYLOAD_CACHE_LIMIT }, (_, i) => mediaMsg(`m-${i}`, 'X'));
  const list = [purged, ...images];
  assert.equal(capMediaPayloads(list), list, 'the purged row pushed a payload out');
});

test('capMediaPayloads: omitted markers that follow a full set of payloads strip none of them', () => {
  const images = Array.from({ length: MEDIA_PAYLOAD_CACHE_LIMIT }, (_, i) => mediaMsg(`m-${i}`, 'X'));
  const omitted = Array.from({ length: 120 }, (_, i) =>
    msg({ id: `o-${i}`, type: 'image', metadata: { media: { mimetype: 'image/jpeg', omitted: true } } }),
  );
  const list = [...images, ...omitted];
  assert.equal(capMediaPayloads(list), list);
});

test('mergeDeliveryStatus: a late lower tick never downgrades the shown one, and failed applies only before delivery', () => {
  assert.equal(mergeDeliveryStatus('delivered', 'sent'), 'delivered');
  assert.equal(mergeDeliveryStatus('read', 'delivered'), 'read');
  assert.equal(mergeDeliveryStatus('sent', 'delivered'), 'delivered');
  assert.equal(mergeDeliveryStatus('pending', 'sent'), 'sent');
  assert.equal(mergeDeliveryStatus('delivered', 'failed'), 'delivered');
  assert.equal(mergeDeliveryStatus('sent', 'failed'), 'failed');
  assert.equal(mergeDeliveryStatus('failed', 'read'), 'failed');
});

test('applyMessageEdit marks the message and preserves reactions and media', () => {
  const metadata = { reactions: { alice: '👍' }, media: { mimetype: 'image/jpeg', data: 'test' } };
  const before = [msg({ id: 'edited', metadata })];
  const after = applyMessageEdit(before, { messageId: 'edited', body: 'new caption' });
  assert.deepEqual(after[0].metadata, { ...metadata, edited: true });
  assert.deepEqual(before[0].metadata, metadata);
});

test('applyMessageEdit cannot mark or restore a revoked message', () => {
  const before = [msg({ id: 'revoked', type: 'revoked', body: '' })];
  assert.equal(applyMessageEdit(before, { messageId: 'revoked', body: 'late edit' }), before);
});

test('a later message echo preserves the edited marker', () => {
  const before = [msg({ id: 'edited', waMessageId: 'edited', metadata: { edited: true } })];
  const after = mergeOrAppend(
    before,
    msg({ id: 'edited', waMessageId: 'edited', metadata: { reactions: { alice: '👍' } } }),
  );
  assert.equal(after[0].metadata?.edited, true);
  assert.deepEqual(after[0].metadata?.reactions, { alice: '👍' });
});

test('unacknowledgedIncomingIds names the newest incoming messages that no read has acknowledged', () => {
  const incoming = (n: number, over: Partial<ChatMessage> = {}): ChatMessage =>
    db({ id: `row-${n}`, waMessageId: `wamid.${n}`, direction: 'incoming', timestamp: n, ...over });
  const thread = [
    incoming(1),
    incoming(2, { direction: 'outgoing' }),
    incoming(3),
    incoming(4, { waMessageId: undefined }),
    // The gateway refuses an id with whitespace, and the whole read with it.
    incoming(5, { waMessageId: 'has space' }),
    incoming(6),
  ];

  assert.deepEqual(unacknowledgedIncomingIds(thread, new Set(), 100), ['wamid.1', 'wamid.3', 'wamid.6']);
  assert.deepEqual(unacknowledgedIncomingIds(thread, new Set(['wamid.3']), 100), ['wamid.1', 'wamid.6']);
  // Past the cap it is the newest that are named, in the order they were sent.
  assert.deepEqual(unacknowledgedIncomingIds(thread, new Set(), 2), ['wamid.3', 'wamid.6']);
  assert.deepEqual(unacknowledgedIncomingIds([], new Set(), 100), []);
});

test('mergeChatMessages: a tombstone the history lists twice still leaves one deleted row', () => {
  // Two pages of engine history can overlap, so the same tombstone can arrive twice.
  const storedRevoked = db({
    id: 'row-orig',
    waMessageId: 'true_15550001111@c.us_ORIG',
    chatId: '15550001111@c.us',
    from: '15559990000@c.us',
    to: '15550001111@c.us',
    body: '',
    type: 'revoked',
    direction: 'outgoing',
    status: 'delivered',
    timestamp: 1782054000,
    createdAt: '2026-06-23T11:20:00.000Z',
  });
  const tombstone = () =>
    mapEngineHistoryMessage(
      hist({
        id: 'true_15550001111@c.us_PROTO',
        chatId: '15550001111@c.us',
        from: '15559990000@c.us',
        to: '15550001111@c.us',
        body: '',
        type: 'revoked',
        fromMe: true,
        isGroup: false,
        kind: 'individual',
        timestamp: 1782054000,
      }),
    );
  const merged = mergeChatMessages([storedRevoked], [tombstone(), tombstone()]);
  assert.deepEqual(
    merged.map(m => [m.waMessageId, m.status]),
    [['true_15550001111@c.us_ORIG', 'delivered']],
  );
});

test('mergeChatMessages: a tombstone that pairs with its stored row by id does not use up another row twin', () => {
  // Two messages deleted in the same second by the same sender. The history names one by the id the
  // stored row has and the other by the id of its delete notice.
  const stored = (waMessageId: string) =>
    db({
      id: `row-${waMessageId}`,
      waMessageId,
      chatId: '15550001111@c.us',
      from: '15550001111@c.us',
      to: '15559990000@c.us',
      body: '',
      type: 'revoked',
      direction: 'incoming',
      status: 'delivered',
      timestamp: 1782054000,
      createdAt: '2026-06-23T11:20:00.000Z',
    });
  const tombstone = (id: string) =>
    mapEngineHistoryMessage(
      hist({
        id,
        chatId: '15550001111@c.us',
        from: '15550001111@c.us',
        to: '15559990000@c.us',
        body: '',
        type: 'revoked',
        fromMe: false,
        isGroup: false,
        kind: 'individual',
        timestamp: 1782054000,
      }),
    );
  const merged = mergeChatMessages(
    [stored('false_15550001111@c.us_SAME'), stored('false_15550001111@c.us_ORIG')],
    [tombstone('false_15550001111@c.us_SAME'), tombstone('false_15550001111@c.us_NOTICE')],
  );
  assert.deepEqual(merged.map(m => m.waMessageId).sort(), [
    'false_15550001111@c.us_ORIG',
    'false_15550001111@c.us_SAME',
  ]);
});

test('mergeChatMessages: deduplicates a history revoked twin in a 1:1 chat and keeps stored status', () => {
  const storedRevoked = db({
    id: 'row-orig',
    waMessageId: 'true_15550001111@c.us_ORIG',
    chatId: '15550001111@c.us',
    from: '15559990000@c.us',
    to: '15550001111@c.us',
    author: undefined,
    body: '',
    type: 'revoked',
    direction: 'outgoing',
    status: 'sent',
    timestamp: 1782054000,
    createdAt: '2026-06-23T11:20:00.000Z',
  });
  const historyRevoked = mapEngineHistoryMessage(
    hist({
      id: 'true_15550001111@c.us_PROTO',
      chatId: '15550001111@c.us',
      from: '15559990000@c.us',
      to: '15550001111@c.us',
      author: undefined,
      body: '',
      type: 'revoked',
      fromMe: true,
      isGroup: false,
      kind: 'individual',
      timestamp: 1782054000,
    }),
  );
  const merged = mergeChatMessages([storedRevoked], [historyRevoked]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].waMessageId, 'true_15550001111@c.us_ORIG');
  assert.equal(merged[0].status, 'sent');

  // Incoming 1:1 deleted message uses `from` in the same dialect.
  const incomingStored = db({
    id: 'row-in-orig',
    waMessageId: 'false_15550001111@c.us_ORIG',
    chatId: '15550001111@c.us',
    from: '15550001111@c.us',
    to: '15559990000@c.us',
    author: undefined,
    body: '',
    type: 'revoked',
    direction: 'incoming',
    status: 'delivered',
    timestamp: 1782054010,
  });
  const incomingHist = mapEngineHistoryMessage(
    hist({
      id: 'false_15550001111@c.us_PROTO',
      chatId: '15550001111@c.us',
      from: '15550001111@c.us',
      to: '15559990000@c.us',
      author: undefined,
      body: '',
      type: 'revoked',
      fromMe: false,
      isGroup: false,
      kind: 'individual',
      timestamp: 1782054010,
    }),
  );
  const mergedIn = mergeChatMessages([incomingStored], [incomingHist]);
  assert.equal(mergedIn.length, 1);
  assert.equal(mergedIn[0].waMessageId, 'false_15550001111@c.us_ORIG');
  assert.equal(mergedIn[0].status, 'delivered');
});

test('mergeChatMessages: deduplicates a history revoked twin in a group chat by author, direction, and timestamp', () => {
  const storedGroup = db({
    id: 'row-g-orig',
    waMessageId: 'false_g@g.us_ORIG_Alice',
    chatId: 'g@g.us',
    from: 'g@g.us',
    to: 'me@c.us',
    author: 'alice@c.us',
    body: '',
    type: 'revoked',
    direction: 'incoming',
    status: 'delivered',
    timestamp: 1782054100,
  });
  const historyGroup = mapEngineHistoryMessage(
    hist({
      id: 'false_g@g.us_PROTO_Alice',
      chatId: 'g@g.us',
      from: 'g@g.us',
      to: 'me@c.us',
      author: 'alice@c.us',
      body: '',
      type: 'revoked',
      fromMe: false,
      isGroup: true,
      kind: 'group',
      timestamp: 1782054100,
    }),
  );
  const merged = mergeChatMessages([storedGroup], [historyGroup]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].waMessageId, 'false_g@g.us_ORIG_Alice');
  assert.equal(merged[0].status, 'delivered');
});

test('mergeChatMessages: keeps unmatched history revoked rows and matches twins 1-to-1', () => {
  const histOnly = mapEngineHistoryMessage(
    hist({ id: 'false_g@g.us_HIST_ONLY', author: 'alice@c.us', type: 'revoked', timestamp: 1782054200 }),
  );
  assert.equal(mergeChatMessages([], [histOnly]).length, 1);
  assert.equal(mergeChatMessages([], [histOnly])[0].type, 'revoked');

  const storedOne = db({
    id: 'row-one',
    waMessageId: 'false_g@g.us_ORIG_1',
    author: 'alice@c.us',
    type: 'revoked',
    direction: 'incoming',
    status: 'delivered',
    timestamp: 1782054200,
  });
  // Different direction, sender, or timestamp do not merge.
  assert.equal(mergeChatMessages([{ ...storedOne, direction: 'outgoing' }], [histOnly]).length, 2);
  assert.equal(mergeChatMessages([{ ...storedOne, author: 'bob@c.us' }], [histOnly]).length, 2);
  assert.equal(mergeChatMessages([{ ...storedOne, timestamp: 1782054201 }], [histOnly]).length, 2);

  // Two history revoked rows in the same second vs one unmatched stored row consumes only one history twin.
  const histSecond = mapEngineHistoryMessage(
    hist({ id: 'false_g@g.us_HIST_2', author: 'alice@c.us', type: 'revoked', timestamp: 1782054200 }),
  );
  const twoHistVsOneStored = mergeChatMessages([storedOne], [histOnly, histSecond]);
  assert.equal(twoHistVsOneStored.length, 2);
  assert.deepEqual(twoHistVsOneStored.map(m => m.waMessageId).sort(), ['false_g@g.us_HIST_2', 'false_g@g.us_ORIG_1']);

  // A stored row already matched by ID (Baileys path) cannot also swallow a second history-only revoked row.
  const histSameId = mapEngineHistoryMessage(
    hist({ id: 'false_g@g.us_ORIG_1', author: 'alice@c.us', type: 'revoked', timestamp: 1782054200 }),
  );
  const idMatchedPlusExtra = mergeChatMessages([storedOne], [histSameId, histSecond]);
  assert.equal(idMatchedPlusExtra.length, 2);
});

test('mergeChatMessages: a deleted message listed under another form of the chat id is drawn once', () => {
  // Measured on a live session: the stored row is under the chat's lid and the history entry under the phone
  // number, with the same stanza. The sender can be in the other form too, and the time a second apart.
  const stored = db({
    id: 'row-lid',
    waMessageId: 'false_148@lid_3EB0FE6B',
    chatId: '148@lid',
    from: '148@lid',
    type: 'revoked',
    direction: 'incoming',
    status: 'read',
    timestamp: 1793549202,
    body: '',
  });
  const entry = (id: string, over: Partial<EngineHistoryMessage> = {}) =>
    mapEngineHistoryMessage(
      hist({ id, chatId: '148@lid', from: '628@c.us', type: 'revoked', timestamp: 1793549203, body: '', ...over }),
    );
  const drawn = (rows: ChatMessage[], history: ReturnType<typeof entry>[]) =>
    mergeChatMessages(rows, history).map(m => m.waMessageId);

  const merged = mergeChatMessages([stored], [entry('false_628@c.us_3EB0FE6B')]);
  assert.deepEqual(
    merged.map(m => [m.waMessageId, m.status]),
    [['false_148@lid_3EB0FE6B', 'read']],
  );
  // The other way round: a row stored while the chat was known by phone number, an entry under the lid.
  assert.deepEqual(
    drawn([db({ ...stored, waMessageId: 'false_628@c.us_3EB0FE6B' })], [entry('false_148@lid_3EB0FE6B')]),
    ['false_628@c.us_3EB0FE6B'],
  );
  // A group id has a fourth part, the author, and that part can be in the other form as well.
  assert.deepEqual(
    drawn([db({ ...stored, waMessageId: 'false_g@g.us_3EB0FE6B_148@lid' })], [entry('false_g@g.us_3EB0FE6B_628@c.us')]),
    ['false_g@g.us_3EB0FE6B_148@lid'],
  );
  // A row the delete never reached is the same message all the same: it is shown deleted, without its text.
  assert.deepEqual(
    mergeChatMessages([{ ...stored, type: 'text', body: 'secret' }], [entry('false_628@c.us_3EB0FE6B')]).map(m => [
      m.waMessageId,
      m.type,
      m.body,
    ]),
    [['false_148@lid_3EB0FE6B', 'revoked', '']],
  );
  // An entry listed twice, once from before the delete, is still that one message.
  assert.deepEqual(
    drawn([stored], [entry('false_628@c.us_3EB0FE6B', { type: 'text', body: 'hi' }), entry('false_628@c.us_3EB0FE6B')]),
    ['false_148@lid_3EB0FE6B'],
  );
  // A stored row the page lists under its own id is not deleted by an entry that only shares its stanza.
  assert.deepEqual(
    mergeChatMessages(
      [db({ ...stored, waMessageId: 'false_g@g.us_3EB0FE6B_111@c.us', type: 'text', body: 'still here' })],
      [
        entry('false_g@g.us_3EB0FE6B_111@c.us', { type: 'text', body: 'still here' }),
        entry('false_g@g.us_3EB0FE6B_222@c.us'),
      ],
    )
      .map(m => [m.waMessageId, m.type, m.body])
      .sort(),
    [
      ['false_g@g.us_3EB0FE6B_111@c.us', 'text', 'still here'],
      ['false_g@g.us_3EB0FE6B_222@c.us', 'revoked', ''],
    ],
  );
  // An entry that has a stored row under its own id belongs to that row, whatever else shares the stanza.
  assert.deepEqual(
    mergeChatMessages(
      [
        db({ ...stored, id: 'row-b', waMessageId: 'false_628@c.us_3EB0FE6B', type: 'text', body: 'gone' }),
        db({ ...stored, id: 'row-a', waMessageId: 'false_148@lid_3EB0FE6B', type: 'text', body: 'kept' }),
      ],
      [entry('false_628@c.us_3EB0FE6B')],
    )
      .map(m => [m.waMessageId, m.type, m.body])
      .sort(),
    [
      ['false_148@lid_3EB0FE6B', 'text', 'kept'],
      ['false_628@c.us_3EB0FE6B', 'revoked', ''],
    ],
  );

  // The same stanza sent the other way is another message, and so is an entry that is not deleted.
  assert.equal(drawn([stored], [entry('true_628@c.us_3EB0FE6B', { fromMe: true })]).length, 2);
  assert.equal(drawn([stored], [entry('false_628@c.us_3EB0FE6B', { type: 'text', body: 'hi' })]).length, 2);
  // Only a full whatsapp-web.js id has a stanza to go by: not a bare key, not an id of some other make with
  // underscores in it, not one whose first part is no direction, and not a stanza that holds an underscore.
  for (const [storedId, entryId] of [
    ['3EB0FE6B', '3EB0FE6B_X'],
    ['msg_2026_01', 'msg_2025_01'],
    ['maybe_148@lid_3EB0FE6B', 'maybe_628@c.us_3EB0FE6B'],
    ['false_148@lid_MSG_1_111@lid', 'false_628@c.us_MSG_2_222@lid'],
    ['false_148@lid_v1_9f8a7b6c', 'false_628@c.us_v1_1a2b3c4d'],
    ['false_148@lid_3EB0FE6B_111@lid_out', 'false_628@c.us_3EB0FE6B_111@lid_out'],
  ]) {
    assert.equal(drawn([db({ ...stored, waMessageId: storedId })], [entry(entryId)]).length, 2, entryId);
  }

  // A stanza match is decided before a match by sender and time: here the first entry is another deleted
  // message of the same sender and second, and it must not take the row that the second entry is.
  const sameSecond = entry('false_148@lid_OTHER', { from: '148@lid', timestamp: 1793549202 });
  assert.deepEqual(drawn([stored], [sameSecond, entry('false_628@c.us_3EB0FE6B')]).sort(), [
    'false_148@lid_3EB0FE6B',
    'false_148@lid_OTHER',
  ]);
});

test('mergeChatMessages: a match by sender and time needs a known time, and an entry listed twice takes one row', () => {
  const row = (waMessageId: string, timestamp?: number) =>
    db({
      id: waMessageId,
      waMessageId,
      author: 'alice@c.us',
      type: 'revoked',
      direction: 'incoming',
      timestamp,
      body: '',
    });
  const entry = (id: string, timestamp?: number) =>
    mapEngineHistoryMessage(
      hist({ id, author: 'alice@c.us', type: 'revoked', timestamp: timestamp as number, body: '' }),
    );
  const drawn = (rows: ChatMessage[], history: ReturnType<typeof entry>[]) =>
    mergeChatMessages(rows, history)
      .map(m => m.waMessageId)
      .sort();

  // Neither side knows the time, so nothing says the two are one message.
  assert.deepEqual(drawn([row('false_g@g.us_A1')], [entry('false_g@g.us_N1')]), ['false_g@g.us_A1', 'false_g@g.us_N1']);

  // Two messages deleted in the same second, the first listed twice: the repeat must not take the second row.
  assert.deepEqual(
    drawn(
      [row('false_g@g.us_A1', 1782054500), row('false_g@g.us_A2', 1782054500)],
      [
        entry('false_g@g.us_N1', 1782054500),
        entry('false_g@g.us_N1', 1782054500),
        entry('false_g@g.us_N2', 1782054500),
      ],
    ),
    ['false_g@g.us_A1', 'false_g@g.us_A2'],
  );
});

test('mergeChatMessages: never merges two stored revoked rows with each other', () => {
  const s1 = db({
    id: 'row-1',
    waMessageId: 'true_g@g.us_A',
    author: 'alice@c.us',
    type: 'revoked',
    direction: 'outgoing',
    status: 'sent',
    timestamp: 1782054300,
    body: '',
  });
  const s2 = db({
    id: 'row-2',
    waMessageId: 'true_g@g.us_B',
    author: 'alice@c.us',
    type: 'revoked',
    direction: 'outgoing',
    status: 'sent',
    timestamp: 1782054300,
    body: '',
  });
  const merged = mergeChatMessages([s1, s2], []);
  assert.equal(merged.length, 2);
});

test('mergeChatMessages: never matches non-revoked rows by direction, sender, and timestamp', () => {
  const storedText = db({
    id: 'row-txt',
    waMessageId: 'true_g@g.us_TXT',
    author: 'alice@c.us',
    type: 'text',
    direction: 'incoming',
    timestamp: 1782054400,
  });
  const histRevoked = mapEngineHistoryMessage(
    hist({
      id: 'false_g@g.us_REV',
      author: 'alice@c.us',
      type: 'revoked',
      fromMe: false,
      timestamp: 1782054400,
    }),
  );
  assert.equal(mergeChatMessages([storedText], [histRevoked]).length, 2);

  const storedRevoked = { ...storedText, type: 'revoked' as const, body: '' };
  const histText = mapEngineHistoryMessage(
    hist({
      id: 'false_g@g.us_TXT2',
      author: 'alice@c.us',
      type: 'text',
      fromMe: false,
      timestamp: 1782054400,
    }),
  );
  assert.equal(mergeChatMessages([storedRevoked], [histText]).length, 2);
  assert.equal(mergeChatMessages([storedText], [histText]).length, 2);
});

test('mapEngineHistoryMessage: leaves status undefined while mergeChatMessages preserves stored status', () => {
  const outHist = mapEngineHistoryMessage(hist({ id: 'true_g@g.us_H1', fromMe: true }));
  const inHist = mapEngineHistoryMessage(hist({ id: 'false_g@g.us_H2', fromMe: false }));
  assert.equal(outHist.status, undefined);
  assert.equal(inHist.status, undefined);

  const stored = db({ waMessageId: 'true_g@g.us_H1', status: 'sent' });
  const merged = mergeChatMessages([stored], [outHist]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].status, 'sent');
});

test('isRenderableMessage: drops empty unknown rows and keeps rows ChatThread draws', () => {
  assert.equal(isRenderableMessage(msg({ type: 'unknown', body: '', metadata: undefined })), false);
  assert.equal(
    isRenderableMessage(msg({ type: 'unknown', body: '', metadata: { edited: true, reactions: { a: '👍' } } })),
    false,
  );
  assert.equal(
    isRenderableMessage(
      msg({ type: 'unknown', body: '', metadata: { media: { mimetype: 'application/octet-stream' } } }),
    ),
    false,
  );
  assert.equal(
    isRenderableMessage(
      msg({
        type: 'unknown',
        body: 'file.bin',
        metadata: { media: { mimetype: 'application/octet-stream', filename: 'file.bin' } },
      }),
    ),
    false,
  );
  assert.equal(
    isRenderableMessage(
      msg({ type: 'unknown', body: '', direction: 'outgoing', metadata: { buttons: [{ id: 'b1', text: 'Tap' }] } }),
    ),
    false,
  );

  // Unknown rows that carry renderable content stay visible.
  assert.equal(isRenderableMessage(msg({ type: 'unknown', body: 'fallback text' })), true);
  assert.equal(
    isRenderableMessage(
      msg({ type: 'unknown', body: '', metadata: { media: { mimetype: 'image/png', omitted: true } } }),
    ),
    true,
  );
  assert.equal(
    isRenderableMessage(
      msg({ type: 'unknown', body: '', metadata: { media: { mimetype: 'image/png', data: 'BASE64' } } }),
    ),
    true,
  );
  assert.equal(
    isRenderableMessage(msg({ type: 'unknown', body: '', metadata: { quotedMessage: { id: 'q', body: 'hi' } } })),
    true,
  );
  assert.equal(
    isRenderableMessage(
      msg({ type: 'unknown', body: '', direction: 'incoming', metadata: { buttons: [{ id: 'b1', text: 'Tap' }] } }),
    ),
    true,
  );

  // Non-unknown rows always render, including revoked, masked, location, call, poll, contact, and media.
  for (const type of [
    'revoked',
    'masked',
    'location',
    'call',
    'poll',
    'contact',
    'order',
    'product',
    'image',
    'text',
  ] as const) {
    assert.equal(isRenderableMessage(msg({ type, body: '', metadata: undefined })), true, `type=${type}`);
  }
});

test('getMediaSrc downgrades active and non-allowlisted MIME types to application/octet-stream', () => {
  assert.equal(
    getMediaSrc({ mimetype: 'text/html', data: 'PGh0bWw+' }),
    'data:application/octet-stream;base64,PGh0bWw+',
  );
  assert.equal(
    getMediaSrc({ mimetype: 'image/svg+xml', data: 'PHN2Zz4=' }),
    'data:application/octet-stream;base64,PHN2Zz4=',
  );
  assert.equal(
    getMediaSrc({ mimetype: 'application/pdf', data: 'JVBERi0=' }),
    'data:application/octet-stream;base64,JVBERi0=',
  );
  assert.equal(
    getMediaSrc({ mimetype: 'text/html', data: 'data:text/html;base64,PGh0bWw+' }),
    'data:application/octet-stream;base64,PGh0bWw+',
  );
  assert.equal(
    getMediaSrc({ mimetype: 'image/svg+xml', data: 'DATA:image/svg+xml;charset=utf-8;base64,PHN2Zz4=' }),
    'data:application/octet-stream;base64,PHN2Zz4=',
  );
  assert.equal(
    getMediaSrc({ mimetype: 'image/png', data: 'data:image/png;base64 ,iVBOR' }),
    'data:image/png;base64,iVBOR',
  );
  assert.equal(
    getMediaSrc({ mimetype: 'text/html', data: 'data:text/html,<script>alert(1)</script>' }),
    'data:application/octet-stream,<script>alert(1)</script>',
  );
  assert.equal(getMediaSrc({ mimetype: 'image/png', data: 'iVBOR' }), 'data:image/png;base64,iVBOR');
  assert.equal(getMediaSrc({ mimetype: 'audio/ogg; codecs=opus', data: 'T2dn' }), 'data:audio/ogg;base64,T2dn');
  assert.equal(
    getMediaSrc({ mimetype: 'image/jpeg', data: 'https://cdn.example.com/photo.jpg' }),
    'https://cdn.example.com/photo.jpg',
  );
  assert.equal(getMediaSrc({ mimetype: 'image/png', data: 'data:malformed-without-comma' }), '');
});

test('inertMediaMimetype mirrors the passive media allowlist and strips parameters', () => {
  for (const allowed of [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/bmp',
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'video/3gpp',
    'audio/mpeg',
    'audio/mp4',
    'audio/ogg',
    'audio/aac',
    'audio/wav',
    'audio/webm',
  ]) {
    assert.equal(inertMediaMimetype(allowed), allowed);
    assert.equal(inertMediaMimetype(`${allowed.toUpperCase()}; codecs=foo`), allowed);
  }
  for (const unsafe of [
    'image/svg+xml',
    'text/html',
    'text/javascript',
    'application/pdf',
    'application/xhtml+xml',
    '',
    undefined,
  ]) {
    assert.equal(inertMediaMimetype(unsafe), 'application/octet-stream');
  }
});

test('inlineMediaToBlob decodes raw base64 and data URIs into application/octet-stream Blobs', async () => {
  const rawBlob = inlineMediaToBlob({ mimetype: 'text/html', data: btoa('<h1>hi</h1>') });
  assert.ok(rawBlob);
  assert.equal(rawBlob.type, 'application/octet-stream');
  assert.equal(await rawBlob.text(), '<h1>hi</h1>');

  const dataBase64Blob = inlineMediaToBlob({
    mimetype: 'image/svg+xml',
    data: `data:image/svg+xml;base64 ,${btoa('<svg/>')}`,
  });
  assert.ok(dataBase64Blob);
  assert.equal(dataBase64Blob.type, 'application/octet-stream');
  assert.equal(await dataBase64Blob.text(), '<svg/>');

  const dataPlainBlob = inlineMediaToBlob({
    mimetype: 'text/html',
    data: 'data:text/html,%3Cscript%3E1%3C%2Fscript%3E',
  });
  assert.ok(dataPlainBlob);
  assert.equal(dataPlainBlob.type, 'application/octet-stream');
  assert.equal(await dataPlainBlob.text(), '<script>1</script>');

  assert.equal(inlineMediaToBlob({ mimetype: 'application/pdf', data: 'https://example.com/a.pdf' }), null);
  assert.equal(inlineMediaToBlob({ mimetype: 'application/pdf', data: 'data:missing-comma' }), null);
  assert.equal(inlineMediaToBlob(undefined), null);
});

test('own-reaction helpers match exact session phone JIDs and key consistently', () => {
  assert.equal(normalizeSessionPhone('+1 (555) 123-4567'), '15551234567');
  assert.equal(normalizeSessionPhone('15551234567:4@s.whatsapp.net'), '15551234567');
  assert.equal(normalizeSessionPhone(''), null);
  assert.equal(normalizeSessionPhone(null), null);
  assert.equal(normalizeSessionPhone('me'), null);

  assert.equal(ownReactionKey('+1 555-123-4567'), '15551234567@c.us');
  assert.equal(ownReactionKey(null), 'me');

  // Exact matches for own reaction keys
  for (const sender of [
    'me',
    '15551234567',
    '15551234567@c.us',
    '15551234567@s.whatsapp.net',
    '15551234567:0@c.us',
    '15551234567:12@s.whatsapp.net',
    '15551234567:7',
  ]) {
    assert.equal(isOwnReactionSender(sender, '15551234567'), true, `expected own match for ${sender}`);
  }

  // Non-matches: substring, superstring, @lid, @g.us, non-numeric device, null phone with 'me' substring
  for (const sender of [
    '155512345678@c.us',
    '915551234567@c.us',
    '15551234567@lid',
    '15551234567@g.us',
    '15551234567@',
    '15551234567:abc@c.us',
    '15551234567:@c.us',
    'me@c.us',
    'acme@c.us',
  ]) {
    assert.equal(isOwnReactionSender(sender, '15551234567'), false, `unexpected own match for ${sender}`);
  }
  assert.equal(isOwnReactionSender('me', null), true);
  assert.equal(isOwnReactionSender('acme@c.us', null), false);

  // Toggle and apply remove all own aliases ('me', device JID, s.whatsapp.net) and write canonical key
  const existing = {
    me: '👍',
    '15551234567:5@s.whatsapp.net': '👍',
    '1555123456799@c.us': '❤️',
    '15551234567@lid': '😂',
  };
  assert.equal(toggleOwnReaction(existing, '👍', '15551234567'), '');
  assert.equal(toggleOwnReaction(existing, '❤️', '15551234567'), '❤️');
  assert.equal(toggleOwnReaction(existing, '😂', '15551234567'), '😂');

  assert.deepEqual(applyOwnReaction(existing, '🔥', '15551234567'), {
    '1555123456799@c.us': '❤️',
    '15551234567@lid': '😂',
    '15551234567@c.us': '🔥',
  });
  assert.deepEqual(applyOwnReaction(existing, '', '15551234567'), {
    '1555123456799@c.us': '❤️',
    '15551234567@lid': '😂',
  });
  assert.deepEqual(applyOwnReaction({ 'acme@c.us': '👍' }, '👍', null), {
    'acme@c.us': '👍',
    me: '👍',
  });
});
