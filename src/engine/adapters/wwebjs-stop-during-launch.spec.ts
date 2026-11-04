import * as fs from 'fs';
import { Client } from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';

// The real module exports: the namespace an `import * as` builds cannot be spied on.
const childProcess = jest.requireActual<typeof import('child_process')>('child_process');

/**
 * whatsapp-web.js assigns pupBrowser only once puppeteer.launch has returned, and then loads WhatsApp Web with no
 * timeout. A stop that lands during the launch closes nothing, and a page that never loads (a proxy that black-holes
 * the traffic) never lets the launch settle and close its own browser. The session layer's init deadline then
 * force-destroys the engine, which must still reach that browser.
 */
describe('a whatsapp-web.js stop that lands while Chromium is launching', () => {
  let savedWebVersion: string | undefined;

  beforeEach(() => {
    // Keep initialize() offline and away from real processes and files.
    savedWebVersion = process.env.WWEBJS_WEB_VERSION;
    process.env.WWEBJS_WEB_VERSION = 'off';
    jest
      .spyOn(childProcess as unknown as { execFile: (...args: unknown[]) => void }, 'execFile')
      .mockImplementation((...args: unknown[]) => {
        (args[args.length - 1] as (error: Error | null, stdout: string, stderr: string) => void)(null, '', '');
      });
    jest.spyOn(process, 'kill').mockImplementation(() => true);
    jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (savedWebVersion === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = savedWebVersion;
  });

  it('kills the browser the launch went on to start when the engine is force-destroyed', async () => {
    const kill = jest.fn();
    const browser = { connected: true, close: jest.fn(), process: () => ({ kill }), on: jest.fn() };
    let finishLaunch!: () => void;
    const launch = new Promise<void>(resolve => (finishLaunch = resolve));
    let started!: () => void;
    const launching = new Promise<void>(resolve => (started = resolve));
    jest
      .spyOn(Client.prototype as unknown as { initialize: () => Promise<void> }, 'initialize')
      .mockImplementation(async function (this: Record<string, unknown>) {
        started();
        await launch;
        this.pupBrowser = browser;
        this.pupPage = { on: jest.fn() };
        // page.goto(WhatsWebURL, { timeout: 0 }) on a page that never loads
        await new Promise(() => undefined);
      });
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 's-launch',
      sessionDataPath: './data/sessions',
      puppeteer: {},
    });

    void adapter.initialize({}).catch(() => undefined);
    await launching;
    await adapter.disconnect();
    finishLaunch();
    await new Promise(resolve => setImmediate(resolve));
    await adapter.forceDestroy();

    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });
});
