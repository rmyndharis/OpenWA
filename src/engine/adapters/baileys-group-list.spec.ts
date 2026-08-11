import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysGroups, BaileysGroupsHost } from './baileys-groups';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/**
 * `groupFetchAllParticipating` builds its result as `const data = {}` and only fills it behind
 * `if (groupsChild)`. On an unanswered query `getBinaryNodeChild(undefined, 'groups')` is undefined,
 * the block is skipped, and `{}` comes back — the SAME value an account with no groups produces,
 * because that answer carries a real `<groups>` node with no `<group>` children.
 *
 * So there is nothing in the return value to inspect, and the empty list is the dangerous shape: a
 * caller reading `[]` has no way to tell "you are in no groups" from "WhatsApp never answered".
 * Only a clock we own separates them.
 */

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

describe('getGroups', () => {
  it('reports an unanswered query instead of an empty group list', async () => {
    const groupFetchAllParticipating = jest.fn(() => new Promise<never>(() => undefined));
    await expect(groups({ groupFetchAllParticipating }, 15).getGroups()).rejects.toBeInstanceOf(EngineTransportError);
  });

  it('still returns an empty list when WhatsApp answers that there are no groups', async () => {
    // A real answer that happens to be empty: the library yields {} for this too, so the ONLY thing
    // separating it from the case above is that it arrived.
    const groupFetchAllParticipating = jest.fn().mockResolvedValue({});
    await expect(groups({ groupFetchAllParticipating }, 500).getGroups()).resolves.toEqual([]);
  });

  it('maps a populated answer unchanged', async () => {
    const groupFetchAllParticipating = jest.fn().mockResolvedValue({
      '120363000000000000@g.us': {
        id: '120363000000000000@g.us',
        subject: 'Engineering',
        participants: [{ id: '628177@s.whatsapp.net', admin: 'superadmin' }],
      },
    });
    const list = await groups({ groupFetchAllParticipating }, 500).getGroups();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: '120363000000000000@g.us', name: 'Engineering' });
  });
});
