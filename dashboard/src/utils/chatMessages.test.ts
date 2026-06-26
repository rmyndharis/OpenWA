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
