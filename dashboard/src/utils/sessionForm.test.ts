import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sessionNameIssues,
  canCreateSession,
  isValidPairingPhone,
  matchesStatusFilter,
  filterSessions,
} from './sessionForm.ts';

test('a valid session name reports no issues', () => {
  assert.deepEqual(sessionNameIssues('sales-01', []), []);
  assert.equal(canCreateSession('sales-01', []), true);
});

test('an empty name is reported as empty and nothing else', () => {
  assert.deepEqual(sessionNameIssues('', ['sales']), ['empty']);
  assert.deepEqual(sessionNameIssues('   ', ['sales']), ['empty']);
  assert.equal(canCreateSession('', []), false);
});

test('format and length are reported together, because the form shows both', () => {
  const tooLongAndMalformed = 'A'.repeat(60);

  assert.deepEqual(sessionNameIssues(tooLongAndMalformed, []), ['format', 'too-long']);
});

test('duplicate is reported only once the name is otherwise usable', () => {
  assert.deepEqual(sessionNameIssues('sales', ['sales']), ['duplicate']);
  // Telling someone their unusable name is also taken is noise.
  assert.deepEqual(sessionNameIssues('Sales', ['Sales']), ['format']);
});

test('names become on-disk directories, so the format stays narrow', () => {
  assert.deepEqual(sessionNameIssues('sales-01', []), []);
  assert.deepEqual(sessionNameIssues('Sales', []), ['format'], 'uppercase rejected');
  assert.deepEqual(sessionNameIssues('sales_01', []), ['format'], 'underscore rejected');
  assert.deepEqual(sessionNameIssues('sales 01', []), ['format'], 'space rejected');
  assert.deepEqual(sessionNameIssues('../escape', []), ['format'], 'path traversal rejected');
});

test('the length cap is 50', () => {
  assert.deepEqual(sessionNameIssues('a'.repeat(50), []), []);
  assert.deepEqual(sessionNameIssues('a'.repeat(51), []), ['too-long']);
});

test('pairing accepts a bare international number and nothing else', () => {
  assert.equal(isValidPairingPhone('628123456789'), true);
  assert.equal(isValidPairingPhone('  628123456789  '), true, 'trimmed');
  assert.equal(isValidPairingPhone('+628123456789'), false, 'no plus');
  assert.equal(isValidPairingPhone('62812-3456'), false, 'no separators');
  assert.equal(isValidPairingPhone('12345'), false, 'too short');
  assert.equal(isValidPairingPhone('1234567890123456'), false, 'too long');
});

test('the status groups follow the operator model, not the engine states', () => {
  assert.equal(matchesStatusFilter('anything', 'all'), true);
  assert.equal(matchesStatusFilter('ready', 'active'), true);

  for (const s of ['initializing', 'authenticating', 'qr_ready']) {
    assert.equal(matchesStatusFilter(s, 'connecting'), true, `${s} is connecting`);
  }
  // action_required and failed need the operator, not time — they belong with inactive, not connecting.
  for (const s of ['created', 'disconnected', 'action_required', 'failed']) {
    assert.equal(matchesStatusFilter(s, 'inactive'), true, `${s} is inactive`);
    assert.equal(matchesStatusFilter(s, 'connecting'), false, `${s} is not connecting`);
  }
});

test('an unknown filter matches nothing rather than everything', () => {
  assert.equal(matchesStatusFilter('ready', 'bogus'), false);
});

test('filterSessions combines the search box and the status group', () => {
  const sessions = [
    { id: 'u1', name: 'sales', status: 'ready' },
    { id: 'u2', name: 'support', status: 'disconnected' },
    { id: 'u3', name: 'sales-backup', status: 'disconnected' },
  ];

  assert.deepEqual(
    filterSessions(sessions, 'sales', 'all').map(s => s.id),
    ['u1', 'u3'],
  );
  assert.deepEqual(
    filterSessions(sessions, 'sales', 'inactive').map(s => s.id),
    ['u3'],
  );
  assert.deepEqual(
    filterSessions(sessions, '', 'active').map(s => s.id),
    ['u1'],
  );
  assert.deepEqual(
    filterSessions(sessions, 'u2', 'all').map(s => s.id),
    ['u2'],
    'id matches too',
  );
});
