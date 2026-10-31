import { EventEmitter } from 'events';
import * as fs from 'fs';
import { Client, WAState } from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { NAVIGATION_EPISODE_CAP_MS, NAVIGATION_REINJECT_GRACE_MS, WwebjsLifecycle } from './wwebjs-lifecycle';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';

/**
 * WhatsApp Web's socket answers CONNECTED again after a page reload whether or not whatsapp-web.js managed to
 * re-inject into the new page, and the library's re-emitted 'ready' can come from a run that started in the
 * previous document. So while a reload of a ready page is unverified the liveness probe, and every 'ready', also asks
 * the page for whatsapp-web.js's helpers. It never answers dead for a reload that is merely slow, inside its grace or
 * after it: only once the helpers stayed missing past the episode cap, counted from the first reload after the page
 * was last found re-injected, or re-emitted 'ready' well after its own reload.
 */
describe('liveness of a ready page after a reload', () => {
  type Page = EventEmitter & { evaluate: jest.Mock };
  type FakeClient = EventEmitter & { getState: jest.Mock; pupBrowser: EventEmitter; pupPage: Page };

  const wire = (): { adapter: WhatsAppWebJsAdapter; client: FakeClient } => {
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'sess-reload',
      sessionDataPath: './data/sessions',
      puppeteer: {},
    });
    const pupPage = Object.assign(new EventEmitter(), { evaluate: jest.fn().mockResolvedValue(true) });
    const client = Object.assign(new EventEmitter(), {
      getState: jest.fn().mockResolvedValue(WAState.CONNECTED),
      pupBrowser: new EventEmitter(),
      pupPage,
    });
    (adapter as unknown as { client: unknown }).client = client;
    (adapter as unknown as { callbacks: unknown }).callbacks = {};
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    const lifecycle = (adapter as unknown as { lifecycle: WwebjsLifecycle }).lifecycle;
    lifecycle.setupEventHandlers();
    lifecycle.attachPuppeteerLifecycleListeners();
    return { adapter, client };
  };
  const reload = (client: FakeClient): void => {
    client.pupPage.emit('framenavigated', { url: () => 'https://web.whatsapp.com/' });
  };
  const later = (ms: number): void => {
    jest.setSystemTime(Date.now() + ms);
  };
  const delayed = <T>(value: T, ms: number): Promise<T> => new Promise(resolve => setTimeout(() => resolve(value), ms));
  /**
   * Probe at the watchdog's cadence: the first probe `firstProbeAt` from now, then one every 60 s, each given its 15 s
   * deadline. With `loop`, that page reloads again 20 s after each probe (a navigation loop).
   */
  const watchdogAnswers = async (
    adapter: WhatsAppWebJsAdapter,
    ticks: number,
    { firstProbeAt = 45_000, loop }: { firstProbeAt?: number; loop?: FakeClient } = {},
  ): Promise<boolean[]> => {
    const answers: boolean[] = [];
    for (let tick = 0; tick < ticks; tick++) {
      if (tick === 0) {
        await jest.advanceTimersByTimeAsync(firstProbeAt);
      } else if (loop) {
        await jest.advanceTimersByTimeAsync(20_000);
        reload(loop);
        await jest.advanceTimersByTimeAsync(60_000 - 15_000 - 20_000);
      } else {
        await jest.advanceTimersByTimeAsync(60_000 - 15_000);
      }
      const probe = adapter.probeLiveness();
      await jest.advanceTimersByTimeAsync(15_000);
      answers.push(await probe);
    }
    return answers;
  };

  /** The watchdog's verdict on a run of answers: two dead in a row recycle the session. */
  const recycled = (answers: boolean[]): boolean => answers.some((alive, i) => i > 0 && !alive && !answers[i - 1]);
  /**
   * Nine watchdog answers for one page, read in budget (1 s + 1 s) or late (7 s + 5 s): its helpers are missing until
   * read number `found` (from 0, Infinity for never), after a single reload or while it keeps reloading between
   * probes, the first probe `firstProbeAt` after the reload.
   */
  const pageAnswers = async (
    found: number,
    late: boolean,
    loop: boolean,
    firstProbeAt = 45_000,
  ): Promise<boolean[]> => {
    const { adapter, client } = wire();
    let reads = 0;
    client.getState.mockImplementation(() => delayed(WAState.CONNECTED, late ? 7_000 : 1_000));
    client.pupPage.evaluate.mockImplementation(() => delayed(reads++ >= found, late ? 5_000 : 1_000));
    reload(client);
    return watchdogAnswers(adapter, 9, { firstProbeAt, loop: loop ? client : undefined });
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('answers alive after a normal reload and stops asking once the helpers were found', async () => {
    const { adapter, client } = wire();
    reload(client);
    client.emit('ready');

    await expect(adapter.probeLiveness()).resolves.toBe(true);
    later(NAVIGATION_EPISODE_CAP_MS);
    client.pupPage.evaluate.mockResolvedValue(false);
    await expect(adapter.probeLiveness()).resolves.toBe(true);

    // Once by the 'ready' itself and once by the probe that started before that read answered; never after.
    expect(client.pupPage.evaluate).toHaveBeenCalledTimes(2);
  });

  it('never answers dead inside the reload grace while the helpers are still missing', async () => {
    const { adapter, client } = wire();
    client.pupPage.evaluate.mockResolvedValue(false);
    reload(client);
    later(NAVIGATION_REINJECT_GRACE_MS / 2);

    await expect(adapter.probeLiveness()).resolves.toBe(true);
  });

  it('keeps answering alive for a slow reload that is still under the episode cap', async () => {
    const { adapter, client } = wire();
    client.pupPage.evaluate.mockResolvedValue(false);
    reload(client);
    later(NAVIGATION_EPISODE_CAP_MS - 1_000);

    await expect(adapter.probeLiveness()).resolves.toBe(true);
  });

  it('answers dead once the helpers stayed missing past the episode cap', async () => {
    const { adapter, client } = wire();
    client.pupPage.evaluate.mockResolvedValue(false);
    reload(client);
    later(NAVIGATION_EPISODE_CAP_MS);

    await expect(adapter.probeLiveness()).resolves.toBe(false);
  });

  // A 'ready' that reaches us after the reload closes the grace window, but it may belong to the previous page.
  it('is not convinced by a ready that the reloaded page itself did not back', async () => {
    const { adapter, client } = wire();
    client.pupPage.evaluate.mockResolvedValue(false);
    reload(client);
    client.emit('ready');

    later(NAVIGATION_EPISODE_CAP_MS - 1_000);
    await expect(adapter.probeLiveness()).resolves.toBe(true);
    later(1_000);
    await expect(adapter.probeLiveness()).resolves.toBe(false);
  });

  it('treats a helpers read that fails like missing helpers', async () => {
    const { adapter, client } = wire();
    client.pupPage.evaluate.mockRejectedValue(new Error('Execution context was destroyed.'));
    reload(client);
    later(NAVIGATION_REINJECT_GRACE_MS + 1_000);
    await expect(adapter.probeLiveness()).resolves.toBe(true);

    later(NAVIGATION_EPISODE_CAP_MS);
    await expect(adapter.probeLiveness()).resolves.toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  // getState() answered CONNECTED inside the probe budget, and a helpers read that has not finished proves nothing
  // either way, so it is not counted toward the cap. The reload stays unverified and the next probe asks again.
  it('answers alive when the helpers read is still pending at the deadline, and asks again next time', async () => {
    const { adapter, client } = wire();
    reload(client);
    later(NAVIGATION_EPISODE_CAP_MS);
    client.pupPage.evaluate.mockReturnValueOnce(new Promise<never>(() => {}));
    const probe = adapter.probeLiveness();
    const assertion = expect(probe).resolves.toBe(true);
    await jest.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(jest.getTimerCount()).toBe(0);

    client.pupPage.evaluate.mockResolvedValue(false);
    await expect(adapter.probeLiveness()).resolves.toBe(false);
    expect(client.pupPage.evaluate).toHaveBeenCalledTimes(2);
  });

  // A loaded renderer after a reload that did re-inject: getState() answers CONNECTED after 7 s and the helpers read
  // answers yes 5 s later, past the 10 s budget. Probed at the watchdog's cadence (every 60 s, each probe given 15 s),
  // the page must never read dead, also once the episode cap has passed.
  it('keeps a slow but re-injected page alive on every watchdog probe', async () => {
    const { adapter, client } = wire();
    client.getState.mockImplementation(() => delayed(WAState.CONNECTED, 7_000));
    client.pupPage.evaluate.mockImplementation(() => delayed(true, 5_000));
    reload(client);
    client.emit('ready');

    await expect(watchdogAnswers(adapter, 5)).resolves.toEqual([true, true, true, true, true]);
  });

  // The same loaded host after a reload that never re-injected: every helpers read answers no, or fails, but only
  // after the budget. Such an answer is still about the page now loaded, so the next probe counts it once it was
  // itself read past the cap, and the watchdog sees the page dead twice in a row (ticks 5 and 6 of 60 s).
  it.each([
    ['answers no', () => delayed(false, 5_000)],
    [
      'fails',
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('Execution context was destroyed.')), 5_000)),
    ],
  ])('recycles a reload that never re-injected when every helpers read %s late', async (_label, read) => {
    const { adapter, client } = wire();
    client.getState.mockImplementation(() => delayed(WAState.CONNECTED, 7_000));
    client.pupPage.evaluate.mockImplementation(read);
    reload(client);

    const answers = await watchdogAnswers(adapter, 6);

    expect(answers).toEqual([true, true, true, true, false, false]);
    expect(client.pupPage.evaluate).toHaveBeenCalledTimes(6);
  });

  // A page stuck reloading that never re-injects: each late no is about a page the next reload replaces, but the
  // reloads belong to one unverified episode, so the no still counts toward its cap, as an in-budget no does.
  it('recycles a navigation loop that never re-injects when every helpers read answers no late', async () => {
    const { adapter, client } = wire();
    client.getState.mockImplementation(() => delayed(WAState.CONNECTED, 7_000));
    client.pupPage.evaluate.mockImplementation(() => delayed(false, 5_000));
    reload(client);

    const answers = await watchdogAnswers(adapter, 8, { loop: client });

    expect(answers).toEqual([true, true, true, true, false, false, false, false]);
  });

  // The same loop on a page that does re-inject, only slowly and only from the fourth read on: the no kept from the
  // reloads before was read under the cap and costs nothing, the late yes closes the episode, and the next reload
  // starts clean.
  it('keeps a slow reloading page alive once it re-injects, after late no answers earlier in the episode', async () => {
    const { adapter, client } = wire();
    let reads = 0;
    client.getState.mockImplementation(() => delayed(WAState.CONNECTED, 7_000));
    client.pupPage.evaluate.mockImplementation(() => delayed(reads++ >= 3, 5_000));
    reload(client);

    const answers = await watchdogAnswers(adapter, 8, { loop: client });

    expect(recycled(answers)).toBe(false);
    expect(answers.slice(-4)).toEqual([true, true, true, true]);
  });

  // Helpers still missing at the first probe past the cap and found by the next: in budget that is one dead answer,
  // then alive, and the session is kept. A late read answers from the no kept before it, so it must count that no
  // only when the probe that read it started past the cap, or this healthy page would be recycled. At 50 s the late
  // read of that probe settles past the cap although its in-budget answer comes before it.
  it.each([
    [false, 45_000],
    [true, 45_000],
    [false, 50_000],
    [true, 50_000],
  ])(
    'keeps a page that re-injects in the first interval past the cap (loop %s, first probe at %i ms)',
    async (loop, at) => {
      expect(recycled(await pageAnswers(4, false, loop, at))).toBe(false);
      expect(recycled(await pageAnswers(4, true, loop, at))).toBe(false);
    },
  );

  // The watchdog's tick lands anywhere in the minute after a reload. At every phase, wherever the re-inject lands,
  // late reads recycle only pages that in-budget reads recycle, later by up to two watchdog intervals after one reload
  // and by more while the page keeps reloading, and a page that never re-injects is recycled on either.
  it.each(
    Array.from({ length: 12 }, (_, i) => i * 5_000).flatMap((at): [number, boolean][] => [
      [at, false],
      [at, true],
    ]),
  )('recycles on late reads only what in-budget reads recycle, first probe at %i ms (loop %s)', async (at, loop) => {
    const recycledOnlyLate: number[] = [];
    for (let found = 0; found <= 8; found++) {
      const late = recycled(await pageAnswers(found, true, loop, at));
      if (late && !recycled(await pageAnswers(found, false, loop, at))) recycledOnlyLate.push(found);
    }

    expect(recycledOnlyLate).toEqual([]);
    expect(recycled(await pageAnswers(Infinity, true, loop, at))).toBe(true);
    expect(recycled(await pageAnswers(Infinity, false, loop, at))).toBe(true);
  });

  // Latency that swings between probes: a no read in budget one minute and after it the next. Neither may reset the
  // watchdog's count, or two dead answers in a row never occur.
  it('recycles a reload that never re-injected when its helpers read is late only on some probes', async () => {
    const { adapter, client } = wire();
    let slow = true;
    client.getState.mockImplementation(() => delayed(WAState.CONNECTED, slow ? 7_000 : 1_000));
    client.pupPage.evaluate.mockImplementation(() => {
      slow = !slow;
      return delayed(false, 5_000);
    });
    reload(client);

    const answers = await watchdogAnswers(adapter, 8);

    expect(answers.slice(3)).toEqual([false, false, false, false, false]);
  });

  // A yes that arrives after the deadline is the same proof an in-budget yes gives, so it verifies the reload and
  // closes its episode. Left open, that episode would deny the reload grace to every later reload of the page.
  it('lets a late yes from the helpers read verify the reload, so a later reload is graced again', async () => {
    const { adapter, client } = wire();
    client.getState.mockImplementation(() => delayed(WAState.CONNECTED, 7_000));
    client.pupPage.evaluate.mockImplementation(() => delayed(true, 5_000));
    reload(client);
    const probe = adapter.probeLiveness();
    await jest.advanceTimersByTimeAsync(15_000);
    await expect(probe).resolves.toBe(true);

    later(NAVIGATION_EPISODE_CAP_MS);
    client.getState.mockRejectedValue(new Error('Execution context was destroyed.'));
    reload(client);
    await expect(adapter.probeLiveness()).resolves.toBe(true);
    expect(client.pupPage.evaluate).toHaveBeenCalledTimes(1);
  });

  /**
   * A page that reloads at each of `reloads` (ms from now). A reload destroys whatsapp-web.js's helpers, and only that
   * page's own re-inject, `reinjectAfter` ms later, brings them back and re-emits 'ready'. With `previousPageReady`, a
   * 'ready' also arrives 1 s after each reload, from a run that read the page before it.
   */
  const reloadingPage = (
    client: FakeClient,
    reloads: number[],
    reinjectAfter: number[],
    { late = false, previousPageReady = false }: { late?: boolean; previousPageReady?: boolean } = {},
  ): void => {
    let page = 0;
    let helpers = true;
    client.getState.mockImplementation(() => delayed(WAState.CONNECTED, late ? 7_000 : 1_000));
    client.pupPage.evaluate.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve(helpers), late ? 5_000 : 1_000)),
    );
    reloads.forEach((at, i) => {
      setTimeout(() => {
        page = i + 1;
        helpers = false;
        reload(client);
      }, at);
      if (previousPageReady) setTimeout(() => client.emit('ready'), at + 1_000);
      setTimeout(() => {
        if (page === i + 1) helpers = true;
        client.emit('ready');
      }, at + reinjectAfter[i]);
    });
  };

  // A slow re-inject (170 s, under the cap) is followed 5 s later by a second reload, before any probe saw the helpers.
  // The second page re-injects 100 s after its own reload. Every page re-injected, so the second reload begins an
  // episode of its own: inheriting the first one's anchor read it dead inside its own grace and recycled the session.
  it.each([
    ['in budget', false, false],
    ['late', true, false],
    ['in budget, with a ready from the previous page after each reload', false, true],
    ['late, with a ready from the previous page after each reload', true, true],
  ])(
    'keeps a page alive whose second reload follows a slow re-inject (%s)',
    async (_label, late, previousPageReady) => {
      const { adapter, client } = wire();
      reloadingPage(client, [0, 175_000], [170_000, 100_000], { late, previousPageReady });

      const answers = await watchdogAnswers(adapter, 6, { firstProbeAt: 60_000 });

      expect(answers).toEqual([true, true, true, true, true, true]);
    },
  );

  // A 'ready' that comes moments after a reload is no sign that the reloaded page re-injected: a page that keeps
  // reloading and never does is still recycled once its first reload is past the cap.
  it.each([
    ['in budget', false],
    ['late', true],
  ])(
    'recycles a navigation loop that never re-injects although a ready follows each reload (%s)',
    async (_label, late) => {
      const { adapter, client } = wire();
      client.getState.mockImplementation(() => delayed(WAState.CONNECTED, late ? 7_000 : 1_000));
      client.pupPage.evaluate.mockImplementation(() => delayed(false, late ? 5_000 : 1_000));
      client.pupPage.on('framenavigated', () => setTimeout(() => client.emit('ready'), 1_000));
      reload(client);

      const answers = await watchdogAnswers(adapter, 9, { loop: client });

      expect(recycled(answers)).toBe(true);
    },
  );

  // A fast host re-injects 3 or 4.5 s after each reload, too soon to be trusted on its delay, and the page reloads in
  // step with the watchdog, so each probe's helpers read lands just after a reload, before the helpers are back. The
  // 'ready' of each re-inject asks the page itself, finds the helpers, and the session is kept.
  it.each([
    ['every 60 s, re-injected 3 s after each reload', 60_000, 3_000],
    ['every 60 s, re-injected 4.5 s after each reload', 60_000, 4_500],
    ['every 30 s, re-injected 4.5 s after each reload', 30_000, 4_500],
  ])('keeps a page alive that keeps reloading and re-injects fast (%s)', async (_label, period, reinject) => {
    const { adapter, client } = wire();
    const reloads = Array.from({ length: Math.ceil(400_000 / period) }, (_, i) => 1_500 + i * period);
    const reinjects = reloads.map(() => reinject);
    reloadingPage(client, reloads, reinjects);

    const answers = await watchdogAnswers(adapter, 6, { firstProbeAt: 60_000 });

    expect(answers).toEqual([true, true, true, true, true, true]);
  });

  // The helpers read a 'ready' starts answers for the page it reached. One that answers only after a later reload
  // landed may have read the page before it, so it verifies nothing: that later page never re-injects and is recycled.
  it('does not let a helpers read that a reload overtook verify the page that reload loaded', async () => {
    const { adapter, client } = wire();
    reload(client);
    client.pupPage.evaluate.mockReturnValueOnce(delayed(true, 2_000));
    client.emit('ready');
    await jest.advanceTimersByTimeAsync(1_000);
    reload(client);
    await jest.advanceTimersByTimeAsync(1_000);

    client.pupPage.evaluate.mockReset().mockResolvedValue(false);
    later(NAVIGATION_EPISODE_CAP_MS);
    await expect(adapter.probeLiveness()).resolves.toBe(false);
  });

  it('does not ask the page when no reload is pending', async () => {
    const { adapter, client } = wire();

    await expect(adapter.probeLiveness()).resolves.toBe(true);
    expect(client.pupPage.evaluate).not.toHaveBeenCalled();
  });
});

