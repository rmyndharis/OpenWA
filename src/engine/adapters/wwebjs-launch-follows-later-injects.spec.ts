import * as fs from 'fs';
import { Client } from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';

/**
 * whatsapp-web.js starts inject() again from its own navigation listener, with nothing awaiting it. A launch
 * follows every inject it started from before initialize(), so a navigation that lands while the launch still
 * waits, or while it waits for the inject before it, cannot end the launch with a failure nobody reports.
 */
describe('a launch and the injects a navigation starts while it waits', () => {
  type Launching = Client & { inject: () => Promise<void> };
  type Proto = { inject: () => Promise<void>; initialize: () => Promise<void> };
  const proto = Client.prototype as unknown as Proto;
  const original = { inject: proto.inject, initialize: proto.initialize };
  let rmSpy: jest.SpyInstance;
  let started = 0;
  let savedWebVersion: string | undefined;

  beforeEach(() => {
    savedWebVersion = process.env.WWEBJS_WEB_VERSION;
    process.env.WWEBJS_WEB_VERSION = 'off';
    rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    started = 0;
  });
  afterEach(() => {
    rmSpy.mockRestore();
    proto.inject = original.inject;
    proto.initialize = original.initialize;
    if (savedWebVersion === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = savedWebVersion;
  });

  const newAdapter = (): WhatsAppWebJsAdapter =>
    new WhatsAppWebJsAdapter({ sessionId: 'sess-chain', sessionDataPath: './data/sessions', puppeteer: {} });
  /**
   * One macrotask lets every promise reaction already queued run, and Node reports a rejection nobody handles once
   * the microtask queue has drained: a barrier for those, not a wait for time to pass.
   */
  const macrotask = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
  /** Wait in real time for a condition the launch reaches on its own, up to a deadline. */
  const until = async (condition: () => boolean, label: string): Promise<void> => {
    for (let waited = 0; !condition(); waited += 10) {
      if (waited >= 5_000) throw new Error(`timed out waiting for ${label}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  /** An inject the test settles by hand. */
  const deferred = (): { run: () => Promise<void>; resolve: () => void; reject: (reason: string) => void } => {
    let resolve: () => void = () => undefined;
    let reject: (reason: string) => void = () => undefined;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { run: () => promise, resolve, reject };
  };

  /**
   * The library's initialize(), reduced to what a launch sees of it: it starts its own inject and one more the
   * listener started, and resolves with the first. `launching` hands the test the client being launched.
   */
  const launchWith = (injects: Array<() => Promise<void>>, launching: { client?: Launching }): void => {
    proto.inject = () => injects[started++]();
    proto.initialize = async function (this: Launching) {
      launching.client = this;
      const own = this.inject();
      void this.inject();
      await own;
    };
  };

  it('fails the launch with an inject that failed while the launch still waited for its own', async () => {
    const own = deferred();
    const listener = deferred();
    launchWith([own.run, listener.run], {});
    const adapter = newAdapter();
    const outcome = adapter.initialize({}).then(
      () => 'launched',
      (error: unknown) => error,
    );

    await until(() => started >= 2, 'the launch to start both injects');
    // The inject the listener started fails first, while initialize() still awaits its own. Nobody awaits it yet,
    // so a rejection left unhandled would show before the launch's own inject settles.
    listener.reject('auth timeout');
    await macrotask();
    own.resolve();

    await expect(outcome).resolves.toBe('auth timeout');
    expect(adapter.getStatus()).toBe(EngineStatus.FAILED);
  });

  it('fails the launch with an inject that began while the launch waited for the one before it', async () => {
    const own = deferred();
    const second = deferred();
    const third = deferred();
    const launching: { client?: Launching } = {};
    launchWith([own.run, second.run, third.run], launching);
    const adapter = newAdapter();
    const outcome = adapter.initialize({}).then(
      () => 'launched',
      (error: unknown) => error,
    );

    await until(() => started >= 2, 'the launch to start both injects');
    // initialize() resolves with its own inject, which the second one aborted: the launch now waits for the second.
    // The macrotask lets settled() take hold of the second before the third begins.
    own.resolve();
    await macrotask();
    // The page navigates again: the third inject takes over from the second, which resolves aborted, and fails.
    const takeover = launching.client?.inject();
    second.resolve();
    third.reject('auth timeout');
    await takeover?.catch(() => undefined);

    await expect(outcome).resolves.toBe('auth timeout');
    expect(adapter.getStatus()).toBe(EngineStatus.FAILED);
  });
});
