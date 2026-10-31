import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyChatListFilter,
  contactKey,
  filterChats,
  filterChannels,
  groupStatusesByContact,
  isUnsavedContact,
  matches,
  phoneContactId,
  savedContactKeySet,
} from './chatFilters.ts';

const chat = (id: string, name?: string, kind?: string) => ({ id, name, kind });

const row = (id: string, kind: string, unreadCount: number, name?: string) => ({ id, name, kind, unreadCount });

test('the unread filter keeps chats with a count and chats marked unread', () => {
  const all = [row('a@c.us', 'individual', 2), row('b@c.us', 'individual', 0), row('c@c.us', 'individual', -1)];

  assert.deepEqual(
    applyChatListFilter(all, 'unread').map(c => c.id),
    ['a@c.us', 'c@c.us'],
  );
});

test('the direct and group filters split on the chat kind, and all keeps every row', () => {
  const all = [row('a@c.us', 'individual', 0), row('g@g.us', 'group', 0), row('b@broadcast', 'broadcast', 0)];

  assert.deepEqual(
    applyChatListFilter(all, 'direct').map(c => c.id),
    ['a@c.us'],
  );
  assert.deepEqual(
    applyChatListFilter(all, 'groups').map(c => c.id),
    ['g@g.us'],
  );
  assert.equal(applyChatListFilter(all, 'all'), all);
});

// The contacts route as the Baileys adapter answers it: a saved contact, and a peer known only by the push
// name WhatsApp sent (`notify`), which carries no `~` and no saved name.
const ADDRESS_BOOK = [
  { id: '628111@s.whatsapp.net', name: 'Alice', isMyContact: true },
  { id: '628222@s.whatsapp.net', pushName: 'Bob', isMyContact: false },
];

test('a 1:1 chat is unsaved when the address book does not hold its contact as saved, whatever its name', () => {
  const saved = savedContactKeySet(ADDRESS_BOOK);
  // Named by the bare push name, as Baileys lists it: still unsaved.
  assert.equal(isUnsavedContact(chat('628222@s.whatsapp.net', 'Bob', 'individual'), saved), true);
  assert.equal(isUnsavedContact(chat('628111@s.whatsapp.net', 'Alice', 'individual'), saved), false);
  // whatsapp-web.js spells the same phone `@c.us`.
  assert.equal(isUnsavedContact(chat('628111@c.us', 'Alice', 'individual'), saved), false);
  // A group is never a contact, saved or not.
  assert.equal(isUnsavedContact(chat('120363000000000000@g.us', undefined, 'group'), saved), false);
  // Until the address book loads no chat is called unsaved, rather than every one.
  assert.equal(isUnsavedContact(chat('628222@s.whatsapp.net', 'Bob', 'individual'), undefined), false);
});

test('the Unknown filter keeps the push-name-only contact and drops the saved one', () => {
  const all = [
    row('628111@s.whatsapp.net', 'individual', 0, 'Alice'),
    row('628222@s.whatsapp.net', 'individual', 0, 'Bob'),
  ];
  assert.deepEqual(
    applyChatListFilter(all, 'unknown', savedContactKeySet(ADDRESS_BOOK)).map(c => c.id),
    ['628222@s.whatsapp.net'],
  );
});

test('only a phone-based chat id can key the address book; a @lid never passes for a phone', () => {
  assert.equal(phoneContactId('628111@c.us'), '628111@c.us');
  assert.equal(phoneContactId('628111@s.whatsapp.net'), '628111@s.whatsapp.net');
  assert.equal(phoneContactId('262813461250071@lid'), null);
  assert.equal(phoneContactId('120363000000000000@g.us'), null);
  // A @lid keeps its full key, so its digits never match a phone's.
  assert.equal(contactKey('628111@lid'), '628111@lid');
  assert.equal(contactKey('628111@c.us'), contactKey('628111@s.whatsapp.net'));
});

test('the chats tab hides channel and status rows, which have their own tabs', () => {
  const all = [chat('a@c.us', 'Alice'), chat('n@newsletter', 'News', 'channel'), chat('s@broadcast', 'S', 'status')];

  assert.deepEqual(
    filterChats(all, '').map(c => c.id),
    ['a@c.us'],
  );
});

test('search matches name or id, case-insensitively, and an absent name never throws', () => {
  const all = [chat('628111@c.us', 'Alice'), chat('628222@c.us'), chat('628333@c.us', 'Bob')];

  assert.deepEqual(
    filterChats(all, 'ALI').map(c => c.id),
    ['628111@c.us'],
  );
  assert.deepEqual(
    filterChats(all, '628222').map(c => c.id),
    ['628222@c.us'],
  );
  assert.deepEqual(
    filterChats(all, 'zzz').map(c => c.id),
    [],
  );
});

test('channels match on their own name and id', () => {
  const channels = [
    { id: '111@newsletter', name: 'OpenWA News' },
    { id: '222@newsletter', name: 'Other' },
  ];

  assert.deepEqual(
    filterChannels(channels, 'openwa').map(c => c.id),
    ['111@newsletter'],
  );
  assert.deepEqual(
    filterChannels(channels, '222').map(c => c.id),
    ['222@newsletter'],
  );
});

const item = (contactId: string, timestamp: string, name?: string) => ({
  contact: { id: contactId, name },
  timestamp,
});

