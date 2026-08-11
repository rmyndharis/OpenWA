import { Boom } from '@hapi/boom';
import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysGroups, BaileysGroupsHost } from './baileys-groups';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { InvalidInviteCodeError } from '../../common/errors/invalid-invite-code.error';

/**
 * Two sites turn a transport fault into a CLIENT error, which is the one thing their own comments
 * say must not happen. Neither goes through a catch on the timeout path:
 *
 *  - groupAcceptInvite RESOLVES undefined rather than throwing, so `if (!jid)` raises a 400 —
 *    "the invite code may be invalid" — for a query that never came back.
 *  - groupParticipantsUpdate yields [], so the empty-results guard raises a 403 refusal.
 */
const never = (): Promise<never> => new Promise<never>(() => undefined);

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

describe('joinGroupViaInviteCode', () => {
  it('reports an unanswered join instead of calling the invite code invalid', async () => {
    await expect(
      groups({ groupAcceptInvite: jest.fn(never) }, 15).joinGroupViaInviteCode('CODE'),
    ).rejects.toBeInstanceOf(EngineTransportError);
  });

  it('still calls a genuinely refused invite invalid', async () => {
    const groupAcceptInvite = jest.fn().mockRejectedValue(new Boom('gone', { data: 410 }));
    await expect(groups({ groupAcceptInvite }, 500).joinGroupViaInviteCode('BAD')).rejects.toBeInstanceOf(
      InvalidInviteCodeError,
    );
  });

  it('still calls an answered-but-empty result invalid — that is a real refusal', async () => {
    const groupAcceptInvite = jest.fn().mockResolvedValue(undefined);
    await expect(groups({ groupAcceptInvite }, 500).joinGroupViaInviteCode('BAD')).rejects.toBeInstanceOf(
      InvalidInviteCodeError,
    );
  });

  it('still returns the joined group id', async () => {
    const groupAcceptInvite = jest.fn().mockResolvedValue('120363000@g.us');
    await expect(groups({ groupAcceptInvite }, 500).joinGroupViaInviteCode('CODE')).resolves.toBe('120363000@g.us');
  });
});

describe('participant updates', () => {
  it('reports an unanswered update instead of a permissions refusal', async () => {
    await expect(
      groups({ groupParticipantsUpdate: jest.fn(never) }, 15).addParticipants('123@g.us', ['628111@c.us']),
    ).rejects.toBeInstanceOf(EngineTransportError);
  });

  it('still reports an answered-but-empty outcome as a refusal', async () => {
    const groupParticipantsUpdate = jest.fn().mockResolvedValue([]);
    await expect(
      groups({ groupParticipantsUpdate }, 500).addParticipants('123@g.us', ['628111@c.us']),
    ).rejects.toBeInstanceOf(EngineRefusedError);
  });

  it('still maps a per-participant outcome', async () => {
    const groupParticipantsUpdate = jest.fn().mockResolvedValue([{ status: '200', jid: '628111@s.whatsapp.net' }]);
    await expect(
      groups({ groupParticipantsUpdate }, 500).addParticipants('123@g.us', ['628111@c.us']),
    ).resolves.toEqual([{ id: '628111@s.whatsapp.net', success: true, status: 200 }]);
  });
});
