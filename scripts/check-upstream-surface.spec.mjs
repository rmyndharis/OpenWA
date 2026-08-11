import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractWwebjsClientMethods,
  extractWwebjsEvents,
  extractBaileysSocketMethods,
  extractBaileysEvents,
  extractSurface,
  compareSurfaces,
  diffLists,
} from './check-upstream-surface.mjs';

test('extracts Client method names from a wwebjs-shaped d.ts block', () => {
  const dts = [
    'export class Client extends EventEmitter {',
    '        getBlockedContacts(): Promise<Contact[]>;',
    '        approveGroupMembershipRequests(',
    '            groupId: string,',
    '        ): Promise<Array<MembershipRequestActionResult>>;',
    '    }',
    'export class OtherClass {',
    '        notAClientMethod(): void;',
    '    }',
  ].join('\n');
  assert.deepEqual(extractWwebjsClientMethods(dts), ['approveGroupMembershipRequests', 'getBlockedContacts']);
});

test('extracts Events VALUES from a Constants.js-shaped block', () => {
  const js = [
    'exports.Events = {',
    "    GROUP_MEMBERSHIP_REQUEST: 'group_membership_request',",
    "    MESSAGE_RECEIVED: 'message',",
    '};',
    'const WAState = {',
    "    CONFLICT: 'CONFLICT',",
    '};',
  ].join('\n');
  assert.deepEqual(extractWwebjsEvents(js), ['group_membership_request', 'message']);
});

test('extracts socket method names across Baileys layer files, deduped', () => {
  const groups = [
    'export declare const makeGroupsSocket: (config: SocketConfig) => {',
    '    groupMetadata: (jid: string) => Promise<GroupMetadata>;',
    '    groupRequestParticipantsUpdate: (jid: string, participants: string[], action: "approve" | "reject") => Promise<{',
    '        status: string;',
    '    }[]>;',
    '};',
  ].join('\n');
  const chats = [
    'export declare const makeChatsSocket: (config: SocketConfig) => {',
    '    fetchBlocklist: () => Promise<(string | undefined)[]>;',
    '    groupMetadata: (jid: string) => Promise<GroupMetadata>;',
    '};',
  ].join('\n');
  assert.deepEqual(extractBaileysSocketMethods([groups, chats]), [
    'fetchBlocklist',
    'groupMetadata',
    'groupRequestParticipantsUpdate',
  ]);
});

test('extracts BaileysEventMap event names, quoted and bare', () => {
  const dts = [
    'export type BaileysEventMap = {',
    "    'group.join-request': {",
    '        id: string;',
    '    };',
    "    'messaging-history.set': HistorySet;",
    '    call: WACallEvent[];',
    '};',
    'export type Other = {',
    "    'not.an.event': true;",
    '};',
  ].join('\n');
  assert.deepEqual(extractBaileysEvents(dts), ['call', 'group.join-request', 'messaging-history.set']);
});

test('diffLists reports additions and removals, and nothing on identity', () => {
  assert.deepEqual(diffLists(['a', 'b'], ['a', 'b']), { added: [], removed: [] });
  assert.deepEqual(diffLists(['a', 'b', 'c'], ['a', 'b']), { added: ['c'], removed: [] });
  assert.deepEqual(diffLists(['a'], ['a', 'b']), { added: [], removed: ['b'] });
});

// The guard itself: the extractor's output over the INSTALLED engines must match the committed,
// reviewed snapshot. A red run here means an upstream bump brought unreviewed capability surface —
// review it, then refresh with `node scripts/check-upstream-surface.mjs --update`.
test('installed upstream surface matches the committed snapshot', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const snapshotPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'upstream-surface.snapshot.json');
  const committed = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  const problems = compareSurfaces(extractSurface(), committed);
  assert.deepEqual(problems, [], `unreviewed upstream drift:\n${problems.join('\n')}`);
});