test('statuses collapse to one row per contact, newest contact first', () => {
  // Store order is newest-first overall.
  const statuses = [
    item('b', '2026-08-01T03:00:00Z', 'Bob'),
    item('a', '2026-08-01T02:00:00Z', 'Alice'),
    item('a', '2026-08-01T01:00:00Z', 'Alice'),
  ];

  const groups = groupStatusesByContact(statuses, '');

  assert.deepEqual(
    groups.map(g => g.contact.id),
    ['b', 'a'],
    'group order is newest-contact-first',
  );
  assert.equal(groups[1].items.length, 2, 'one row per contact, items kept together');
  assert.equal(groups[1].latest, '2026-08-01T02:00:00Z', 'latest is the newest timestamp in the group');
});

test("a group's items run oldest-first, opposite to the group ordering", () => {
  // The viewer opens at the newest and reads like a story: newest at the bottom, where the scroll
  // lands. The store hands them over newest-first, so the group must flip them.
  const groups = groupStatusesByContact(
    [item('a', '2026-08-01T03:00:00Z'), item('a', '2026-08-01T02:00:00Z'), item('a', '2026-08-01T01:00:00Z')],
    '',
  );

  assert.deepEqual(
    groups[0].items.map(i => i.timestamp),
    ['2026-08-01T01:00:00Z', '2026-08-01T02:00:00Z', '2026-08-01T03:00:00Z'],
  );
});

test('status search matches name, pushName or id', () => {
  const statuses = [
    { contact: { id: '628111@c.us', name: 'Alice', pushName: 'Ali' }, timestamp: '2026-08-01T01:00:00Z' },
    { contact: { id: '628222@c.us', name: undefined, pushName: 'Bobby' }, timestamp: '2026-08-01T02:00:00Z' },
  ];

  assert.deepEqual(
    groupStatusesByContact(statuses, 'alice').map(g => g.contact.id),
    ['628111@c.us'],
  );
  assert.deepEqual(
    groupStatusesByContact(statuses, 'bobby').map(g => g.contact.id),
    ['628222@c.us'],
  );
  assert.deepEqual(
    groupStatusesByContact(statuses, '628111').map(g => g.contact.id),
    ['628111@c.us'],
  );
});

// The search box matches a number against the ASCII digits of an id, so a number typed in the digits of another
// script (Arabic-Indic, Persian, Devanagari, full-width) has to find the same chat.
const native = (ascii: string, zero: number) => [...ascii].map(d => String.fromCharCode(zero + Number(d))).join('');

for (const [script, zero] of [
  ['ASCII', 0x30],
  ['Arabic-Indic', 0x0660],
  ['Persian', 0x06f0],
  ['Devanagari', 0x0966],
  ['full-width', 0xff10],
] as const) {
  test(`a number typed in ${script} digits finds the chat and the channel by its id`, () => {
    const query = native('628123', zero);
    assert.deepEqual(
      filterChats([chat('628123456789@c.us', 'Ben'), chat('491701234567@c.us', 'Anna')], query).map(c => c.id),
      ['628123456789@c.us'],
    );
    assert.deepEqual(
      filterChannels(
        [
          { id: '628123456789@newsletter', name: 'News' },
          { id: '491701234567@newsletter', name: 'Other' },
        ],
        query,
      ).map(c => c.id),
      ['628123456789@newsletter'],
    );
    assert.ok(matches(query, 'Ben', undefined, '628123456789'));
    assert.ok(!matches(query, 'Anna', '491701234567'));
  });
}

// The filters run over every row on every render of the Chats page. Folding the query once per row made a search in
// native digits about nine times the cost of an ASCII one (13 ms against 1.3 ms per filter of 5000 chats).
test('the query is folded once per search, not once per row', t => {
  const rows = (count: number) => Array.from({ length: count }, (_, i) => chat(`62812${i}@c.us`, `Contact ${i}`));
  const replace = t.mock.method(String.prototype, 'replace');
  const folds = (count: number, query: string): number => {
    replace.mock.resetCalls();
    filterChats(rows(count), query);
    filterChannels(
      rows(count).map(c => ({ id: c.id, name: c.name! })),
      query,
    );
    groupStatusesByContact(
      rows(count).map(c => ({ contact: c, timestamp: '2026-01-01T00:00:00Z' })),
      query,
    );
    return replace.mock.callCount();
  };
  assert.equal(folds(1000, native('6281', 0x0660)), folds(10, native('6282', 0x0660)));
});

// A fold kept from one query must never answer for the next, as the operator types and deletes.
test('each query matches its own rows when the search changes back and forth', () => {
  const chats = [chat('628123456789@c.us', 'Ben'), chat('155500001111@c.us', 'Anna')];
  for (const [query, expected] of [
    ['ben', ['Ben']],
    [native('1555', 0x0660), ['Anna']],
    [native('6281', 0x06f0), ['Ben']],
    ['ann', ['Anna']],
    ['ben', ['Ben']],
  ] as const) {
    assert.deepEqual(
      filterChats(chats, query).map(c => c.name),
      expected,
      query,
    );
  }
});

test('a name typed with letters still matches as typed', () => {
  assert.deepEqual(
    filterChats([chat('1@c.us', 'Ben'), chat('2@c.us', 'Anna')], 'ANN').map(c => c.id),
    ['2@c.us'],
  );
  assert.ok(!matches('xyz', 'Ben', '628123456789'));
});
