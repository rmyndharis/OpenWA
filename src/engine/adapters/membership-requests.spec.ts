import { WwebjsGroups, normalizeWwebjsRequestMethod } from './wwebjs-groups';
import { BaileysGroups, type BaileysGroupsHost } from './baileys-groups';
import { BaileysEvents, type BaileysEventsHost } from './baileys-events';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import type { Client } from 'whatsapp-web.js';
import type { WASocket } from '@whiskeysockets/baileys';
import type { GroupEvent } from '../interfaces/whatsapp-engine.interface';

/**
 * Group membership requests (the join-approval queue of a group the account admins) across both
 * engines. The two upstreams disagree on every shape involved:
 *
 *  - whatsapp-web.js resolves raw page-context store objects — requester wids can arrive as
 *    `{_serialized}` OR `{$1}` (the #747 minifier rename), `requestMethod` is a PascalCase token,
 *    and approve/reject resolve `{requesterId, error?, message}` per requester.
 *  - Baileys resolves bare wire attrs — engine-dialect `jid`, snake_case `request_method`, and a
 *    stringly `request_time`; approve/reject resolve `[{status, jid}]` like the participant writes.
 *
 * These tests pin both mappings to the one neutral shape, and pin the batch-guard convention:
 * a caller who NAMED participants gets the membership-write guards (all-failed → refusal, no
 * outcome → refusal), while approve/reject-ALL with an empty queue is a legitimate no-op ([]).
 */

const logger = createLogger('membership-requests.spec');

// ---------------------------------------------------------------------------------------------
// whatsapp-web.js delegate
// ---------------------------------------------------------------------------------------------

type WwebjsClientStub = {
  getGroupMembershipRequests: jest.Mock;
  approveGroupMembershipRequests: jest.Mock;
  rejectGroupMembershipRequests: jest.Mock;
};

function makeWwebjsGroups(): { groups: WwebjsGroups; client: WwebjsClientStub } {
  const client: WwebjsClientStub = {
    getGroupMembershipRequests: jest.fn(),
    approveGroupMembershipRequests: jest.fn(),
    rejectGroupMembershipRequests: jest.fn(),
  };
  const host = {
    ensureReady: jest.fn(),
    getClient: () => client as unknown as Client,
    logger,
    isPageTransportError: () => false,
    reportIfPageTransportError: jest.fn(),
  } as unknown as WwebjsEngineHost;
  return { groups: new WwebjsGroups(host), client };
}

