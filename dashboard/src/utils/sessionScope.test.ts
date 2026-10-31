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

// The gateway takes ASCII digits only, so what an operator types in the digits of their own script is folded first.
const inScript = (text: string, zero: number) =>
  text.replace(/\d/g, digit => String.fromCodePoint(zero + Number(digit)));
const ZEROS = { arabicIndic: 0x0660, persian: 0x06f0, devanagari: 0x0966, telugu: 0x0c66, fullWidth: 0xff10 };

test('a chat list folds the digits of any script before it qualifies a number', () => {
  for (const [script, zero] of Object.entries(ZEROS)) {
    const number = inScript('6281234', zero);
    assert.deepEqual(normalizeChatScope(number), ['6281234@c.us'], script);
    assert.deepEqual(normalizeChatScope(` ${number}@c.us \n${number}\n6281234`), ['6281234@c.us'], script);
    assert.equal(invalidChatEntry(normalizeChatScope(number)), null, script);
  }
});

test('a chat list folds native digits inside a group, a contact, a lid and a device id', () => {
  const ids = ['120363000-1700000000@g.us', '6281234@c.us', '123456@lid', '6281234:1@s.whatsapp.net'];
  assert.deepEqual(normalizeChatScope(ids.map(id => inScript(id, ZEROS.persian)).join('\n')), ids);
});

test('a chat list reads a number of mixed scripts and drops direction marks around it', () => {
  assert.deepEqual(normalizeChatScope(`62${inScript('81234', ZEROS.arabicIndic)}`), ['6281234@c.us']);
  assert.deepEqual(normalizeChatScope(`\u200e${inScript('6281234', ZEROS.arabicIndic)}\u200f`), ['6281234@c.us']);
});

test('an entry that is not a chat id after folding is still refused', () => {
  const short = normalizeChatScope(inScript('1234', ZEROS.arabicIndic));
  assert.deepEqual(short, ['1234']);
  assert.equal(invalidChatEntry(short), '1234');
  const letters = normalizeChatScope(`${inScript('1234567', ZEROS.devanagari)}x@c.us`);
  assert.equal(invalidChatEntry(letters), '1234567x@c.us');
  // A circled digit is not a decimal digit: left as typed for the gateway to refuse.
  const circled = normalizeChatScope(`\u24606281234`);
  assert.equal(invalidChatEntry(circled), circled[0]);
  // A plus is refused for ASCII input and stays refused.
  assert.equal(invalidChatEntry(normalizeChatScope('+6281234')), '+6281234');
});

test('a draft in native digits patches exactly as the same draft in ASCII digits', () => {
  const key = { role: 'operator', allowedChats: ['6281234@c.us'] };
  const draft = apiKeyDraft(key);
  const native = (chats: string) => apiKeyPatch(key, { ...draft, chats: inScript(chats, ZEROS.persian) });
  assert.deepEqual(native('6281234'), {});
  assert.deepEqual(native('6281234\n62812349'), apiKeyPatch(key, { ...draft, chats: '6281234\n62812349' }));
  assert.deepEqual(native('6281234\n62812349'), { allowedChats: ['6281234@c.us', '62812349@c.us'] });
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
