import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addGroupIds,
  filterGroupRows,
  groupLabel,
  groupPickerRows,
  isGatewayRefusal,
  planGroupSend,
  toggleGroupId,
} from './groupSelection.ts';

const groups = [
  { id: '111@g.us', name: 'Family' },
  { id: '222@g.us', name: 'Work Team' },
  { id: '333@g.us', name: '  ' },
  { id: '444@g.us' },
];

test('labels a group by its name, falling back to the id when the name is blank or missing', () => {
  assert.equal(groupLabel(groups[0]), 'Family');
  assert.equal(groupLabel(groups[2]), '333@g.us');
  assert.equal(groupLabel(groups[3]), '444@g.us');
});

test('rows list every group, then selected ids the list no longer has', () => {
  const rows = groupPickerRows(groups, ['222@g.us', 'gone@g.us', 'gone@g.us']);
  assert.deepEqual(
    rows.map(row => row.label),
    ['Family', 'Work Team', '333@g.us', '444@g.us', 'gone@g.us'],
  );
});

test('filters rows by a case-insensitive substring of the label', () => {
  const rows = groupPickerRows(groups, []);
  assert.deepEqual(filterGroupRows(rows, '').length, rows.length);
  assert.deepEqual(
    filterGroupRows(rows, ' TEAM ').map(row => row.id),
    ['222@g.us'],
  );
  assert.deepEqual(
    filterGroupRows(rows, '444').map(row => row.id),
    ['444@g.us'],
  );
});

test('toggling adds a missing id and removes a present one', () => {
  assert.deepEqual(toggleGroupId(['111@g.us'], '222@g.us'), ['111@g.us', '222@g.us']);
  assert.deepEqual(toggleGroupId(['111@g.us', '222@g.us'], '111@g.us'), ['222@g.us']);
});

test('adding ids keeps the selection first, drops duplicates and stops at the limit', () => {
  assert.deepEqual(addGroupIds(['333@g.us'], ['333@g.us', '111@g.us', '222@g.us'], 10), [
    '333@g.us',
    '111@g.us',
    '222@g.us',
  ]);
  assert.deepEqual(addGroupIds(['333@g.us'], ['111@g.us', '222@g.us'], 2), ['333@g.us', '111@g.us']);
  assert.deepEqual(addGroupIds(['333@g.us', '111@g.us'], ['222@g.us'], 2), ['333@g.us', '111@g.us']);
});

test('no selection plans nothing', () => {
  assert.equal(planGroupSend([], 'text'), null);
});

test('one group is a single send', () => {
  assert.deepEqual(planGroupSend(['111@g.us'], 'text'), { mode: 'single', chatId: '111@g.us' });
});

test('several groups are sent one after another', () => {
  assert.deepEqual(planGroupSend(['111@g.us', '222@g.us'], 'poll'), {
    mode: 'sequential',
    chatIds: ['111@g.us', '222@g.us'],
  });
});

test('forward uses the first group as its source chat instead of looping', () => {
  assert.deepEqual(planGroupSend(['111@g.us', '222@g.us'], 'forward'), { mode: 'single', chatId: '111@g.us' });
});

test('a stopped session, a refusal and a fetch with no answer end a run, other failures do not', () => {
  const withStatus = (status: number, message = 'refused') => Object.assign(new Error(message), { status });
  assert.equal(isGatewayRefusal(withStatus(409)), true);
  assert.equal(isGatewayRefusal(withStatus(429)), true);
  // A reverse proxy answers 502 for a gateway it cannot reach, and 503 as the gateway does.
  assert.equal(isGatewayRefusal(withStatus(502)), true);
  assert.equal(isGatewayRefusal(withStatus(503)), true);
  assert.equal(isGatewayRefusal(new TypeError('Failed to fetch')), true);
  assert.equal(isGatewayRefusal(withStatus(404)), false);
  assert.equal(isGatewayRefusal(withStatus(500)), false);
  // A 504 means the proxy reached the gateway and stopped waiting, so the request may still be running.
  assert.equal(isGatewayRefusal(withStatus(504)), false);
  // An error the page raised itself, or an answer it could not read, is not a fetch that got no answer.
  assert.equal(isGatewayRefusal(new Error('offline')), false);
  assert.equal(isGatewayRefusal(new SyntaxError('Unexpected token')), false);
  assert.equal(isGatewayRefusal(null), false);
});

// A 400 is also what the gateway answers for one chat alone, so it ends a run only when it says the session is not running.
test('a 400 ends a run only when it says the session is not active or not started', () => {
  const withStatus = (message: string) => Object.assign(new Error(message), { status: 400 });
  assert.equal(isGatewayRefusal(withStatus("Session 's1' is not active. Start the session first.")), true);
  assert.equal(isGatewayRefusal(withStatus('Session is not started')), true);
  assert.equal(isGatewayRefusal(withStatus('SESSION IS NOT STARTED')), true);
  assert.equal(isGatewayRefusal(withStatus('Message sending blocked by plugin')), false);
  assert.equal(isGatewayRefusal(withStatus('The body failed validation')), false);
  assert.equal(isGatewayRefusal(withStatus('Contact is not active on WhatsApp')), false);
  assert.equal(isGatewayRefusal(withStatus('')), false);
  assert.equal(isGatewayRefusal(Object.assign(new Error('Session is not started'), { status: 404 })), false);
});
