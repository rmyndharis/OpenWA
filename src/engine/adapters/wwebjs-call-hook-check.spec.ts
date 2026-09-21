import { reportMissingCallHook } from './wwebjs-call-hook-check';

/**
 * whatsapp-web.js detects an incoming call by patching ONE page function: the call collection's
 * internal `Map.set`. It installs that patch only when the page's module for the collection exposes
 * an `.on` function, so a build that keeps the module but drops that method leaves messages working
 * and calls undetectable, with nothing in the log to say so. This check turns that silence into a
 * warning, and stays quiet for the neighbouring shapes it cannot tell apart from a healthy page.
 */
describe('reportMissingCallHook', () => {
  const makeLogger = (): { warn: jest.Mock; debug: jest.Mock } => ({ warn: jest.fn(), debug: jest.fn() });

  it('warns when the page still has the untouched set', async () => {
    const logger = makeLogger();
    const page = { evaluate: jest.fn().mockResolvedValue(false) };
    await reportMissingCallHook(page, logger as never, 'sess-1');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect((logger.warn.mock.calls[0] as [string, Record<string, unknown>])[1]).toMatchObject({
      sessionId: 'sess-1',
      action: 'call_hook_missing',
    });
  });

  it('stays silent when the hook is installed', async () => {
    const logger = makeLogger();
    const page = { evaluate: jest.fn().mockResolvedValue(true) };
    await reportMissingCallHook(page, logger as never, 'sess-1');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // An inconclusive read is not evidence of a missing hook: the collection may not be in the page's
  // module graph at all. Saying "calls are broken" on that would send operators after a non-problem.
  it('stays silent when the probe cannot decide', async () => {
    const logger = makeLogger();
    const page = { evaluate: jest.fn().mockResolvedValue(null) };
    await reportMissingCallHook(page, logger as never, 'sess-1');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('never throws when the page is gone or the read fails', async () => {
    const logger = makeLogger();
    await reportMissingCallHook(undefined, logger as never, 'sess-1');
    const dead = { evaluate: jest.fn().mockRejectedValue(new Error('Session closed')) };
    await reportMissingCallHook(dead, logger as never, 'sess-1');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
