import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiKeyDraft,
  apiKeyPatch,
  canScopeSessions,
  invalidChatEntry,
  invalidIpEntry,
  isExpired,
  normalizeChatScope,
  parseScopeList,
  sameSessionScope,
  toDateTimeLocal,
  sessionPickerStartsExpanded,
  sessionScopeNames,
  sessionScopeRows,
} from './sessionScope.ts';

test('only operator and viewer keys can be session-scoped in the dashboard', () => {
  assert.equal(canScopeSessions('operator'), true);
  assert.equal(canScopeSessions('viewer'), true);
  assert.equal(canScopeSessions('admin'), false);
  assert.equal(canScopeSessions(''), false);
});

test('an empty or missing allowlist means every session', () => {
  const sessions = [
    { id: 'a', name: 'Sales' },
    { id: 'b', name: 'Support' },
  ];
  assert.equal(sessionScopeNames(undefined, sessions), null);
  assert.equal(sessionScopeNames(null, sessions), null);
  assert.equal(sessionScopeNames([], sessions), null);
});

test('the session picker stays collapsed until sessions are already chosen', () => {
  assert.equal(sessionPickerStartsExpanded([]), false);
  assert.equal(sessionPickerStartsExpanded(['a']), true);
});

test('a selected allowlist resolves to session names, falling back to the id', () => {
  const sessions = [
    { id: 'a', name: 'Sales' },
    { id: 'b', name: 'Support' },
  ];
  assert.deepEqual(sessionScopeNames(['b', 'missing'], sessions), ['Support', 'missing']);
});

test('an unchanged selection is recognised so the save is skipped, and a reorder is not a change', () => {
  assert.equal(sameSessionScope([], []), true);
  assert.equal(sameSessionScope(['a', 'b'], ['b', 'a']), true);
  assert.equal(sameSessionScope(['a'], []), false);
  assert.equal(sameSessionScope([], ['a']), false);
  assert.equal(sameSessionScope(['a', 'b'], ['a', 'c']), false);
  assert.equal(sameSessionScope(['a'], ['a', 'a']), true);
  assert.equal(sameSessionScope(['a', 'a'], ['a', 'b']), false);
});

test('the picker lists a selected id whose session is gone, so it can be unticked', () => {
  const sessions = [
    { id: 'a', name: 'Sales' },
    { id: 'b', name: 'Support' },
  ];
  assert.deepEqual(sessionScopeRows(sessions, []), [
    { id: 'a', session: sessions[0] },
    { id: 'b', session: sessions[1] },
  ]);
  assert.deepEqual(sessionScopeRows(sessions, ['b', 'deleted', 'deleted']), [
    { id: 'a', session: sessions[0] },
    { id: 'b', session: sessions[1] },
    { id: 'deleted' },
  ]);
  // Every session deleted but the allowlist still names one: the row survives, so the empty state
  // does not swallow the only control that can clear it.
  assert.deepEqual(sessionScopeRows([], ['deleted']), [{ id: 'deleted' }]);
});

test('a free-text list splits on lines and commas, trims, and drops blanks and repeats', () => {
  assert.deepEqual(parseScopeList(' 10.0.0.1 \n\n10.0.0.0/8, 10.0.0.1\n'), ['10.0.0.1', '10.0.0.0/8']);
  assert.deepEqual(parseScopeList('  \n'), []);
});

test('a chat list qualifies a bare phone number the way the gateway stores it', () => {
  assert.deepEqual(normalizeChatScope('6281234\n6281234@c.us\n120363000@g.us, 555@lid'), [
    '6281234@c.us',
    '120363000@g.us',
    '555@lid',
  ]);
  // Too short to be a phone number: left for the gateway to refuse.
  assert.deepEqual(normalizeChatScope('1234'), ['1234']);
});

