import * as fs from 'fs';
import { Client } from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';

/**
 * whatsapp-web.js starts a further inject() from its own navigation listener with nothing awaiting it. During a
 * launch the adapter answers for those injects through the one the launch awaits last; when the launch ends
 * early, on the failure of the first inject, nobody awaits the later one, and it must still fail quietly. Jest
 * fails a test in which a promise is rejected with no handler, so the scenario alone is the probe: a process-level
 * 'unhandledRejection' listener of the spec never fires under Jest (the runner takes the event first).
 */
describe('a later inject of a launch that ended on the failure of the first', () => {
  let rmSpy: jest.SpyInstance;
  let initSpy: jest.SpyInstance;
  let injectSpy: jest.SpyInstance;
  let savedWebVersion: string | undefined;

  beforeEach(() => {
    savedWebVersion = process.env.WWEBJS_WEB_VERSION;
    process.env.WWEBJS_WEB_VERSION = 'off';
    rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
  });
  afterEach(() => {
    rmSpy.mockRestore();
    initSpy.mockRestore();
    injectSpy.mockRestore();
    if (savedWebVersion === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = savedWebVersion;
  });

  it('fails the launch with the first failure and leaves the later inject no unhandled rejection', async () => {
    const first = new Error('Failed to launch the browser process!');
    // The navigation listener's inject, which the test fails by hand once the launch has already been abandoned.
    let failLater: (reason: unknown) => void = () => undefined;
    const later = (): Promise<void> =>
      new Promise<void>((_resolve, reject) => {
        failLater = reject;
      });
    const injects: Array<() => Promise<void>> = [() => Promise.reject(first), later];
    let call = 0;
    injectSpy = jest
      .spyOn(Client.prototype as unknown as { inject: () => Promise<void> }, 'inject')
      .mockImplementation(() => injects[call++]());
    initSpy = jest
      .spyOn(Client.prototype as unknown as { initialize: () => Promise<void> }, 'initialize')
      .mockImplementation(async function (this: Client & { inject: () => Promise<void> }) {
        const own = this.inject();
        void this.inject();
        await own;
      });
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'sess-late-inject',
      sessionDataPath: './data/sessions',
      puppeteer: {},
    });

    await expect(adapter.initialize({})).rejects.toBe(first);

    // The library rejects its inject with a bare string. Node reports a rejection nobody handles once the microtask
    // queue has drained, so one macrotask is enough to let it show, and Jest then fails this test.
    failLater('ready timeout');
    await new Promise(resolve => setImmediate(resolve));
    expect(injectSpy).toHaveBeenCalledTimes(2);
  });
});
