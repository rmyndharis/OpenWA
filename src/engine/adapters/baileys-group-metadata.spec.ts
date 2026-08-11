import { Boom } from '@hapi/boom';
import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysGroups, BaileysGroupsHost } from './baileys-groups';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { GroupNotFoundError } from '../../common/errors/group-not-found.error';

/**
 * The three reads that resolve through Baileys' `extractGroupMetadata`. On an unanswered query it
 * throws `Boom('Invalid group metadata response: missing <group> node', { data: undefined })`, whose
 * `data` Boom normalises to null — so `refusedStatusCode` returns undefined, the raw Boom escapes,
 * and NestJS answers a bare 500 with the message discarded.
 *
 * `createGroup` is deliberately NOT given a deadline: it is the one non-idempotent site, and 503 is
 * a backpressure status the Go SDK retries three times for POST, which would risk duplicate groups.
 * Its bug is a different one — it has no refusal mapping at all.
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

/** What extractGroupMetadata actually throws when the query went unanswered. */
const noAnswer = () => new Boom('Invalid group metadata response: missing <group> node', { data: undefined });

const META = { id: '120363000000000000@g.us', subject: 'Engineering', participants: [] };

describe('getGroupInfo', () => {
  it('reports an unanswered query instead of a bare 500', async () => {
    await expect(groups({ groupMetadata: jest.fn(never) }, 15).getGroupInfo('123@g.us')).rejects.toBeInstanceOf(
      EngineTransportError,
    );
  });

  it.each([401, 403, 404])('still treats a WA %s refusal as not-found', async code => {
    const groupMetadata = jest.fn().mockRejectedValue(new Boom('refused', { data: code }));
    await expect(groups({ groupMetadata }, 500).getGroupInfo('123@g.us')).resolves.toBeNull();
  });

  it('still returns the group when WhatsApp answers inside the budget', async () => {
    const groupMetadata = jest.fn().mockResolvedValue(META);
    await expect(groups({ groupMetadata }, 500).getGroupInfo('123@g.us')).resolves.toMatchObject({
      id: '120363000000000000@g.us',
    });
  });
});

describe('getGroupJoinInfo', () => {
  it('reports an unanswered query instead of a bare 500', async () => {
    await expect(groups({ groupGetInviteInfo: jest.fn(never) }, 15).getGroupJoinInfo('CODE')).rejects.toBeInstanceOf(
      EngineTransportError,
    );
  });

  it('still maps a refused invite to not-found', async () => {
    const groupGetInviteInfo = jest.fn().mockRejectedValue(new Boom('item-not-found', { data: 404 }));
    await expect(groups({ groupGetInviteInfo }, 500).getGroupJoinInfo('BAD')).rejects.toBeInstanceOf(
      GroupNotFoundError,
    );
  });
});

describe('createGroup', () => {
  it('maps a WA refusal to a refusal instead of a bare 500', async () => {
    const groupCreate = jest.fn().mockRejectedValue(new Boom('not-authorized', { data: 403 }));
    await expect(groups({ groupCreate }, 500).createGroup('G', [])).rejects.toBeInstanceOf(EngineRefusedError);
  });

  it('lets an unanswered query propagate untouched — deliberately NOT a 503', async () => {
    // 503 is a backpressure status the Go SDK retries for POST; a deadline here could create
    // duplicate WhatsApp groups. The opaque failure is preferred over a retried side effect.
    const err = noAnswer();
    const groupCreate = jest.fn().mockRejectedValue(err);
    await expect(groups({ groupCreate }, 500).createGroup('G', [])).rejects.toBe(err);
  });

  it('still returns the created group', async () => {
    const groupCreate = jest.fn().mockResolvedValue(META);
    await expect(groups({ groupCreate }, 500).createGroup('G', [])).resolves.toMatchObject({
      id: '120363000000000000@g.us',
    });
  });
});
