import { Client } from 'whatsapp-web.js';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { resolveWebVersionPin, type WebVersionPin } from '../wa-web-version';
import { WwebjsLifecycle, type WwebjsLifecycleHost } from './wwebjs-lifecycle';
import { reportRunningWebBuild } from './wwebjs-running-build';
import { reportMissingCallHook } from './wwebjs-call-hook-check';
import { unappliedPatches } from './engine-patch-status';

jest.mock('../wa-web-version', () => ({ resolveWebVersionPin: jest.fn() }));
jest.mock('./wwebjs-running-build', () => ({ reportRunningWebBuild: jest.fn() }));
jest.mock('./wwebjs-call-hook-check', () => ({ reportMissingCallHook: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./engine-patch-status', () => ({
  unappliedPatches: jest.fn().mockReturnValue([]),
  unappliedPatchesMessage: jest.fn().mockReturnValue(''),
}));
jest.mock('./chromium-profile-hygiene', () => ({
  killOrphanedChromiumProcesses: jest.fn().mockResolvedValue(undefined),
  removeStaleSingletonFiles: jest.fn().mockResolvedValue(undefined),
}));

const resolvePin = resolveWebVersionPin as jest.Mock;
const report = reportRunningWebBuild as jest.Mock;
const callHookReport = reportMissingCallHook as jest.Mock;
const patches = unappliedPatches as jest.Mock;

const pinFor = (webVersion: string): WebVersionPin => ({
  webVersion,
  webVersionCache: { type: 'remote', remotePath: `https://example.invalid/${webVersion}.html` },
});

/**
 * The running-build probe compares the page against the pin THIS init requested, and it is a
 * diagnostic: READY must never wait on it or depend on how it settles.
 */
describe('the running-build probe at READY', () => {
  let clientInitSpy: jest.SpyInstance;
  let onReady: jest.Mock;
  const page = { evaluate: jest.fn() };

  /** A lifecycle taken through a real initialize() (the browser launch stubbed), then to READY. */
  const initializedLifecycle = async (): Promise<WwebjsLifecycle> => {
    const host = {
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      config: { sessionId: 'sess', sessionDataPath: './data/sessions' },
      getCallbacks: () => ({ onReady }),
      scheduleReadyReconcile: jest.fn(),
      clearReadyReconcile: jest.fn(),
      startOnboardingWatcher: jest.fn(),
      clearOnboardingWatcher: jest.fn(),
      clearLiveCalls: jest.fn(),
      clearLocalAuth: jest.fn().mockResolvedValue(undefined),
      attachDomainEvents: jest.fn(),
    } as unknown as WwebjsLifecycleHost;
    const lc = new WwebjsLifecycle(host);
    await lc.initialize();
    return lc;
  };

  const promoteToReady = (lc: WwebjsLifecycle): void => {
    (lc.client as unknown as { pupPage: unknown }).pupPage = page;
    lc.markReadyFromClientInfo();
  };

  beforeEach(() => {
    onReady = jest.fn();
    resolvePin.mockReset();
    report.mockReset().mockResolvedValue(undefined);
    callHookReport.mockClear();
    patches.mockReset().mockReturnValue([]);
    clientInitSpy = jest
      .spyOn(Client.prototype as unknown as { initialize: () => Promise<void> }, 'initialize')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    clientInitSpy.mockRestore();
  });

  it('hands the probe the page, the session and the pin this init requested', async () => {
    resolvePin.mockResolvedValue(pinFor('2.3000.1047787617-alpha'));
    const lc = await initializedLifecycle();
    promoteToReady(lc);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(page, expect.anything(), 'sess', '2.3000.1047787617-alpha');
  });

  it('hands the probe no pin when this init requested none', async () => {
    resolvePin.mockResolvedValue(undefined);
    const lc = await initializedLifecycle();
    promoteToReady(lc);
    expect(report).toHaveBeenCalledWith(page, expect.anything(), 'sess', undefined);
  });

  // A pin from an earlier init must never be compared against the page a later, unpinned init loads.
  it('replaces the pin on every init, including with none', async () => {
    resolvePin.mockResolvedValueOnce(pinFor('2.3000.1047787617-alpha')).mockResolvedValueOnce(undefined);
    const lc = await initializedLifecycle();
    await lc.initialize();
    promoteToReady(lc);
    expect(report).toHaveBeenCalledWith(page, expect.anything(), 'sess', undefined);
  });

  it('promotes to READY without waiting for the probe to settle', async () => {
    resolvePin.mockResolvedValue(pinFor('2.3000.1047787617-alpha'));
    report.mockReturnValue(new Promise<void>(() => undefined)); // never settles
    const lc = await initializedLifecycle();
    promoteToReady(lc);
    expect(report).toHaveBeenCalledTimes(1);
    expect(lc.status).toBe(EngineStatus.READY);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('stays READY when the probe rejects', async () => {
    resolvePin.mockResolvedValue(pinFor('2.3000.1047787617-alpha'));
    const lc = await initializedLifecycle();
    const rejection = Promise.reject(new Error('probe failed'));
    rejection.catch(() => undefined); // keep the test run free of an unhandled rejection
    report.mockReturnValue(rejection);
    expect(() => promoteToReady(lc)).not.toThrow();
    await new Promise(resolve => setImmediate(resolve));
    expect(report).toHaveBeenCalledTimes(1);
    expect(lc.status).toBe(EngineStatus.READY);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  // Unlike the call-hook probe, this one does not depend on when whatsapp-web.js finished injecting:
  // `window.Debug.VERSION` is WhatsApp Web's own. A tree missing the ready-sync patch keeps the log.
  it('still runs on a tree missing the ready-sync patch, which skips the call-hook probe', async () => {
    patches.mockReturnValue(['patch-wwebjs-ready-sync']);
    resolvePin.mockResolvedValue(pinFor('2.3000.1047787617-alpha'));
    const lc = await initializedLifecycle();
    promoteToReady(lc);
    expect(callHookReport).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(1);
  });
});
