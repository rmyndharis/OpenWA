import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysGroups, BaileysGroupsHost } from './baileys-groups';
import { BaileysContacts, BaileysContactsHost } from './baileys-contacts';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * Every group and profile WRITE goes through a Baileys method that awaits `groupQuery`/`query` and
 * then discards the result, so the call resolves the same way whether WhatsApp confirmed the change
 * or never answered — and `query()` catches its own timeout and resolves rather than throwing.
 *
 * There is no value left to inspect, so these pin the only thing that can separate the two: a
 * deadline OpenWA owns. One case per call site, because a missed wrapper is invisible otherwise.
 */

const never = (): Promise<never> => new Promise<never>(() => undefined);
const stub = () => jest.fn(never);

function groups(sock: Record<string, jest.Mock>, budgetMs: number): BaileysGroups {
  const host = {
    ensureReady: () => undefined,
    getSocket: () => sock as unknown as WASocket,
    logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
    toNeutralJid: (j: string) => j,
    toEngineJid: (j: string) => j,
    normalizedSelfJid: () => '628177@s.whatsapp.net',
  } as unknown as BaileysGroupsHost;
  return new BaileysGroups(host, budgetMs);
}

function contacts(sock: Record<string, jest.Mock>, budgetMs: number): BaileysContacts {
  const host = {
    ensureReady: () => undefined,
    getSocket: () => sock as unknown as WASocket,
    logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
    normalizedSelfJid: () => '628177@s.whatsapp.net',
    listContacts: () => [],
    findContact: () => null,
    resolvePhone: () => null,
    listChats: () => [],
    lastMessage: () => null,
    toEngineJid: (j: string) => j,
  } as unknown as BaileysContactsHost;
  return new BaileysContacts(host, budgetMs);
}

const PNG = { mimetype: 'image/png', data: Buffer.from('x') };

describe('group writes report an unconfirmed write rather than success', () => {
  it.each([
    ['leaveGroup', 'groupLeave', (g: BaileysGroups) => g.leaveGroup('123@g.us')],
    ['setGroupSubject', 'groupUpdateSubject', (g: BaileysGroups) => g.setGroupSubject('123@g.us', 'X')],
    ['setGroupDescription', 'groupUpdateDescription', (g: BaileysGroups) => g.setGroupDescription('123@g.us', 'X')],
    [
      'setGroupMessagesAdminsOnly',
      'groupSettingUpdate',
      (g: BaileysGroups) => g.setGroupMessagesAdminsOnly('123@g.us', true),
    ],
    ['setGroupInfoAdminsOnly', 'groupSettingUpdate', (g: BaileysGroups) => g.setGroupInfoAdminsOnly('123@g.us', true)],
    ['setGroupPicture', 'updateProfilePicture', (g: BaileysGroups) => g.setGroupPicture('123@g.us', PNG)],
    ['deleteGroupPicture', 'removeProfilePicture', (g: BaileysGroups) => g.deleteGroupPicture('123@g.us')],
    [
      'setGroupMemberAddMode',
      'groupMemberAddMode',
      (g: BaileysGroups) => g.setGroupMemberAddMode('123@g.us', 'admins'),
    ],
    ['setGroupEphemeral', 'groupToggleEphemeral', (g: BaileysGroups) => g.setGroupEphemeral('123@g.us', 604800)],
  ])('%s', async (_name, sockMethod, call) => {
    await expect(call(groups({ [sockMethod]: stub() }, 15))).rejects.toBeInstanceOf(EngineTransportError);
  });

  it('still resolves when WhatsApp answers inside the budget', async () => {
    const groupLeave = jest.fn().mockResolvedValue(undefined);
    await expect(groups({ groupLeave }, 500).leaveGroup('123@g.us')).resolves.toBeUndefined();
    expect(groupLeave).toHaveBeenCalledWith('123@g.us');
  });
});

describe('profile writes report an unconfirmed write rather than success', () => {
  it.each([
    ['setProfileName', 'updateProfileName', (c: BaileysContacts) => c.setProfileName('Ada')],
    ['setProfileStatus', 'updateProfileStatus', (c: BaileysContacts) => c.setProfileStatus('busy')],
    ['setProfilePicture', 'updateProfilePicture', (c: BaileysContacts) => c.setProfilePicture(PNG)],
  ])('%s', async (_name, sockMethod, call) => {
    await expect(call(contacts({ [sockMethod]: stub() }, 15))).rejects.toBeInstanceOf(EngineTransportError);
  });

  it('still resolves when WhatsApp answers inside the budget', async () => {
    const updateProfileName = jest.fn().mockResolvedValue(undefined);
    await expect(contacts({ updateProfileName }, 500).setProfileName('Ada')).resolves.toBeUndefined();
    expect(updateProfileName).toHaveBeenCalledWith('Ada');
  });
});
