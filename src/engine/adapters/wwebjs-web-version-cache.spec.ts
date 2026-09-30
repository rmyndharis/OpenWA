import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { __resetWebVersionCache } from '../wa-web-version';

/**
 * The web version cache handed to the whatsapp-web.js Client. Unpinned, the library's default is a
 * local cache written to a cwd-relative directory after the link; in the container that directory
 * is not writable, the write throws before `ready`, and the session never becomes ready.
 */
describe('whatsapp-web.js web version cache', () => {
  let clientInitSpy: jest.SpyInstance;
  let savedWebVersion: string | undefined;
  let dataDir: string;

  const launchedCacheOption = async (webVersion: string): Promise<unknown> => {
    process.env.WWEBJS_WEB_VERSION = webVersion;
    const adapter = new WhatsAppWebJsAdapter({
      sessionId: 'sess-web-version-cache',
      sessionDataPath: dataDir,
      puppeteer: {},
    });
    await adapter.initialize({});
    return (adapter as unknown as { client: { options: { webVersionCache: unknown } } }).client.options.webVersionCache;
  };

  beforeEach(() => {
    __resetWebVersionCache();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwebjs-web-version-'));
    savedWebVersion = process.env.WWEBJS_WEB_VERSION;
    // Build the real Client, whose options are merged over the library defaults, but launch no browser.
    clientInitSpy = jest
      .spyOn(Client.prototype as unknown as { initialize: () => Promise<void> }, 'initialize')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    __resetWebVersionCache();
    fs.rmSync(dataDir, { recursive: true, force: true });
    clientInitSpy.mockRestore();
    if (savedWebVersion === undefined) {
      delete process.env.WWEBJS_WEB_VERSION;
    } else {
      process.env.WWEBJS_WEB_VERSION = savedWebVersion;
    }
  });

  it('caches nothing to disk when no build is pinned', async () => {
    expect(await launchedCacheOption('off')).toEqual({ type: 'none' });
  });

  // whatsapp-web.js's remote cache fetches with no timeout and loads the live build on failure, so a
  // pinned build's HTML is downloaded first and served as a strict file on the data volume.
  it('serves a pinned build from a strict local cache under the session data path', async () => {
    const html = `<html>${'x'.repeat(2048)}</html>`;
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(html) } as unknown as Response);

    expect(await launchedCacheOption('2.3000.1000000000')).toEqual({
      type: 'local',
      path: path.join(path.resolve(dataDir), '.wa-web-cache'),
      strict: true,
    });
    expect(fs.readFileSync(path.join(dataDir, '.wa-web-cache', '2.3000.1000000000.html'), 'utf8')).toBe(html);

    // The library's own strict cache finds the file under the name it looks for.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const LocalWebCache = require('whatsapp-web.js/src/webCache/LocalWebCache') as new (options: object) => {
      resolve: (version: string) => Promise<string | null>;
    };
    const cache = new LocalWebCache({ path: path.join(path.resolve(dataDir), '.wa-web-cache'), strict: true });
    await expect(cache.resolve('2.3000.1000000000')).resolves.toBe(html);
  });

  it('runs unpinned when the pinned build cannot be downloaded', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    expect(await launchedCacheOption('2.3000.1000000000')).toEqual({ type: 'none' });
  });
});
