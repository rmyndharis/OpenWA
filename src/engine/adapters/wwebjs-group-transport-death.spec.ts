import type { Client } from 'whatsapp-web.js';
import { WwebjsGroups } from './wwebjs-groups';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';

/**
 * Both group reads reported a dead page and then rethrew the raw Puppeteer error, so the caller got
 * HTTP 500 while both routes document 503 (session.controller.ts:446 for the list,
 * group.controller.ts:304 for the membership queue). The list route's own wording says the status
 * exists so a caller is never handed an empty list for a query that never ran; on whatsapp-web.js it
 * could not be produced at all, while Baileys has answered it since baileys-group-list.spec.ts:28.
 */
const logger = createLogger('wwebjs-group-transport-death.spec');

describe('group reads distinguish a dead page from an ordinary failure', () => {
  const transportError = new Error('Protocol error (Runtime.callFunctionOn): Target closed');

  function makeGroups(op: string, reject: unknown): { groups: WwebjsGroups; reportIfPageTransportError: jest.Mock } {
    const client = {
      info: {},
      // requireGroupChat runs before the guarded read, so it must resolve a real group.
      getChatById: jest.fn().mockResolvedValue({ isGroup: true }),
      pupPage: {
        evaluate: op === 'getGroups' ? jest.fn().mockRejectedValue(reject) : jest.fn().mockResolvedValue([]),
      },
      getGroupMembershipRequests:
        op === 'getGroupMembershipRequests' ? jest.fn().mockRejectedValue(reject) : jest.fn().mockResolvedValue([]),
    };
    const reportIfPageTransportError = jest.fn();
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      isPageTransportError: (error: unknown) => error === transportError,
      reportIfPageTransportError,
      logger,
    } as unknown as WwebjsEngineHost;
    return { groups: new WwebjsGroups(host), reportIfPageTransportError };
  }

  const call = (groups: WwebjsGroups, op: string): Promise<unknown> =>
    ({
      getGroups: () => groups.getGroups(),
      getGroupMembershipRequests: () => groups.getGroupMembershipRequests('628123@g.us'),
    })[op]!();

  const OPS = ['getGroups', 'getGroupMembershipRequests'];

  it.each(OPS)('%s answers a dead page with the 503 its route documents', async op => {
    const { groups, reportIfPageTransportError } = makeGroups(op, transportError);

    await expect(call(groups, op)).rejects.toThrow(EngineTransportError);
    expect(reportIfPageTransportError).toHaveBeenCalledWith(transportError, op);
  });

  // Negative twin: an ordinary page-side failure must still surface untouched, so the fix cannot
  // simply relabel every failure as a retryable 503.
  it.each(OPS)('%s still propagates an ordinary failure unchanged', async op => {
    const refusal = new Error('Evaluation failed: group not found');
    const { groups, reportIfPageTransportError } = makeGroups(op, refusal);

    await expect(call(groups, op)).rejects.toBe(refusal);
    expect(reportIfPageTransportError).not.toHaveBeenCalled();
  });
});

/**
 * The group writes looked the chat up and then called it with no page classification at all, so a
 * dead page answered an opaque 500 and never fed the liveness path, while their routes document 503.
 * The lookup and the converging writes now answer 503 with the death signal; the writes that do not
 * converge report the death and keep their status, so a retrying client cannot apply them twice.
 */
