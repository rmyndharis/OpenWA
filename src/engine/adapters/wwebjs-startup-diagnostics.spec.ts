import { Client } from 'whatsapp-web.js';
import { WwebjsLifecycle, type WwebjsLifecycleHost } from './wwebjs-lifecycle';
import { backportProblem } from './wwebjs-backport-check';
import { unappliedPatches, unappliedPatchesMessage } from './engine-patch-status';

jest.mock('./wwebjs-backport-check', () => ({ backportProblem: jest.fn() }));
jest.mock('./engine-patch-status', () => ({
  unappliedPatches: jest.fn().mockReturnValue([]),
  unappliedPatchesMessage: jest.fn(),
}));
jest.mock('./wwebjs-running-build', () => ({ reportRunningWebBuild: jest.fn() }));
jest.mock('./wwebjs-call-hook-check', () => ({ reportMissingCallHook: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./chromium-profile-hygiene', () => ({
  killOrphanedChromiumProcesses: jest.fn().mockResolvedValue(undefined),
  removeStaleSingletonFiles: jest.fn().mockResolvedValue(undefined),
}));
// Unpinned: the real pin fetches the version registry and writes a WhatsApp Web build under the data path.
jest.mock('../wa-web-version', () => ({ resolveWebVersionPin: jest.fn().mockResolvedValue(undefined) }));

const problem = backportProblem as jest.Mock;
const unapplied = unappliedPatches as jest.Mock;
const unappliedText = unappliedPatchesMessage as jest.Mock;

/**
 * An install whose patches did not land fails later with errors that name no cause, so the engine says
 * so at the start, where the operator is looking at the logs. The checks are pure functions with their
 * own specs; this is the call that makes them reach anyone.
 */
describe('the patch diagnostics at whatsapp-web.js start', () => {
  let clientInitSpy: jest.SpyInstance;
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };

  const initialize = async (): Promise<void> => {
    const host = {
      logger,
      config: { sessionId: 'sess', sessionDataPath: './data/sessions' },
      getCallbacks: () => ({}),
      scheduleReadyReconcile: jest.fn(),
      clearReadyReconcile: jest.fn(),
      startOnboardingWatcher: jest.fn(),
      clearOnboardingWatcher: jest.fn(),
      clearLiveCalls: jest.fn(),
      clearLocalAuth: jest.fn().mockResolvedValue(undefined),
      attachDomainEvents: jest.fn(),
    } as unknown as WwebjsLifecycleHost;
    await new WwebjsLifecycle(host).initialize();
  };

  beforeEach(() => {
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    problem.mockReset().mockReturnValue(undefined);
    unapplied.mockReset().mockReturnValue([]);
    unappliedText.mockReset().mockReturnValue('patch text');
    clientInitSpy = jest
      .spyOn(Client.prototype as unknown as { initialize: () => Promise<void> }, 'initialize')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    clientInitSpy.mockRestore();
  });

  it('logs the message-id backport problem as an error', async () => {
    problem.mockReturnValue('the backport is missing');

    await initialize();

    expect(logger.error).toHaveBeenCalledWith('the backport is missing');
  });

  it('logs the patches that did not land as an error', async () => {
    unapplied.mockReturnValue(['status']);
    unappliedText.mockReturnValue('the status patch is not applied');

    await initialize();

    expect(unappliedText).toHaveBeenCalledWith('wwebjs', ['status']);
    expect(logger.error).toHaveBeenCalledWith('the status patch is not applied');
  });

  it('says nothing when every patch landed', async () => {
    await initialize();

    expect(logger.error).not.toHaveBeenCalled();
  });
});
