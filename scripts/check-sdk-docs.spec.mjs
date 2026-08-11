import test from 'node:test';
import assert from 'node:assert/strict';
import { snake, methodsInSummaryCell, summaryRow, sectionMethods, slice, harvestShipped } from './check-sdk-docs.mjs';

test('snake-cases a JS method into the Python spelling', () => {
  assert.equal(snake('getQrCode'), 'get_qr_code');
  assert.equal(snake('conversionStatus'), 'conversion_status');
  assert.equal(snake('list'), 'list');
});

// The summary tables abbreviate, so an expander that stopped expanding would report a wall of gaps
// that are not gaps — and the natural "fix" for that noise is to weaken the guard.
test('expands a shared-suffix abbreviation', () => {
  const found = methodsInSummaryCell('list, add/remove/promote/demoteParticipants, leave');
  for (const m of ['addParticipants', 'removeParticipants', 'promoteParticipants', 'demoteParticipants']) {
    assert.ok(found.has(m), `expected ${m}`);
  }
  assert.ok(found.has('list') && found.has('leave'));
});

test('expands a shared-prefix abbreviation', () => {
  const found = methodsInSummaryCell('sendText, sendImage/Video/Audio/Document/Sticker');
  for (const m of ['sendImage', 'sendVideo', 'sendAudio', 'sendDocument', 'sendSticker']) {
    assert.ok(found.has(m), `expected ${m}`);
  }
});

test('expands a two-part abbreviation whose first half is a bare prefix', () => {
  const found = methodsInSummaryCell('get/updateGroupSettings');
  assert.ok(found.has('getGroupSettings'));
  assert.ok(found.has('updateGroupSettings'));
});

test('drops the trailing italic qualifier rather than reading it as a method', () => {
  const found = methodsInSummaryCell('list, get _(WhatsApp Business)_');
  assert.deepEqual([...found].sort(), ['get', 'list']);
});

test('reports a missing summary row as absent, not as empty', () => {
  const table = ['| Resource | Methods |', '| --- | --- |', '| `calls` | rejectCall |'].join('\n');
  assert.equal(summaryRow(table, 'media'), null);
  assert.deepEqual([...summaryRow(table, 'calls')], ['rejectCall']);
});

// The bug this file exists to keep fixed: resuming one character into the heading leaves `###` at
// position 0, the next-heading search matches immediately, and every table reads as empty — which
// presents as a false failure on every documented method at once.
test('reads a section table without swallowing it at the heading', () => {
  const doc = [
    '#### `sessions`',
    '',
    '| Method | Signature | Description |',
    '| --- | --- | --- |',
    '| `list` | `list()` | List sessions. |',
    '| `getConfig` | `getConfig(id)` | Read config. |',
    '',
    '#### `messages`',
    '',
    '| `send` | `send()` | Send. |',
  ].join('\n');
  assert.deepEqual([...sectionMethods(doc, 'sessions')].sort(), ['getConfig', 'list']);
  assert.equal(sectionMethods(doc, 'media'), null);
});

test('matches a heading carrying an italic qualifier', () => {
  const doc = ['#### `labels` _(WhatsApp Business)_', '', '| `list` | `list()` | List. |'].join('\n');
  assert.deepEqual([...sectionMethods(doc, 'labels')], ['list']);
});

test('slices a language section so an identical heading elsewhere is not read', () => {
  const doc = ['## 18.2 JS', '#### `sessions`', '| `a` | x | y |', '## 18.4 PHP', '#### `sessions`', '| `b` | x | y |'].join(
    '\n',
  );
  assert.deepEqual([...sectionMethods(slice(doc, '## 18.2 ', '## 18.4 '), 'sessions')], ['a']);
  assert.deepEqual([...sectionMethods(slice(doc, '## 18.4 ', null), 'sessions')], ['b']);
});

// Vacuity: the guard's own scan pattern is the thing most likely to rot silently, and a harvest that
// quietly returns nothing would turn every check below it into a pass.
test('harvests the real client surface, and every resource has at least one method', () => {
  const shipped = harvestShipped();
  assert.ok(shipped.size >= 16, `expected >= 16 resources, got ${shipped.size}`);
  const total = [...shipped.values()].reduce((n, m) => n + m.length, 0);
  assert.ok(total >= 130, `expected >= 130 methods, got ${total}`);
  for (const [resource, methods] of shipped) {
    assert.ok(methods.length > 0, `${resource} harvested no methods`);
    assert.ok(!methods.includes('constructor'), `${resource} harvested its constructor`);
  }
});