describe('group writes classify a dead page', () => {
  const transportError = new Error('Protocol error (Runtime.callFunctionOn): Target closed');
  const GROUP = '628123@g.us';
  const IMAGE = { data: 'aGVsbG8=', mimetype: 'image/png' };

  type ChatMethods = Record<string, jest.Mock>;

  function makeGroups(chat: ChatMethods | Promise<never>, clientMethods: ChatMethods = {}) {
    const client = {
      info: {},
      getChatById:
        chat instanceof Promise ? jest.fn(() => chat) : jest.fn().mockResolvedValue({ isGroup: true, ...chat }),
      ...clientMethods,
    };
    const reportIfPageTransportError = jest.fn();
    const host = {
      ensureReady: jest.fn(),
      getClient: () => client as unknown as Client,
      isPageTransportError: (error: unknown) => error === transportError,
      reportIfPageTransportError,
      logger,
      config: {},
    } as unknown as WwebjsEngineHost;
    return { groups: new WwebjsGroups(host), reportIfPageTransportError };
  }

  // [public op, chat method it calls, invocation]
  const CONVERGING: [string, string, (g: WwebjsGroups) => Promise<unknown>][] = [
    ['getGroupInviteCode', 'getInviteCode', g => g.getGroupInviteCode(GROUP)],
    ['setGroupSubject', 'setSubject', g => g.setGroupSubject(GROUP, 's')],
    ['setGroupDescription', 'setDescription', g => g.setGroupDescription(GROUP, 'd')],
    ['setGroupMessagesAdminsOnly', 'setMessagesAdminsOnly', g => g.setGroupMessagesAdminsOnly(GROUP, true)],
    ['setGroupInfoAdminsOnly', 'setInfoAdminsOnly', g => g.setGroupInfoAdminsOnly(GROUP, true)],
    ['setGroupMemberAddMode', 'setAddMembersAdminsOnly', g => g.setGroupMemberAddMode(GROUP, 'admins')],
    ['deleteGroupPicture', 'deletePicture', g => g.deleteGroupPicture(GROUP)],
    ['setGroupPicture', 'setPicture', g => g.setGroupPicture(GROUP, IMAGE)],
  ];
  const NON_CONVERGING_CHAT: [string, string, (g: WwebjsGroups) => Promise<unknown>][] = [
    ['leaveGroup', 'leave', g => g.leaveGroup(GROUP)],
    ['revokeGroupInviteCode', 'revokeInvite', g => g.revokeGroupInviteCode(GROUP)],
    ['addParticipants', 'addParticipants', g => g.addParticipants(GROUP, ['628111@c.us'])],
    ['removeParticipants', 'removeParticipants', g => g.removeParticipants(GROUP, ['628111@c.us'])],
    ['promoteParticipants', 'promoteParticipants', g => g.promoteParticipants(GROUP, ['628111@c.us'])],
    ['demoteParticipants', 'demoteParticipants', g => g.demoteParticipants(GROUP, ['628111@c.us'])],
  ];
  const MEMBERSHIP: [string, (g: WwebjsGroups) => Promise<unknown>][] = [
    ['approveGroupMembershipRequests', g => g.approveGroupMembershipRequests(GROUP, ['628111@c.us'])],
    ['rejectGroupMembershipRequests', g => g.rejectGroupMembershipRequests(GROUP, ['628111@c.us'])],
  ];

  it.each([...CONVERGING, ...NON_CONVERGING_CHAT])(
    '%s answers a dead page during the group lookup with 503 before calling %s',
    async (op, _method, run) => {
      const lookup = Promise.reject(transportError);
      lookup.catch(() => undefined);
      const { groups, reportIfPageTransportError } = makeGroups(lookup);

      // The lookup rejects before a chat exists, so no write method can have run.
      await expect(run(groups)).rejects.toThrow(EngineTransportError);
      expect(reportIfPageTransportError).toHaveBeenCalledTimes(1);
      expect(reportIfPageTransportError).toHaveBeenCalledWith(transportError, op);
    },
  );

  it.each(CONVERGING)('%s answers a dead page in %s with 503 and reports it', async (op, method, run) => {
    const { groups, reportIfPageTransportError } = makeGroups({
      [method]: jest.fn().mockRejectedValue(transportError),
    });

    await expect(run(groups)).rejects.toThrow(EngineTransportError);
    expect(reportIfPageTransportError).toHaveBeenCalledTimes(1);
    expect(reportIfPageTransportError).toHaveBeenCalledWith(transportError, op);
  });

  it.each(NON_CONVERGING_CHAT)('%s reports a dead page in %s but keeps the raw error', async (op, method, run) => {
    const { groups, reportIfPageTransportError } = makeGroups({
      [method]: jest.fn().mockRejectedValue(transportError),
    });

    await expect(run(groups)).rejects.toBe(transportError);
    expect(reportIfPageTransportError).toHaveBeenCalledTimes(1);
    expect(reportIfPageTransportError).toHaveBeenCalledWith(transportError, op);
  });

  it.each(MEMBERSHIP)('%s reports a dead page but keeps the raw error', async (op, run) => {
    const { groups, reportIfPageTransportError } = makeGroups(
      {},
      { [op]: jest.fn().mockRejectedValue(transportError) },
    );

    await expect(run(groups)).rejects.toBe(transportError);
    expect(reportIfPageTransportError).toHaveBeenCalledWith(transportError, op);
  });

  it.each(CONVERGING)('%s leaves an ordinary failure in %s untouched and unreported', async (_op, method, run) => {
    const failure = new Error('Evaluation failed: x');
    const { groups, reportIfPageTransportError } = makeGroups({ [method]: jest.fn().mockRejectedValue(failure) });

    await expect(run(groups)).rejects.toBe(failure);
    expect(reportIfPageTransportError).not.toHaveBeenCalled();
  });

  // reportPageDeath hands every failure to the host, whose own classifier ignores an ordinary one.
  it.each(NON_CONVERGING_CHAT)('%s leaves an ordinary failure in %s untouched', async (_op, method, run) => {
    const failure = new Error('Evaluation failed: x');
    const { groups } = makeGroups({ [method]: jest.fn().mockRejectedValue(failure) });

    await expect(run(groups)).rejects.toBe(failure);
  });

  it('still maps an empty participant batch to a refusal, not a death', async () => {
    const arity = new Error('Evaluation failed: expected at least 1 children');
    const { groups } = makeGroups({ removeParticipants: jest.fn().mockRejectedValue(arity) });

    await expect(groups.removeParticipants(GROUP, ['628111@c.us'])).rejects.toThrow(EngineRefusedError);
  });
});