describe('a re-inject that throws in a reloaded page', () => {
  let rmSpy: jest.SpyInstance;
  let initSpy: jest.SpyInstance;
  let injectSpy: jest.SpyInstance;
  let savedWebVersion: string | undefined;

  beforeEach(() => {
    savedWebVersion = process.env.WWEBJS_WEB_VERSION;
    process.env.WWEBJS_WEB_VERSION = 'off';
    rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    initSpy = jest
      .spyOn(Client.prototype as unknown as { initialize: () => Promise<void> }, 'initialize')
      .mockResolvedValue(undefined);
    injectSpy = jest
      .spyOn(Client.prototype as unknown as { inject: () => Promise<void> }, 'inject')
      .mockRejectedValue('ready timeout');
  });
  afterEach(() => {
    rmSpy.mockRestore();
    initSpy.mockRestore();
    injectSpy.mockRestore();
    if (savedWebVersion === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = savedWebVersion;
  });

  it('is logged as a warning naming the session instead of escaping as an unhandled rejection', async () => {
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'sess-reinject',
      sessionDataPath: './data/sessions',
      puppeteer: {},
    });
    const warn = jest.spyOn((adapter as unknown as { logger: { warn: () => void } }).logger, 'warn');
    await adapter.initialize({});
    const client = (adapter as unknown as { client: { inject: () => Promise<void> } }).client;

    // whatsapp-web.js calls this from its own framenavigated listener, which awaits nothing.
    await expect(client.inject()).resolves.toBeUndefined();

    expect(injectSpy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('re-inject'),
      expect.objectContaining({ sessionId: 'sess-reinject', action: 'page_reinject_failed', error: 'ready timeout' }),
    );
  });

  type WrappedClient = Client & { inject: () => Promise<void> };

  // The library re-injects on every navigation, also on the ones a teardown brings: the in-page unlink of our own
  // logout navigates while the logout is still awaited, and an unlink WhatsApp reports navigates to the QR page. A
  // re-inject that dies then is that teardown at work, not a reloaded page heading for a recycle.
  it.each<[string, (adapter: WhatsAppWebJsAdapter, client: WrappedClient) => Promise<void>]>([
    [
      'our own logout',
      async adapter => {
        const logout = jest
          .spyOn(Client.prototype as unknown as { logout: () => Promise<void> }, 'logout')
          .mockImplementation(function (this: WrappedClient) {
            return this.inject();
          });
        try {
          await adapter.logout();
        } finally {
          logout.mockRestore();
        }
      },
    ],
    [
      'a stop that already let go of the client',
      async (adapter, client) => {
        const destroy = jest
          .spyOn(Client.prototype as unknown as { destroy: () => Promise<void> }, 'destroy')
          .mockResolvedValue(undefined);
        try {
          await adapter.disconnect();
        } finally {
          destroy.mockRestore();
        }
        await client.inject();
      },
    ],
    [
      'an unlink WhatsApp reported',
      async (_adapter, client) => {
        client.emit('disconnected', 'LOGOUT');
        await client.inject();
      },
    ],
    [
      // The stuck-auth recovery drops the client with no teardown flag set, before the session reports anything.
      'a recovery that let go of the client',
      async (adapter, client) => {
        (adapter as unknown as { client: unknown }).client = null;
        await client.inject();
      },
    ],
  ])('is not logged when it dies under %s', async (_label, teardown) => {
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'sess-reinject',
      sessionDataPath: './data/sessions',
      puppeteer: {},
    });
    const warn = jest.spyOn((adapter as unknown as { logger: { warn: () => void } }).logger, 'warn');
    await adapter.initialize({});
    const client = (adapter as unknown as { client: WrappedClient }).client;

    await teardown(adapter, client);

    expect(injectSpy).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'page_reinject_failed' }),
    );
  });
});
