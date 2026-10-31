import type { WASocket } from '@whiskeysockets/baileys';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { BaileysGroups, type BaileysGroupsHost } from './baileys-groups';
import { BAILEYS_QUERY_BUDGET_MS } from './baileys-query-deadline';

/**
 * Baileys' query() waits 60 s (defaultQueryTimeoutMs) for an IQ answer and then RESOLVES undefined. Every
 * other group read and write here answers within OpenWA's own budget, which exists to stay under that
 * clock and under session.proxyTimeoutMs (60 s by default); the invite-code read and its revocation
 * have to as well.
 */
describe('Baileys group invite code queries WhatsApp does not answer', () => {
  /** What groupInviteCode / groupRevokeInvite do when the IQ goes unanswered: undefined after 60 s. */
  const unanswered = (): Promise<string | undefined> =>
    new Promise(resolve => setTimeout(() => resolve(undefined), 60_000));

  function groups(sock: Partial<WASocket>) {
    const host = {
      sessionProxyUrl: () => undefined,
      ensureReady: () => undefined,
      getSocket: () => sock as WASocket,
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      toNeutralJid: (jid: string) => jid,
      toEngineJid: (jid: string) => jid,
      normalizedSelfJid: () => '628999@s.whatsapp.net',
      addLidMappings: jest.fn(),
    } as unknown as BaileysGroupsHost;
    return new BaileysGroups(host);
  }

  /** Settles `work` against the fake clock and reports how it ended at `atMs`. */
  async function outcomeAt(work: Promise<unknown>, atMs: number): Promise<unknown> {
    let outcome: unknown = 'still waiting';
    work.then(
      value => (outcome = value),
      (error: unknown) => (outcome = error),
    );
    await jest.advanceTimersByTimeAsync(atMs);
    return outcome;
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it.each([
    ['getGroupInviteCode', 'groupInviteCode'],
    ['revokeGroupInviteCode', 'groupRevokeInvite'],
  ] as const)('%s answers 503 once the query budget is spent', async (method, socketCall) => {
    const delegate = groups({ [socketCall]: jest.fn(unanswered) });

    const outcome = await outcomeAt(delegate[method]('120363000000000000@g.us'), BAILEYS_QUERY_BUDGET_MS + 1);

    expect(outcome).toBeInstanceOf(EngineTransportError);
  });

  it.each([
    ['getGroupInviteCode', 'groupInviteCode'],
    ['revokeGroupInviteCode', 'groupRevokeInvite'],
  ] as const)('%s still returns the code WhatsApp answered within the budget', async (method, socketCall) => {
    const answered = (): Promise<string> => new Promise(resolve => setTimeout(() => resolve('AbCdEf123'), 1_000));
    const delegate = groups({ [socketCall]: jest.fn(answered) });

    const outcome = await outcomeAt(delegate[method]('120363000000000000@g.us'), 1_001);

    expect(outcome).toBe('AbCdEf123');
  });
});
