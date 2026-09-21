import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { WwebjsLifecycle, type WwebjsLifecycleHost } from './wwebjs-lifecycle';
import { unappliedPatches } from './engine-patch-status';
import { reportMissingCallHook } from './wwebjs-call-hook-check';
import type { Client } from 'whatsapp-web.js';

jest.mock('./engine-patch-status', () => ({
  unappliedPatches: jest.fn().mockReturnValue([]),
  unappliedPatchesMessage: jest.fn().mockReturnValue(''),
}));
jest.mock('./wwebjs-call-hook-check', () => ({ reportMissingCallHook: jest.fn().mockResolvedValue(undefined) }));

const patches = unappliedPatches as jest.Mock;
const report = reportMissingCallHook as jest.Mock;

/**
 * The call-hook diagnostic is only meaningful once the page evaluate that installs the hook has
 * finished. The ready-sync patch is what guarantees that: without it a session can be promoted to
 * READY while the attach is still in flight, so the probe would read a hook that has simply not been
 * installed YET and warn about a fault that does not exist.
 */
function makeLifecycle(): WwebjsLifecycle {
  const host = {
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    config: { sessionId: 'sess', sessionDataPath: './data' },
    clearReadyReconcile: jest.fn(),
    startOnboardingWatcher: jest.fn(),
    emitState: jest.fn(),
    getCallbacks: () => ({}),
  } as unknown as WwebjsLifecycleHost;
  const lc = new WwebjsLifecycle(host);
  lc.status = EngineStatus.INITIALIZING;
  lc.client = { info: { wid: { user: '628111' }, pushname: 'Me' } } as unknown as Client;
  return lc;
}

describe('the call-hook diagnostic is gated on the ready-sync patch', () => {
  beforeEach(() => {
    patches.mockReset().mockReturnValue([]);
    report.mockReset().mockResolvedValue(undefined);
  });

  it('runs the probe on a tree where the patch is applied', () => {
    const lc = makeLifecycle();
    lc.markReadyFromClientInfo();
    expect(lc.status).toBe(EngineStatus.READY);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('skips the probe when the ready-sync patch is missing', () => {
    patches.mockReturnValue(['patch-wwebjs-ready-sync']);
    const lc = makeLifecycle();
    lc.markReadyFromClientInfo();
    expect(lc.status).toBe(EngineStatus.READY); // the promotion itself is never affected
    expect(report).not.toHaveBeenCalled();
  });

  it('still runs the probe when some other whatsapp-web.js patch is missing', () => {
    // Only the patch that decides WHEN ready fires can make the probe lie; an unrelated one does not.
    patches.mockReturnValue(['patch-wwebjs-media-id']);
    const lc = makeLifecycle();
    lc.markReadyFromClientInfo();
    expect(report).toHaveBeenCalledTimes(1);
  });
});