describe('WwebjsGroups membership requests', () => {
  it('normalises the PascalCase request-method tokens and reports unknown ones as undefined', () => {
    expect(normalizeWwebjsRequestMethod('InviteLink')).toBe('invite_link');
    expect(normalizeWwebjsRequestMethod('NonAdminAdd')).toBe('non_admin_add');
    expect(normalizeWwebjsRequestMethod('LinkedGroupJoin')).toBe('linked_group_join');
    expect(normalizeWwebjsRequestMethod('SomethingNew')).toBeUndefined();
    expect(normalizeWwebjsRequestMethod(undefined)).toBeUndefined();
  });

  it('lists membership requests, reading both wid spellings and dropping unreadable requesters', async () => {
    const { groups, client } = makeWwebjsGroups();
    client.getGroupMembershipRequests.mockResolvedValue([
      {
        id: { _serialized: '628111@c.us' },
        addedBy: { $1: '628222@c.us' }, // the #747 rename spelling
        requestMethod: 'InviteLink',
        t: 1754700000,
      },
      {
        id: {}, // unreadable requester wid: no addressable id to report
        addedBy: { _serialized: '628333@c.us' },
        requestMethod: 'NonAdminAdd',
        t: 1754700001,
      },
    ]);

    const result = await groups.getGroupMembershipRequests('120363@g.us');

    expect(client.getGroupMembershipRequests).toHaveBeenCalledWith('120363@g.us');
    expect(result).toEqual([
      {
        participantId: '628111@c.us',
        addedById: '628222@c.us',
        method: 'invite_link',
        requestedAt: 1754700000,
      },
    ]);
  });

  it('omits optional fields the store did not report rather than defaulting them', async () => {
    const { groups, client } = makeWwebjsGroups();
    client.getGroupMembershipRequests.mockResolvedValue([{ id: '628111@c.us', requestMethod: 'Unknowable' }]);

    const result = await groups.getGroupMembershipRequests('120363@g.us');

    expect(result).toEqual([{ participantId: '628111@c.us' }]);
  });

  it.each([
    ['approve', 'approveGroupMembershipRequests' as const],
    ['reject', 'rejectGroupMembershipRequests' as const],
  ])('%ss named requesters and maps the per-requester outcome', async (_action, method) => {
    const { groups, client } = makeWwebjsGroups();
    client[method].mockResolvedValue([
      { requesterId: '628111@c.us', message: 'done' },
      { requesterId: { $1: '628222@c.us' }, error: 403, message: 'refused' },
    ]);

    const result = await groups[method]('120363@g.us', ['628111@c.us', '628222@c.us']);

    // The upstream default sleep is restated explicitly so a wwebjs default change cannot
    // silently alter this gateway's pacing.
    expect(client[method]).toHaveBeenCalledWith('120363@g.us', {
      requesterIds: ['628111@c.us', '628222@c.us'],
      sleep: [250, 500],
    });
    expect(result).toEqual([
      { id: '628111@c.us', success: true, message: 'done' },
      { id: '628222@c.us', success: false, status: 403, message: 'refused' },
    ]);
  });

  it.each([
    ['approve', 'approveGroupMembershipRequests' as const],
    ['reject', 'rejectGroupMembershipRequests' as const],
  ])('%ss a bare phone number after qualifying it, like every other participant write', async (_action, method) => {
    // GroupService.assertAddressableParticipants blesses a bare number, and the three other
    // participant paths in this file qualify it before the engine sees it. Unqualified it reaches
    // the page's `requesterIds.map(createWid)` (Injected/Utils.js:1540-1542), which upstream never
    // does itself — Client.js appends '@c.us' before its own createWid calls — so the caller got an
    // undiagnosable 500 on whatsapp-web.js for input that succeeds on Baileys.
    const { groups, client } = makeWwebjsGroups();
    client[method].mockResolvedValue([{ requesterId: '628123456789@c.us', message: 'done' }]);

    await groups[method]('120363@g.us', ['628123456789', '628222@c.us']);

    expect(client[method]).toHaveBeenCalledWith('120363@g.us', {
      requesterIds: ['628123456789@c.us', '628222@c.us'],
      sleep: [250, 500],
    });
  });

  it('reports the code-less ServerStatusCodeError entry as a FAILURE, not a success', async () => {
    // The page util's non-success RPC branch pushes {requesterId, message: 'ServerStatusCodeError'}
    // with NO error code (Injected/Utils.js:1637-1648) — reading "no error field" as success would
    // sell a server failure as an approval.
    const { groups, client } = makeWwebjsGroups();
    client.approveGroupMembershipRequests.mockResolvedValue([
      { requesterId: '628111@c.us', message: 'ServerStatusCodeError' },
      { requesterId: '628222@c.us', message: 'Approved successfully' },
    ]);

    const result = await groups.approveGroupMembershipRequests('120363@g.us', ['628111@c.us', '628222@c.us']);

    expect(result).toEqual([
      { id: '628111@c.us', success: false, message: 'ServerStatusCodeError' },
      { id: '628222@c.us', success: true, message: 'Approved successfully' },
    ]);
  });

  it('throws EngineRefusedError when every NAMED requester failed', async () => {
    const { groups, client } = makeWwebjsGroups();
    client.approveGroupMembershipRequests.mockResolvedValue([
      { requesterId: '628111@c.us', error: 403, message: 'no' },
    ]);

    await expect(groups.approveGroupMembershipRequests('120363@g.us', ['628111@c.us'])).rejects.toBeInstanceOf(
      EngineRefusedError,
    );
  });

  it('throws EngineRefusedError when NAMED requesters produced no outcome at all', async () => {
    const { groups, client } = makeWwebjsGroups();
    client.approveGroupMembershipRequests.mockResolvedValue([]);

    await expect(groups.approveGroupMembershipRequests('120363@g.us', ['628111@c.us'])).rejects.toBeInstanceOf(
      EngineRefusedError,
    );
  });

  it('resolves [] for approve-all on an empty queue — a no-op, not a refusal', async () => {
    const { groups, client } = makeWwebjsGroups();
    client.approveGroupMembershipRequests.mockResolvedValue([]);

    await expect(groups.approveGroupMembershipRequests('120363@g.us')).resolves.toEqual([]);

    expect(client.approveGroupMembershipRequests).toHaveBeenCalledWith('120363@g.us', {
      requesterIds: null,
      sleep: [250, 500],
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Baileys delegate
// ---------------------------------------------------------------------------------------------

type BaileysSockStub = {
  groupRequestParticipantsList: jest.Mock;
  groupRequestParticipantsUpdate: jest.Mock;
};

function makeBaileysGroups(): { groups: BaileysGroups; sock: BaileysSockStub } {
  const sock: BaileysSockStub = {
    groupRequestParticipantsList: jest.fn(),
    groupRequestParticipantsUpdate: jest.fn(),
  };
  const host: BaileysGroupsHost = {
    ensureReady: jest.fn(),
    getSocket: () => sock as unknown as WASocket,
    logger,
    toNeutralJid: jid => jid.replace('@s.whatsapp.net', '@c.us'),
    toEngineJid: jid => jid.replace('@c.us', '@s.whatsapp.net'),
    normalizedSelfJid: () => '628999@c.us',
  };
  return { groups: new BaileysGroups(host), sock };
}

describe('BaileysGroups membership requests', () => {
  it('lists membership requests, neutralising jids and parsing the stringly wire attrs', async () => {
    const { groups, sock } = makeBaileysGroups();
    sock.groupRequestParticipantsList.mockResolvedValue([
      { jid: '628111@s.whatsapp.net', request_method: 'invite_link', request_time: '1754700000' },
      { jid: '628222@s.whatsapp.net', request_method: 'brand_new_token', request_time: 'soon' },
      { request_method: 'invite_link' }, // no jid: nothing addressable to report
    ]);

    const result = await groups.getGroupMembershipRequests('120363@g.us');

    expect(sock.groupRequestParticipantsList).toHaveBeenCalledWith('120363@g.us');
    expect(result).toEqual([
      { participantId: '628111@c.us', method: 'invite_link', requestedAt: 1754700000 },
      { participantId: '628222@c.us' },
    ]);
  });

  it.each([['approve' as const], ['reject' as const]])(
    '%ss named requesters in the engine dialect and maps the per-jid statuses',
    async action => {
      const { groups, sock } = makeBaileysGroups();
      sock.groupRequestParticipantsUpdate.mockResolvedValue([
        { status: '200', jid: '628111@s.whatsapp.net' },
        { status: '403', jid: '628222@s.whatsapp.net' },
      ]);

      const method = action === 'approve' ? 'approveGroupMembershipRequests' : 'rejectGroupMembershipRequests';
      const result = await groups[method]('120363@g.us', ['628111@c.us', '628222@c.us']);

      expect(sock.groupRequestParticipantsUpdate).toHaveBeenCalledWith(
        '120363@g.us',
        ['628111@s.whatsapp.net', '628222@s.whatsapp.net'],
        action,
      );
      expect(result).toEqual([
        { id: '628111@c.us', success: true, status: 200 },
        { id: '628222@c.us', success: false, status: 403 },
      ]);
    },
  );

  it('throws EngineRefusedError when every NAMED requester failed', async () => {
    const { groups, sock } = makeBaileysGroups();
    sock.groupRequestParticipantsUpdate.mockResolvedValue([{ status: '403', jid: '628111@s.whatsapp.net' }]);

    await expect(groups.approveGroupMembershipRequests('120363@g.us', ['628111@c.us'])).rejects.toBeInstanceOf(
      EngineRefusedError,
    );
  });

  it('throws EngineRefusedError when NAMED requesters produced no outcome at all', async () => {
    const { groups, sock } = makeBaileysGroups();
    sock.groupRequestParticipantsUpdate.mockResolvedValue([]);

    await expect(groups.rejectGroupMembershipRequests('120363@g.us', ['628111@c.us'])).rejects.toBeInstanceOf(
      EngineRefusedError,
    );
  });

  it('approve-all lists the pending queue first and acts on exactly those requesters', async () => {
    const { groups, sock } = makeBaileysGroups();
    sock.groupRequestParticipantsList.mockResolvedValue([
      { jid: '628111@s.whatsapp.net', request_method: 'invite_link', request_time: '1' },
      { jid: '628222@s.whatsapp.net', request_method: 'invite_link', request_time: '2' },
    ]);
    sock.groupRequestParticipantsUpdate.mockResolvedValue([
      { status: '200', jid: '628111@s.whatsapp.net' },
      { status: '200', jid: '628222@s.whatsapp.net' },
    ]);

    const result = await groups.approveGroupMembershipRequests('120363@g.us');

    expect(sock.groupRequestParticipantsUpdate).toHaveBeenCalledWith(
      '120363@g.us',
      ['628111@s.whatsapp.net', '628222@s.whatsapp.net'],
      'approve',
    );
    expect(result).toHaveLength(2);
  });

  it('approve-all on an empty queue resolves [] without issuing the update at all', async () => {
    const { groups, sock } = makeBaileysGroups();
    sock.groupRequestParticipantsList.mockResolvedValue([]);

    await expect(groups.approveGroupMembershipRequests('120363@g.us')).resolves.toEqual([]);

    expect(sock.groupRequestParticipantsUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// Baileys 'group.join-request' event mapping
// ---------------------------------------------------------------------------------------------

describe('BaileysEvents.handleGroupJoinRequest', () => {
  function makeEvents(): { events: BaileysEvents; onGroupEvent: jest.Mock } {
    const onGroupEvent = jest.fn();
    const host = {
      logger,
      toNeutralJid: (jid: string) => jid.replace('@s.whatsapp.net', '@c.us'),
      getOnGroupEvent: () => onGroupEvent,
    } as unknown as BaileysEventsHost;
    return { events: new BaileysEvents(host), onGroupEvent };
  }

  it('maps a created join request to a neutral join_request GroupEvent, preferring the pn twins', () => {
    const { events, onGroupEvent } = makeEvents();
    const now = jest.spyOn(Date, 'now').mockReturnValue(1782000000_000);
    try {
      events.handleGroupJoinRequest({
        id: '120363@g.us',
        author: '111@lid',
        authorPn: '628111@s.whatsapp.net',
        participant: '222@lid',
        participantPn: '628222@s.whatsapp.net',
        action: 'created',
        method: 'invite_link',
      });
    } finally {
      now.mockRestore();
    }

    expect(onGroupEvent).toHaveBeenCalledTimes(1);
    const event = (onGroupEvent.mock.calls as Array<[GroupEvent]>)[0][0];
    expect(event).toEqual({
      kind: 'join_request',
      groupId: '120363@g.us',
      actorId: '628111@c.us',
      participantIds: ['628222@c.us'],
      timestamp: 1782000000, // the Baileys event is undated: stamped at receipt
    });
  });

  it('keeps the requester as the participant when no author is reported (a self-request)', () => {
    const { events, onGroupEvent } = makeEvents();

    events.handleGroupJoinRequest({
      id: '120363@g.us',
      participant: '628222@s.whatsapp.net',
      action: 'created',
      method: 'invite_link',
    });

    const event = (onGroupEvent.mock.calls as Array<[GroupEvent]>)[0][0];
    expect(event).toMatchObject({
      kind: 'join_request',
      groupId: '120363@g.us',
      participantIds: ['628222@c.us'],
    });
    expect(event.actorId).toBeUndefined();
  });

  it.each(['revoked', 'rejected'])('drops action %s — only the request being MADE is an event', action => {
    const { events, onGroupEvent } = makeEvents();

    events.handleGroupJoinRequest({
      id: '120363@g.us',
      author: '628111@s.whatsapp.net',
      participant: '628222@s.whatsapp.net',
      action,
      method: 'invite_link',
    });

    expect(onGroupEvent).not.toHaveBeenCalled();
  });

  it('drops a request without a group id or participant — nothing addressable to report', () => {
    const { events, onGroupEvent } = makeEvents();

    events.handleGroupJoinRequest({ id: '120363@g.us', action: 'created', method: 'invite_link' });
    events.handleGroupJoinRequest({ participant: '628222@s.whatsapp.net', action: 'created', method: 'invite_link' });

    expect(onGroupEvent).not.toHaveBeenCalled();
  });
});
