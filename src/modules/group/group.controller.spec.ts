import type { Request } from 'express';
import { GroupController } from './group.controller';
import { GroupService } from './group.service';

// The membership routes read the request to tell an empty body from one that was never parsed; the
// body-shape cases run through real parsers in group.controller.http.spec.ts.
const noBody = { headers: {}, body: {}, is: () => null } as unknown as Request;

describe('GroupController join + settings', () => {
  const build = (service: Partial<Record<keyof GroupService, jest.Mock>>) => {
    const controller = new GroupController(service as unknown as GroupService);
    return { controller, service };
  };

  it('POST join returns the success envelope with the group id', async () => {
    const { controller, service } = build({
      joinGroupViaInviteCode: jest.fn().mockResolvedValue('120363000@g.us'),
    });
    await expect(controller.join('s1', { inviteCode: 'CODE123' })).resolves.toEqual({
      success: true,
      groupId: '120363000@g.us',
    });
    expect(service.joinGroupViaInviteCode).toHaveBeenCalledWith('s1', 'CODE123');
  });

  it('GET :groupId/settings delegates to the service (404 mapping lives there)', async () => {
    const { controller, service } = build({
      getGroupSettings: jest.fn().mockResolvedValue({ announce: true, locked: false, ephemeralSeconds: 86400 }),
    });
    await expect(controller.getSettings('s1', 'g1')).resolves.toEqual({
      announce: true,
      locked: false,
      ephemeralSeconds: 86400,
    });
    expect(service.getGroupSettings).toHaveBeenCalledWith('s1', 'g1');
  });

  it('PUT :groupId/settings forwards the patch and returns the success envelope', async () => {
    const { controller, service } = build({ updateGroupSettings: jest.fn().mockResolvedValue(undefined) });
    const dto = { announce: true, ephemeralSeconds: 0 };
    await expect(controller.updateSettings('s1', 'g1', dto)).resolves.toEqual({
      success: true,
      message: 'Group settings updated',
    });
    expect(service.updateGroupSettings).toHaveBeenCalledWith('s1', 'g1', dto);
  });

  it.each(['getSettings', 'updateSettings'] as const)('%s summary names the member-add mode it carries', method => {
    const handler = Object.getOwnPropertyDescriptor(GroupController.prototype, method)?.value as object;
    const op = Reflect.getMetadata('swagger/apiOperation', handler) as { summary: string };
    expect(op.summary).toBe(
      `${method === 'getSettings' ? 'Get' : 'Update'} group settings (announce / locked / ephemeral timer / member-add mode)`,
    );
  });

  it('PUT :groupId/member-label forwards the label and returns the success envelope', async () => {
    const { controller, service } = build({ setGroupMemberLabel: jest.fn().mockResolvedValue(undefined) });
    await expect(controller.setMemberLabel('s1', '120363@g.us', { label: 'Site A' })).resolves.toEqual({
      success: true,
      message: 'Group member label sent',
    });
    expect(service.setGroupMemberLabel).toHaveBeenCalledWith('s1', '120363@g.us', 'Site A');
  });

  it('PUT :groupId/settings propagates a service rejection (empty patch / 501 passthrough)', async () => {
    const { controller } = build({
      updateGroupSettings: jest
        .fn()
        .mockRejectedValue(new Error('At least one of announce, locked, ephemeralSeconds must be provided')),
    });
    await expect(controller.updateSettings('s1', 'g1', {})).rejects.toThrow(/At least one/);
  });

  it('POST :groupId/participants returns the per-participant results as an additive field', async () => {
    const results = [
      { id: '628111@c.us', success: true, status: 200 },
      { id: '628222@c.us', success: false, status: 403 },
    ];
    const { controller, service } = build({ addParticipants: jest.fn().mockResolvedValue(results) });
    await expect(
      controller.addParticipants('s1', 'g1', { participants: ['628111@c.us', '628222@c.us'] }),
    ).resolves.toEqual({
      success: true,
      message: 'Participants added',
      results,
    });
    expect(service.addParticipants).toHaveBeenCalledWith('s1', 'g1', ['628111@c.us', '628222@c.us']);
  });

  it.each([
    ['removeParticipants', 'Participants removed'],
    ['promoteParticipants', 'Participants promoted to admin'],
    ['demoteParticipants', 'Participants demoted from admin'],
  ] as const)('%s returns the per-participant results as an additive field', async (method, message) => {
    const results = [{ id: '628111@c.us', success: true, status: 200 }];
    const { controller } = build({ [method]: jest.fn().mockResolvedValue(results) });
    await expect(
      (controller as unknown as Record<string, (s: string, g: string, dto: unknown) => Promise<unknown>>)[method](
        's1',
        'g1',
        { participants: ['628111@c.us'] },
      ),
    ).resolves.toEqual({ success: true, message, results });
  });
});

