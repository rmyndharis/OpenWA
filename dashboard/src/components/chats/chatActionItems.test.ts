// What a chat's menu offers, in what order, and what a key without a handler for an action is not shown. The
// translator returns the key, so a label names the entry it is.
import '../../test-helpers/register-hooks.ts';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Chat } from '../../services/api.ts';
import type { ChatRowActions } from './chatActionItems.tsx';

let chatActionItems: (typeof import('./chatActionItems.tsx'))['chatActionItems'];

before(async () => {
  ({ chatActionItems } = await import('./chatActionItems.tsx'));
});

const t = (key: string) => key;
const R = 'chats.rowActions.';

const direct: Chat = {
  id: '15550001111@c.us',
  name: 'Alice',
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 1,
  archived: false,
  pinned: false,
  muted: false,
};
const group: Chat = { ...direct, id: '120363000000000001@g.us', name: 'Team', isGroup: true, kind: 'group' };

const noop = () => undefined;
/** Every action an operator key is given. */
const everything: ChatRowActions = {
  onGroupInfo: noop,
  onSaveContact: noop,
  onTogglePin: noop,
  onMute: noop,
  onToggleArchive: noop,
  onMarkUnread: noop,
  onLeaveGroup: noop,
  onToggleBlock: noop,
  onClear: noop,
  onDelete: noop,
};

const keys = (chat: Chat, actions: ChatRowActions) => chatActionItems(chat, actions, t).map(item => item.key);

test('a 1:1 chat lists its contact, list and destructive actions in that order', () => {
  assert.deepEqual(keys(direct, everything), ['save', 'pin', 'mute', 'archive', 'unread', 'block', 'clear', 'delete']);
});

test('a group lists its info and its list actions, and leaving at the end', () => {
  assert.deepEqual(keys(group, everything), ['info', 'pin', 'mute', 'archive', 'unread', 'leave']);
});

test('only the first destructive entry starts the destructive part with a divider', () => {
  const items = chatActionItems(direct, everything, t);
  assert.deepEqual(
    items.map(item => Boolean(item.separated)),
    [false, false, false, false, false, true, false, false],
  );
});

test('an action without a handler is left out, a read-only key keeping only the info of a group', () => {
  assert.deepEqual(keys(group, { onGroupInfo: noop }), ['info']);
  assert.deepEqual(keys(direct, { onGroupInfo: noop }), []);
});

test('a chat that is not a group or a 1:1 chat gets the list actions only', () => {
  const channelLike: Chat = { ...direct, kind: 'unknown' };
  assert.deepEqual(keys(channelLike, everything), ['pin', 'mute', 'archive', 'unread']);
});

test('a chat already unread, marked or counted, offers nothing to mark', () => {
  assert.ok(keys({ ...direct, unreadCount: 0 }, everything).includes('unread'));
  assert.ok(!keys({ ...direct, unreadCount: 3 }, everything).includes('unread'));
  assert.ok(!keys({ ...direct, unreadCount: -1 }, everything).includes('unread'));
});

test('an entry names the opposite action once its state is set', () => {
  const label = (chat: Chat, key: string, actions: ChatRowActions = everything) =>
    chatActionItems(chat, actions, t).find(item => item.key === key)?.label;
  assert.equal(label(direct, 'pin'), `${R}pin`);
  assert.equal(label({ ...direct, pinned: true }, 'pin'), `${R}unpin`);
  assert.equal(label({ ...direct, muted: true }, 'mute'), `${R}unmute`);
  assert.equal(label({ ...direct, archived: true }, 'archive'), `${R}unarchive`);
  assert.equal(label(direct, 'block'), `${R}block`);
  assert.equal(label(direct, 'block', { ...everything, isBlocked: () => true }), `${R}unblock`);
  assert.equal(label(direct, 'save'), `${R}saveContact`);
  assert.equal(label(direct, 'save', { ...everything, isSavedContact: () => true }), `${R}renameContact`);
});

test('Save contact is offered disabled, with the reason, for a chat the address book cannot hold', () => {
  const save = (actions: ChatRowActions) => chatActionItems(direct, actions, t).find(item => item.key === 'save');
  assert.equal(save(everything)?.disabled, undefined);
  const refused = save({ ...everything, canSaveContact: () => false });
  assert.equal(refused?.disabled, true);
  assert.equal(refused?.hint, `${R}saveContactUnavailable`);
});

test('an entry runs its own handler with the chat it was built for', () => {
  const seen: string[] = [];
  const actions: ChatRowActions = { ...everything, onTogglePin: chat => seen.push(`pin ${chat.id}`) };
  chatActionItems(direct, actions, t)
    .find(item => item.key === 'pin')
    ?.run(direct);
  assert.deepEqual(seen, [`pin ${direct.id}`]);
});