test('an expiry round-trips through the datetime-local value in local time', () => {
  const local = toDateTimeLocal('2027-03-04T05:06:59.000Z');
  assert.match(local, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(new Date(local).getTime(), Date.parse('2027-03-04T05:06:00.000Z'));
  assert.equal(toDateTimeLocal(undefined), '');
  assert.equal(toDateTimeLocal(null), '');
});

test('a key is expired only once its expiry has passed', () => {
  const now = Date.parse('2027-01-01T00:00:00.000Z');
  assert.equal(isExpired(undefined, now), false);
  assert.equal(isExpired(null, now), false);
  assert.equal(isExpired('2026-12-31T23:59:59.000Z', now), true);
  assert.equal(isExpired('2027-01-01T00:00:01.000Z', now), false);
});

const operatorKey = {
  role: 'operator',
  allowedIps: ['10.0.0.1', '10.0.0.0/8'],
  allowedSessions: ['s1'],
  allowedChats: ['6281234@c.us'],
  expiresAt: '2027-03-04T05:06:59.000Z',
};

test('an untouched draft produces an empty patch', () => {
  assert.deepEqual(apiKeyPatch(operatorKey, apiKeyDraft(operatorKey)), {});
  assert.deepEqual(apiKeyPatch({ role: 'viewer' }, apiKeyDraft({ role: 'viewer' })), {});
});

test('reordered lists and a bare number for a stored contact are not changes', () => {
  const draft = { ...apiKeyDraft(operatorKey), ips: '10.0.0.0/8\n10.0.0.1', chats: ' 6281234 ' };
  assert.deepEqual(apiKeyPatch(operatorKey, draft), {});
});

test('a stored allow-list with a repeated entry is not re-sent when untouched', () => {
  const key = { role: 'operator', allowedIps: ['10.0.0.1', '10.0.0.1'] };
  assert.deepEqual(apiKeyPatch(key, apiKeyDraft(key)), {});
});

test('each changed field is sent on its own', () => {
  const draft = apiKeyDraft(operatorKey);
  assert.deepEqual(apiKeyPatch(operatorKey, { ...draft, chats: '6281234\n120363000@g.us' }), {
    allowedChats: ['6281234@c.us', '120363000@g.us'],
  });
  assert.deepEqual(apiKeyPatch(operatorKey, { ...draft, ips: '' }), { allowedIps: [] });
  assert.deepEqual(apiKeyPatch(operatorKey, { ...draft, expires: '' }), { expiresAt: null });
  assert.deepEqual(apiKeyPatch(operatorKey, { ...draft, expires: '2028-01-02T03:04' }), {
    expiresAt: new Date('2028-01-02T03:04').toISOString(),
  });
  assert.deepEqual(apiKeyPatch(operatorKey, { ...draft, role: 'viewer' }), { role: 'viewer' });
});

test('promoting to admin clears session and chat scope; an admin keeps what the API set', () => {
  assert.deepEqual(apiKeyPatch(operatorKey, { ...apiKeyDraft(operatorKey), role: 'admin' }), {
    role: 'admin',
    allowedSessions: [],
    allowedChats: [],
  });
  const scopedAdmin = { role: 'admin', allowedSessions: ['s1'], allowedChats: ['1@g.us'] };
  assert.deepEqual(apiKeyPatch(scopedAdmin, apiKeyDraft(scopedAdmin)), {});
  assert.deepEqual(apiKeyPatch({ role: 'admin' }, { ...apiKeyDraft({ role: 'admin' }), role: 'operator' }), {
    role: 'operator',
  });
});

test('an IP entry must be an IPv4 address or an IPv4 CIDR range, as the gateway requires', () => {
  assert.equal(invalidIpEntry(['10.0.0.1', '10.0.0.0/8', '0.0.0.0/0', '192.168.1.0/32', '10.0.0.0/08']), null);
  for (const bad of ['10.0.0.0/33', '::1', '1.2.3', '256.1.1.1', '01.2.3.4', '10.0.0.0/', '10.0.0.0/8/8', 'host']) {
    assert.equal(invalidIpEntry(['10.0.0.1', bad]), bad, bad);
  }
});

test('a chat entry must be a phone number, a group or a contact id, as the gateway requires', () => {
  assert.equal(
    invalidChatEntry([
      '6281234',
      '6281234@c.us',
      '123456@lid',
      '120363000@g.us',
      '123-456@g.us',
      '6281234:1@s.whatsapp.net',
    ]),
    null,
  );
  for (const bad of ['1234', 'abc@c.us', '12@c.us', '120363000@x.us', 'someone']) {
    assert.equal(invalidChatEntry([bad]), bad, bad);
  }
});
