import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'whatsapp-web.js';
import { DEFAULT_PUPPETEER_ARGS, PINNED_BROWSER_LOCALE } from '../../../config/configuration';
import { WhatsAppWebJsPlugin } from './index';

/**
 * The Chromium flags a session launches with when no args are configured. The plugin passes
 * whatever it was given and the adapter owns the one fallback, so both paths are driven here
 * through the real plugin, adapter and wwebjs Client (with the browser launch stubbed out).
 */
describe('whatsapp-web.js launch args', () => {
  const SESSION_ID = 'sess-launch-args';
  let tmpRoot: string;
  let clientInitSpy: jest.SpyInstance;
  let savedWebVersion: string | undefined;

  const launchedArgs = async (config: Record<string, unknown>): Promise<string[]> => {
    const plugin = new WhatsAppWebJsPlugin({ sessionDataPath: tmpRoot, ...config });
    const adapter = plugin.createEngine({ sessionId: SESSION_ID });
    await adapter.initialize({});
    return (adapter as unknown as { client: { options: { puppeteer: { args: string[] } } } }).client.options.puppeteer
      .args;
  };

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wwebjs-launch-args-'));
    savedWebVersion = process.env.WWEBJS_WEB_VERSION;
    process.env.WWEBJS_WEB_VERSION = 'off';
    clientInitSpy = jest
      .spyOn(Client.prototype as unknown as { initialize: () => Promise<void> }, 'initialize')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    clientInitSpy.mockRestore();
    if (savedWebVersion === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = savedWebVersion;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it.each([
    ['no puppeteer config', {}],
    ['a persisted puppeteer override without args', { puppeteer: { headless: true } }],
  ])('launches with the documented default flags and locale pin for %s', async (_label, config) => {
    expect(await launchedArgs(config)).toEqual([
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      `--lang=${PINNED_BROWSER_LOCALE}`,
      `--openwa-session=${SESSION_ID}`,
    ]);
    expect(DEFAULT_PUPPETEER_ARGS).toEqual([
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ]);
  });

  it('uses configured args verbatim and never mutates the shared array', async () => {
    const args = ['--no-sandbox', '--lang=de-DE'];

    expect(await launchedArgs({ puppeteer: { args } })).toEqual([
      '--no-sandbox',
      '--lang=de-DE',
      `--openwa-session=${SESSION_ID}`,
    ]);
    expect(args).toEqual(['--no-sandbox', '--lang=de-DE']);
  });
});
