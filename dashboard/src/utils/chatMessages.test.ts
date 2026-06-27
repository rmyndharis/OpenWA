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
  assert.deepEqual(merged.map(m => m.id), ['a', 'b']);
});

import {
  mergeOrAppend,
  replaceMessageById,
  updateMessageById,
  removeMessageById,
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

test('replaceMessageById swaps the entry with matching id', () => {
  const before = [msg({ id: 'temp-1', status: 'sending' }), msg({ id: 'm-2' })];
  const after = replaceMessageById(before, 'temp-1', msg({ id: 'real-1', status: 'sent' }));
  assert.equal(after.length, 2);
  assert.equal(after[0].id, 'real-1');
  assert.equal(after[0].status, 'sent');
});

test('replaceMessageById is a no-op when oldId is not present', () => {
  const before = [msg({ id: 'm-1' })];
  const after = replaceMessageById(before, 'missing', msg({ id: 'real' }));
  assert.deepEqual(after, before);
});

test('updateMessageById applies a partial patch by id', () => {
  const before = [msg({ id: 'm-1', status: 'sending' })];
  const after = updateMessageById(before, 'm-1', { status: 'failed' });
  assert.equal(after[0].status, 'failed');
  assert.equal(after[0].body, 'hello');  // other fields unchanged
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
