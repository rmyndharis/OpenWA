import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyChatListFilter,
  filterChats,
  filterChannels,
  groupStatusesByContact,
  isUnsavedContact,
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

test('a contact counts as unsaved without a name, with a push name, or named by its own number', () => {
  assert.equal(isUnsavedContact(chat('491701234567@c.us', undefined, 'individual')), true);
  assert.equal(isUnsavedContact(chat('491701234567@c.us', '~Max', 'individual')), true);
  assert.equal(isUnsavedContact(chat('491701234567@c.us', '+49 170 1234567', 'individual')), true);
  assert.equal(isUnsavedContact(chat('491701234567@c.us', 'Max Mustermann', 'individual')), false);
  // A group is never a contact, saved or not.
  assert.equal(isUnsavedContact(chat('120363000000000000@g.us', undefined, 'group')), false);
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
