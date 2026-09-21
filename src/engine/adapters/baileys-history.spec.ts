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

// The real ALL_WA_PATCH_NAMES, so the snapshot pull below is asserted against the collection the
// code actually names rather than against a list contrived to exclude it.
const PATCH_NAMES = ['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'] as const;

function history(sock: Record<string, unknown> = {}, opts: { contactCount?: number } = {}) {
  const logger = { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() };
  const upsertChats = jest.fn();
  const socket = {
    authState: {
      creds: { accountSyncCounter: 0 },
      keys: { set: jest.fn().mockResolvedValue(undefined) },
    },
    resyncAppState: jest.fn().mockResolvedValue(undefined),
    ...sock,
  };
  const host = {
    getSocket: () => socket as unknown as WASocket,
    logger,
    upsertChats,
    contactCount: () => opts.contactCount ?? 0,
    loadLib: () => Promise.resolve({ ALL_WA_PATCH_NAMES: [...PATCH_NAMES] }),
  } as unknown as BaileysHistoryHost;
  return { history: new BaileysHistory(host), logger, upsertChats, socket };
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
    expect(resyncAppState).toHaveBeenCalledWith([...PATCH_NAMES], false);
  });

  it('re-pulls the address-book snapshot on the first reconnect of a process', async () => {
    // Baileys skips history + app-state snapshot once accountSyncCounter > 0. The gateway store is
    // in-memory, so a process restart would otherwise leave GET /contacts empty forever.
    const set = jest.fn().mockResolvedValue(undefined);
    const resyncAppState = jest.fn().mockResolvedValue(undefined);
    const { history: h } = history(
      {
        groupFetchAllParticipating: jest.fn().mockResolvedValue({}),
        resyncAppState,
        authState: { creds: { accountSyncCounter: 1 }, keys: { set } },
      },
      { contactCount: 0 },
    );

    await h.hydrateNames();

    // Only the contact collection is snapshotted; the others keep their versions and the ordinary
    // incremental resync still runs afterwards.
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ 'app-state-sync-version': { critical_unblock_low: null } });
    expect(resyncAppState.mock.calls).toEqual([
      [['critical_unblock_low'], true],
      [[...PATCH_NAMES], false],
    ]);
  });

  it('pulls the snapshot even when contacts are already held, since a partial address book cannot be counted', async () => {
    // The initial sync's buffer folds an app-state contacts.upsert into the history record of the
    // same id, and a history name is stripped as a chat title, so saved names go missing while the
    // store still holds plenty of contacts. A count-based gate reads that as "nothing to repair".
    const set = jest.fn().mockResolvedValue(undefined);
    const resyncAppState = jest.fn().mockResolvedValue(undefined);
    const { history: h } = history(
      {
        groupFetchAllParticipating: jest.fn().mockResolvedValue({}),
        resyncAppState,
        authState: { creds: { accountSyncCounter: 3 }, keys: { set } },
      },
      { contactCount: 12 },
    );

    await h.hydrateNames();

    expect(set).toHaveBeenCalledWith({ 'app-state-sync-version': { critical_unblock_low: null } });
    expect(resyncAppState).toHaveBeenCalledWith(['critical_unblock_low'], true);
  });

  it('pulls the snapshot once per process, not on every reconnect', async () => {
    const set = jest.fn().mockResolvedValue(undefined);
    const resyncAppState = jest.fn().mockResolvedValue(undefined);
    const { history: h } = history(
      {
        groupFetchAllParticipating: jest.fn().mockResolvedValue({}),
        resyncAppState,
        authState: { creds: { accountSyncCounter: 3 }, keys: { set } },
      },
      { contactCount: 0 },
    );

    await h.hydrateNames();
    await h.hydrateNames();

    expect(set).toHaveBeenCalledTimes(1);
    expect(resyncAppState.mock.calls.filter(([, initial]) => initial === true)).toHaveLength(1);
  });

  it('retries the snapshot on the next reconnect when the pull itself failed', async () => {
    // The once-per-instance flag is set BEFORE the await so two connects cannot pull concurrently,
    // which means a failed pull would otherwise spend the one attempt this instance gets and leave
    // the address book empty until a process restart.
    const set = jest.fn().mockRejectedValueOnce(new Error('socket closed')).mockResolvedValue(undefined);
    const resyncAppState = jest.fn().mockResolvedValue(undefined);
    const { history: h } = history(
      {
        groupFetchAllParticipating: jest.fn().mockResolvedValue({}),
        resyncAppState,
        authState: { creds: { accountSyncCounter: 1 }, keys: { set } },
      },
      { contactCount: 0 },
    );

    await h.hydrateNames(); // the pull throws and is swallowed by the outer catch
    expect(set).toHaveBeenCalledTimes(1);
    expect(resyncAppState.mock.calls.filter(([, initial]) => initial === true)).toHaveLength(0);

    await h.hydrateNames();
    expect(set).toHaveBeenCalledTimes(2);
    expect(resyncAppState).toHaveBeenCalledWith(['critical_unblock_low'], true);
  });

  it('uses the incremental resync on a first link (accountSyncCounter is still 0)', async () => {
    // First connect still has Baileys' own snapshot path in flight; forcing another snapshot would
    // race it. Empty contacts here are the boot window, not a missed reconnect.
    const set = jest.fn().mockResolvedValue(undefined);
    const resyncAppState = jest.fn().mockResolvedValue(undefined);
    const { history: h } = history(
      {
        groupFetchAllParticipating: jest.fn().mockResolvedValue({}),
        resyncAppState,
        authState: { creds: { accountSyncCounter: 0 }, keys: { set } },
      },
      { contactCount: 0 },
    );

    await h.hydrateNames();

    expect(set).not.toHaveBeenCalled();
    expect(resyncAppState).toHaveBeenCalledWith([...PATCH_NAMES], false);
  });
});
