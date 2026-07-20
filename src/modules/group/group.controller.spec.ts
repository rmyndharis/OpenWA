import { GroupController } from './group.controller';
import { GroupService } from './group.service';

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

  it('PUT :groupId/settings propagates a service rejection (empty patch / 501 passthrough)', async () => {
    const { controller } = build({
      updateGroupSettings: jest
        .fn()
        .mockRejectedValue(new Error('At least one of announce, locked, ephemeralSeconds must be provided')),
    });
    await expect(controller.updateSettings('s1', 'g1', {})).rejects.toThrow(/At least one/);
  });
});
