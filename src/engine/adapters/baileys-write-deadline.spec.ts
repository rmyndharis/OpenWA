import { Boom } from '@hapi/boom';
import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysGroups, BaileysGroupsHost } from './baileys-groups';
import { BaileysContacts, BaileysContactsHost } from './baileys-contacts';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { RecipientUnreachableError } from '../../common/errors/recipient-unreachable.error';

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
    sessionProxyUrl: () => undefined,
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
    sessionProxyUrl: () => undefined,
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

// A real 1x1 PNG: a picture write reads the header of its bytes before it reaches the socket.
const PNG = {
  mimetype: 'image/png',
  data: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
};

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
    // A relayed message rather than an IQ, but the group lookup and device fetch before the relay can stall.
    ['setGroupMemberLabel', 'updateMemberLabel', (g: BaileysGroups) => g.setGroupMemberLabel('123@g.us', 'Site A')],
  ])('%s', async (_name, sockMethod, call) => {
    await expect(call(groups({ [sockMethod]: stub() }, 15))).rejects.toBeInstanceOf(EngineTransportError);
  });

  it('still resolves when WhatsApp answers inside the budget', async () => {
    const groupLeave = jest.fn().mockResolvedValue(undefined);
    await expect(groups({ groupLeave }, 500).leaveGroup('123@g.us')).resolves.toBeUndefined();
    expect(groupLeave).toHaveBeenCalledWith('123@g.us');
  });

  it('names the operation that was not confirmed', async () => {
    await expect(groups({ groupLeave: stub() }, 15).leaveGroup('123@g.us')).rejects.toThrow(
      'WhatsApp did not confirm leaving the group in time',
    );
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

describe('a connection that closes under a call', () => {
  // Baileys rejects a query still waiting for its answer with the bare WebSocket close code (1006 when the
  // connection drops), and a write on a socket that is no longer open with Boom('Connection Closed', 428).
  // Neither carries a WA code for any caller to classify.
  const closed = () => jest.fn().mockRejectedValue(1006);
  const notOpen = () => jest.fn().mockRejectedValue(new Boom('Connection Closed', { statusCode: 428 }));

  it.each([
    ['a group write', () => groups({ groupUpdateSubject: closed() }, 500).setGroupSubject('123@g.us', 'X')],
    ['a group read', () => groups({ groupFetchAllParticipating: closed() }, 500).getGroups()],
    ['a profile write', () => contacts({ updateProfileName: closed() }, 500).setProfileName('Ada')],
    ['a block', () => contacts({ updateBlockStatus: closed() }, 500).blockContact('628111@c.us')],
    ['a profile write on a closed socket', () => contacts({ updateProfileName: notOpen() }, 500).setProfileName('Ada')],
    [
      'a contact save on a closed socket',
      () => contacts({ addOrEditContact: notOpen() }, 500).upsertContact('62811', 'A'),
    ],
    ['a block on a closed socket', () => contacts({ updateBlockStatus: notOpen() }, 500).blockContact('628111@c.us')],
  ])('answers 503 for %s', async (_name, call) => {
    await expect(call()).rejects.toBeInstanceOf(EngineTransportError);
  });

  it('leaves a WhatsApp error answer to the caller that classifies it', async () => {
    const refused = jest.fn().mockRejectedValue(Object.assign(new Error('forbidden'), { data: 403 }));
    await expect(groups({ groupUpdateSubject: refused }, 500).setGroupSubject('123@g.us', 'X')).rejects.toBeInstanceOf(
      EngineRefusedError,
    );
    // updateBlockStatus refuses an id it cannot map with a Boom 400 that carries no WA code.
    const unmapped = jest.fn().mockRejectedValue(Object.assign(new Error('no lid'), { output: { statusCode: 400 } }));
    await expect(contacts({ updateBlockStatus: unmapped }, 500).blockContact('628111@c.us')).rejects.toBeInstanceOf(
      RecipientUnreachableError,
    );
    // An answer that carries WA code 428 is a refusal, not a closed connection.
    const answered = jest.fn().mockRejectedValue(new Boom('precondition required', { statusCode: 428, data: 428 }));
    await expect(groups({ groupUpdateSubject: answered }, 500).setGroupSubject('123@g.us', 'X')).rejects.toBeInstanceOf(
      EngineRefusedError,
    );
  });
});