// Nest matches routes in DECLARATION order, so a literal segment declared after a parameter route on
// the same path shape is unreachable — `GET /groups/join-info` would arrive at `GET /groups/:groupId`
// with groupId='join-info' and be looked up as a group. Reading the decorators back off the class is
// the only way to catch a reordering, since both routes keep working in isolation either way.
describe('GroupController membership requests', () => {
  const build = (service: Partial<Record<keyof GroupService, jest.Mock>>) => {
    const controller = new GroupController(service as unknown as GroupService);
    return { controller, service };
  };

  it('GET :groupId/membership-requests returns the pending queue as a bare array', async () => {
    const requests = [{ participantId: '628111@c.us', method: 'invite_link', requestedAt: 1754700000 }];
    const { controller, service } = build({ getGroupMembershipRequests: jest.fn().mockResolvedValue(requests) });

    await expect(controller.getMembershipRequests('s1', 'g1')).resolves.toEqual(requests);
    expect(service.getGroupMembershipRequests).toHaveBeenCalledWith('s1', 'g1');
  });

  it.each([
    ['approve', 'approveMembershipRequests' as const, 'approveGroupMembershipRequests' as const, 'approved'],
    ['reject', 'rejectMembershipRequests' as const, 'rejectGroupMembershipRequests' as const, 'rejected'],
  ])('POST :groupId/membership-requests/%s returns the per-participant results', async (_a, route, svcMethod, verb) => {
    const results = [{ id: '628111@c.us', success: true, status: 200 }];
    const { controller, service } = build({ [svcMethod]: jest.fn().mockResolvedValue(results) });

    await expect(controller[route]('s1', 'g1', { participants: ['628111@c.us'] }, noBody)).resolves.toEqual({
      success: true,
      message: `Membership requests ${verb}`,
      results,
    });
    expect(service[svcMethod]).toHaveBeenCalledWith('s1', 'g1', ['628111@c.us']);
  });

  it('an empty body approves ALL pending requests (participants passed as undefined)', async () => {
    const { controller, service } = build({ approveGroupMembershipRequests: jest.fn().mockResolvedValue([]) });

    await controller.approveMembershipRequests('s1', 'g1', {}, noBody);

    expect(service.approveGroupMembershipRequests).toHaveBeenCalledWith('s1', 'g1', undefined);
  });
});

describe('GroupController route ordering', () => {
  it('declares the literal join-info route before the :groupId parameter route', () => {
    const proto = GroupController.prototype as object;
    const order = Object.getOwnPropertyNames(proto).filter(name => name === 'joinInfo' || name === 'findOne');

    expect(order).toEqual(['joinInfo', 'findOne']);
  });

  it('keeps join-info a literal path, not a parameter', () => {
    const handler = Object.getOwnPropertyDescriptor(GroupController.prototype, 'joinInfo')?.value as object;
    const path: unknown = Reflect.getMetadata('path', handler);

    expect(path).toBe('join-info');
  });
});

describe('GroupController OpenAPI responses', () => {
  // Every engine-backed route resolves the engine first, and a session with no engine answers 400
  // there before the not-ready 409 can happen, so a route documenting the 409 owes the 400 too.
  it('declares the 400 for an unstarted session wherever it declares the engine-not-ready 409', () => {
    const missing = Object.getOwnPropertyNames(GroupController.prototype).filter(name => {
      const handler = Object.getOwnPropertyDescriptor(GroupController.prototype, name)!.value as object;
      const responses = (Reflect.getMetadata('swagger/apiResponse', handler) ?? {}) as Record<string, unknown>;
      return '409' in responses && !('400' in responses);
    });
    expect(missing).toEqual([]);
  });

  const responsesOf = (name: string): Record<string, { description?: string }> =>
    (Reflect.getMetadata(
      'swagger/apiResponse',
      Object.getOwnPropertyDescriptor(GroupController.prototype, name)!.value as object,
    ) ?? {}) as Record<string, { description?: string }>;

  // Baileys answers 503 for WhatsApp's own rate limit (429) as well as for an unanswered query, and a
  // throttled caller should back off rather than retry at once, so every 503 has to say so.
  it('names the WhatsApp rate limit on every 503 it declares', () => {
    const silent = Object.getOwnPropertyNames(GroupController.prototype).filter(name => {
      const description = responsesOf(name)['503']?.description;
      return description !== undefined && !description.includes('429');
    });
    expect(silent).toEqual([]);
  });

  // On Baileys the picture lookup also maps a WhatsApp 5xx to 503; the metadata query behind the
  // settings read does not, so a 5xx there answers 500 and its 503 must not promise otherwise.
  it('names the WhatsApp 5xx on the picture 503 and not on the settings 503', () => {
    expect(responsesOf('getPicture')['503']?.description).toContain('5xx');
    expect(responsesOf('getSettings')['503']?.description).not.toContain('5xx');
  });

  // GroupSettingsDto checks each field against its own type or range and refuses an explicit null, and
  // the engine lookup answers 400 for a session that is not started, so the 400 names all of them.
  it('describes every 400 of the settings update', () => {
    const description = responsesOf('updateSettings')['400']?.description ?? '';
    for (const part of ['`ephemeralSeconds`', '0 or more', '`memberAddMode`', '`all` or `admins`', '`null`']) {
      expect(description).toContain(part);
    }
    expect(description).toContain('not started');
    expect(description).not.toContain('not a boolean');
  });

  it('declares the rate-limited 503 on group creation', () => {
    expect(responsesOf('create')['503']?.description).toContain('429');
  });

  // A batch larger than a whole day's cold-reachout allowance is refused 400 without a retry hint.
  it.each(['create', 'addParticipants'])('%s describes the over-allowance 400', name => {
    expect(responsesOf(name)['400']?.description).toContain('cold-reachout allowance');
  });

  it.each(['removeParticipants', 'promoteParticipants', 'demoteParticipants'])('%s keeps the unpaced 400', name => {
    expect(responsesOf(name)['400']?.description).not.toContain('cold-reachout');
  });
});
