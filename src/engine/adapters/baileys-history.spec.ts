import type { WASocket } from '@whiskeysockets/baileys';
import { BaileysHistory, BaileysHistoryHost } from './baileys-history';

/**
 * `groupFetchAllParticipating` yields `{}` for BOTH an unanswered query and an account with no groups —
 * the same ambiguity `getGroups` is bounded against in baileys-groups.ts. Nothing in the VALUE separates
 * them, so only a clock we own can.
 *
 * That makes the stub shape load-bearing: a stub resolving `{}` immediately models the BENIGN case, and
 * a test built on it passes with or without a deadline. The unanswered case has to be modelled as a
 * promise that does not settle, with the clock advanced past the budget.
 */

function history(sock: Record<string, jest.Mock>) {
  const logger = { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() };
  const upsertChats = jest.fn();
  const host = {
    getSocket: () => sock as unknown as WASocket,
    logger,
    upsertChats,
    loadLib: () => Promise.resolve({ ALL_WA_PATCH_NAMES: [] }),
  } as unknown as BaileysHistoryHost;
  return { history: new BaileysHistory(host), logger, upsertChats };
}

const groupWarnCount = (logger: { warn: jest.Mock }): number =>
  (logger.warn.mock.calls as unknown[][]).filter(call => String(call[0]).includes('Group name hydration')).length;

describe('hydrateNames', () => {
  afterEach(() => jest.useRealTimers());

  it('reports a group query WhatsApp never answered instead of finishing silently', async () => {
    jest.useFakeTimers();
    const {
      history: h,
      logger,
      upsertChats,
    } = history({
      groupFetchAllParticipating: jest.fn(() => new Promise<never>(() => undefined)),
      resyncAppState: jest.fn().mockResolvedValue(undefined),
    });

    const settled = h.hydrateNames();
    await jest.advanceTimersByTimeAsync(120_000);
    await settled;

    expect(upsertChats).not.toHaveBeenCalled();
    expect(groupWarnCount(logger)).toBe(1);
  });

  it('stays quiet when WhatsApp answers that the account has no groups', async () => {
    // The benign twin of the case above, and the reason the deadline must not simply warn on an empty
    // result: this answer ARRIVED, so it is not a failure and must not be reported as one.
    const {
      history: h,
      logger,
      upsertChats,
    } = history({
      groupFetchAllParticipating: jest.fn().mockResolvedValue({}),
      resyncAppState: jest.fn().mockResolvedValue(undefined),
    });

    await h.hydrateNames();

    expect(upsertChats).not.toHaveBeenCalled();
    expect(groupWarnCount(logger)).toBe(0);
  });

  it('hydrates the names an answered query returns', async () => {
    const {
      history: h,
      logger,
      upsertChats,
    } = history({
      groupFetchAllParticipating: jest.fn().mockResolvedValue({
        '1@g.us': { id: '1@g.us', subject: 'Engineering' },
        '2@g.us': { id: '2@g.us' },
      }),
      resyncAppState: jest.fn().mockResolvedValue(undefined),
    });

    await h.hydrateNames();

    // The subject-less group is skipped: a chat row with no name is worse than no row.
    expect(upsertChats).toHaveBeenCalledWith([{ id: '1@g.us', name: 'Engineering' }]);
    expect(groupWarnCount(logger)).toBe(0);
  });

  it('still runs the app-state resync after an unanswered group query', async () => {
    // The two steps are independent best-effort work. Bounding the first exists partly so the second is
    // reached on the repo's own budget rather than the library's much longer default.
    jest.useFakeTimers();
    const resyncAppState = jest.fn().mockResolvedValue(undefined);
    const { history: h } = history({
      groupFetchAllParticipating: jest.fn(() => new Promise<never>(() => undefined)),
      resyncAppState,
    });

    const settled = h.hydrateNames();
    await jest.advanceTimersByTimeAsync(120_000);
    await settled;

    expect(resyncAppState).toHaveBeenCalledTimes(1);
  });
});
