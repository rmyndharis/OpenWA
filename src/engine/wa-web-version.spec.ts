const mockWarn = jest.fn();
jest.mock('../common/services/logger.service', () => ({
  createLogger: () => ({ warn: mockWarn, log: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  __resetWebVersionCache,
  getEffectiveWebVersionInfo,
  PINNED_HTML_TIMEOUT_MS,
  pickSettledWebVersion,
  resolveCurrentWebVersion,
  resolveWebVersionPin,
  WA_VERSION_REGISTRY_URL,
  WEB_VERSION_SETTLE_MS,
} from './wa-web-version';

// Fixed reference instant (the #684 report timestamp) so the suite never depends on wall-clock time.
const FIXED_NOW = Date.parse('2026-07-11T07:05:00Z');

// Build a registry entry with released/expire relative to FIXED_NOW.
const entry = (version: string, ageMs: number, ttlMs: number, beta = false) => {
  const released = new Date(FIXED_NOW - ageMs).toISOString();
  const expire = new Date(FIXED_NOW + ttlMs).toISOString();
  return { version, beta, released, expire };
};

describe('pickSettledWebVersion', () => {
  const now = FIXED_NOW;
  const settled = (extra = 0) => WEB_VERSION_SETTLE_MS + extra;

  it('falls back to currentVersion when versions is missing or not an array', () => {
    expect(pickSettledWebVersion(undefined, now, '2.3000.1-alpha')).toBe('2.3000.1-alpha');
    expect(pickSettledWebVersion(null, now, '2.3000.1-alpha')).toBe('2.3000.1-alpha');
    expect(pickSettledWebVersion('nope', now, '2.3000.1-alpha')).toBe('2.3000.1-alpha');
  });

  it('falls back to currentVersion (or null) when no build qualifies', () => {
    expect(pickSettledWebVersion([], now, '2.3000.1-alpha')).toBe('2.3000.1-alpha');
    expect(pickSettledWebVersion([], now, null)).toBeNull();
  });

  it('prefers a settled build over a too-fresh currentVersion', () => {
    // currentVersion is 40 minutes old (the #684 scenario); one build is 2 days old.
    const versions = [
      entry('2.3000.1043012667-alpha', 40 * 60 * 1000, 60 * 86_400_000), // fresh — skip
      entry('2.3000.OLD-BUILD-alpha', 2 * 86_400_000, 50 * 86_400_000), // settled — pick
    ];
    expect(pickSettledWebVersion(versions, now, '2.3000.1043012667-alpha')).toBe('2.3000.OLD-BUILD-alpha');
  });

  it('skips builds newer than the settle window even if currentVersion is fresh', () => {
    const versions = [entry('2.3000.FRESH-alpha', 60 * 60 * 1000, 60 * 86_400_000)]; // 1h old
    expect(pickSettledWebVersion(versions, now, '2.3000.FALLBACK-alpha')).toBe('2.3000.FALLBACK-alpha'); // none settled → fallback
  });

  it('picks the NEWEST qualifying (settled) build', () => {
    const versions = [
      entry('2.3000.OLD-alpha', 10 * 86_400_000, 50 * 86_400_000),
      entry('2.3000.NEW-alpha', settled() + 60_000, 50 * 86_400_000), // just past settle, newest qualifying
      entry('2.3000.MID-alpha', 5 * 86_400_000, 50 * 86_400_000),
    ];
    expect(pickSettledWebVersion(versions, now, '2.3000.FALLBACK-alpha')).toBe('2.3000.NEW-alpha');
  });

  it('skips beta builds', () => {
    const versions = [
      entry('2.3000.BETA-alpha', settled(), 50 * 86_400_000, true), // beta=true → skip
      entry('2.3000.STABLE-alpha', settled() + 1000, 50 * 86_400_000, false),
    ];
    expect(pickSettledWebVersion(versions, now, '2.3000.BETA-alpha')).toBe('2.3000.STABLE-alpha');
  });

  it('skips already-expired builds', () => {
    const versions = [
      entry('2.3000.EXPIRED-alpha', settled(), -1000, false), // expire in the past
      entry('2.3000.LIVE-alpha', settled() + 1000, 50 * 86_400_000, false),
    ];
    expect(pickSettledWebVersion(versions, now, '2.3000.EXPIRED-alpha')).toBe('2.3000.LIVE-alpha');
  });

  it('skips malformed entries (non-string version / unparseable released)', () => {
    const versions = [
      { version: 123, beta: false, released: new Date(now - settled()).toISOString() }, // non-string version
      { version: '2.3000.OK-alpha', beta: false, released: 'not-a-date' }, // bad released
      entry('2.3000.GOOD-alpha', settled() + 1000, 50 * 86_400_000, false),
    ];
    expect(pickSettledWebVersion(versions, now, null)).toBe('2.3000.GOOD-alpha');
  });

  it('passes over builds in the skip set and picks the next older settled build', () => {
    const versions = [
      entry('2.3000.BAD-alpha', settled(), 50 * 86_400_000), // newest qualifying, but its page was not the app
      entry('2.3000.GOOD-alpha', settled() + 3_600_000, 50 * 86_400_000),
    ];
    expect(pickSettledWebVersion(versions, now, null)).toBe('2.3000.BAD-alpha');
    expect(pickSettledWebVersion(versions, now, null, new Set(['2.3000.BAD-alpha']))).toBe('2.3000.GOOD-alpha');
  });

  it('does not fall back to a currentVersion in the skip set', () => {
    const skip = new Set(['2.3000.BAD-alpha']);
    expect(pickSettledWebVersion([], now, '2.3000.BAD-alpha', skip)).toBeNull();
    expect(pickSettledWebVersion(undefined, now, '2.3000.BAD-alpha', skip)).toBeNull();
    expect(pickSettledWebVersion([], now, '2.3000.OK-alpha', skip)).toBe('2.3000.OK-alpha');
  });
});

describe('resolveCurrentWebVersion', () => {
  beforeEach(() => __resetWebVersionCache());
  afterEach(() => __resetWebVersionCache());

  const json = (body: unknown) => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });

  it('pins a settled build from versions[] over the raw currentVersion', async () => {
    const fetcher = jest.fn(() =>
      Promise.resolve(
        json({
          currentBeta: null,
          currentVersion: '2.3000.FRESH-alpha',
          versions: [
            {
              version: '2.3000.FRESH-alpha',
              beta: false,
              released: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
              expire: '2099-01-01T00:00:00Z',
            },
            {
              version: '2.3000.SETTLED-alpha',
              beta: false,
              released: new Date(Date.now() - 2 * 86_400_000).toISOString(),
              expire: '2099-01-01T00:00:00Z',
            },
          ],
        }),
      ),
    );
    await expect(resolveCurrentWebVersion(fetcher as never)).resolves.toBe('2.3000.SETTLED-alpha');
  });

  it('falls back to currentVersion when the registry carries no versions[]', async () => {
    const fetcher = jest.fn(() => Promise.resolve(json({ currentBeta: null, currentVersion: '2.3000.SOLO-alpha' })));
    await expect(resolveCurrentWebVersion(fetcher as never)).resolves.toBe('2.3000.SOLO-alpha');
  });

  // The registry deletes a build's HTML about 60 days after release. A pin cached for the life of the
  // process ended up pointing at a 404, and the page silently loaded the live build (#488 class).
  describe('on a long-running process', () => {
    const DAY = 86_400_000;
    let now = FIXED_NOW;
    beforeEach(() => {
      now = FIXED_NOW;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
    });
    afterEach(() => jest.restoreAllMocks());

    it('re-reads the registry once the pin is a day old', async () => {
      const fetcher = jest
        .fn()
        .mockResolvedValueOnce(json({ currentVersion: '2.3000.OLD-alpha' }))
        .mockResolvedValueOnce(json({ currentVersion: '2.3000.NEW-alpha' }));

      await expect(resolveCurrentWebVersion(fetcher as never)).resolves.toBe('2.3000.OLD-alpha');
      now += DAY - 1;
      await expect(resolveCurrentWebVersion(fetcher as never)).resolves.toBe('2.3000.OLD-alpha');
      expect(fetcher).toHaveBeenCalledTimes(1);
      now += 1;
      await expect(resolveCurrentWebVersion(fetcher as never)).resolves.toBe('2.3000.NEW-alpha');
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('keeps the previous pin when a refresh fails, rather than dropping it', async () => {
      const fetcher = jest
        .fn()
        .mockResolvedValueOnce(json({ currentVersion: '2.3000.OLD-alpha' }))
        .mockRejectedValue(new Error('boom'));

      await resolveCurrentWebVersion(fetcher as never);
      now += DAY;
      await expect(resolveCurrentWebVersion(fetcher as never)).resolves.toBe('2.3000.OLD-alpha');
      // Inside the failure backoff too: no second fetch, and still the previous pin.
      await expect(resolveCurrentWebVersion(fetcher as never)).resolves.toBe('2.3000.OLD-alpha');
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });
});

// Remote-HTML pins execute inside the authenticated web.whatsapp.com origin with no integrity
// check, so taking one MUST be visible to the operator — once per process, with the source and
// the opt-outs. 'off' (first-party) is the only path that must stay silent.
describe('resolveWebVersionPin remote-trust warning', () => {
  const ORIGINAL_ENV = process.env.WWEBJS_WEB_VERSION;
  const json = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });

  beforeEach(() => {
    __resetWebVersionCache();
    mockWarn.mockClear();
  });
  afterEach(() => {
    __resetWebVersionCache();
    if (ORIGINAL_ENV === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = ORIGINAL_ENV;
  });

  it('warns once (with version, source URL, and opt-out) when an exact version is pinned', async () => {
    process.env.WWEBJS_WEB_VERSION = '2.3000.1234-alpha';
    await resolveWebVersionPin();
    await resolveWebVersionPin(); // second resolve must NOT re-warn
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [message, meta] = mockWarn.mock.calls[0] as [string, Record<string, string>];
    expect(message).toContain('WITHOUT an integrity check');
    expect(meta.webVersion).toBe('2.3000.1234-alpha');
    expect(meta.remotePath).toContain('2.3000.1234-alpha');
    expect(meta.optOut).toContain('WWEBJS_WEB_VERSION=off');
  });

  it('stays silent when pinning is off (first-party build)', async () => {
    process.env.WWEBJS_WEB_VERSION = 'off';
    await expect(resolveWebVersionPin()).resolves.toBeUndefined();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('warns for the auto-resolved registry pin (the default posture)', async () => {
    delete process.env.WWEBJS_WEB_VERSION;
    const fetcher = jest.fn(() => Promise.resolve(json({ currentVersion: '2.3000.SOLO-alpha' })));
    await resolveWebVersionPin(fetcher as never);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('WITHOUT an integrity check'),
      expect.objectContaining({ webVersion: '2.3000.SOLO-alpha' }),
    );
  });
});

// A failed resolve degrades the engine to whatsapp-web.js's own version selection — the #488 class
// the pin exists to prevent. It used to do so in total silence, so the operator had nothing to grep.
describe('resolveCurrentWebVersion failure warning', () => {
  const json = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });

  beforeEach(() => {
    __resetWebVersionCache();
    mockWarn.mockClear();
  });
  afterEach(() => __resetWebVersionCache());

  const failureMeta = () => (mockWarn.mock.calls[0] as [string, Record<string, string>])[1];

  it('warns when the registry cannot be reached', async () => {
    const fetcher = jest.fn(() => Promise.reject(new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com')));
    await expect(resolveCurrentWebVersion(fetcher as never)).resolves.toBeNull();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const meta = failureMeta();
    expect(meta.action).toBe('web_version_resolve_failed');
    expect(meta.reason).toContain('ENOTFOUND');
    expect(meta.registry).toBe(WA_VERSION_REGISTRY_URL);
    expect(meta.remedy).toContain('WWEBJS_WEB_VERSION');
  });

  it('warns when the registry answers a non-ok status', async () => {
    const fetcher = jest.fn(() => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }));
    await expect(resolveCurrentWebVersion(fetcher as never)).resolves.toBeNull();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(failureMeta().reason).toContain('503');
  });

  it('warns when the registry answers with no usable build', async () => {
    const fetcher = jest.fn(() => Promise.resolve(json({ currentVersion: null, versions: [] })));
    await expect(resolveCurrentWebVersion(fetcher as never)).resolves.toBeNull();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(failureMeta().reason).toContain('no usable build');
  });

  it('stays silent on a successful resolve', async () => {
    const fetcher = jest.fn(() => Promise.resolve(json({ currentVersion: '2.3000.SOLO-alpha' })));
    await expect(resolveCurrentWebVersion(fetcher as never)).resolves.toBe('2.3000.SOLO-alpha');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  // The warning repeats so it survives a bounded log window, but the existing backoff is what keeps
  // that from becoming a per-call flood: the second call returns before the fetcher is even reached.
  it('does not re-warn inside the failure backoff window', async () => {
    const fetcher = jest.fn(() => Promise.reject(new Error('boom')));
    await resolveCurrentWebVersion(fetcher as never);
    await resolveCurrentWebVersion(fetcher as never);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});

// whatsapp-web.js fetches a remote pin's HTML with no timeout and, non-strict, loads the live build
// when that fails, silently. The HTML is now fetched here, bounded, and served as a strict local file.
describe('resolveWebVersionPin with a cache directory', () => {
  const ORIGINAL_ENV = process.env.WWEBJS_WEB_VERSION;
  const VERSION = '2.3000.1234';
  const HTML = `<!DOCTYPE html><html><head></head><body>${'x'.repeat(2048)}</body></html>`;
  let dir: string;

  const page = (body: string, status = 200) => ({ ok: status < 400, status, text: () => Promise.resolve(body) });
  const htmlWarning = (): Record<string, unknown> | undefined =>
    (mockWarn.mock.calls as [string, Record<string, unknown>][]).find(
      ([, meta]) => meta?.action === 'web_version_html_unavailable',
    )?.[1];

  beforeEach(() => {
    __resetWebVersionCache();
    mockWarn.mockClear();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-web-cache-'));
    process.env.WWEBJS_WEB_VERSION = VERSION;
  });
  afterEach(() => {
    jest.useRealTimers();
    __resetWebVersionCache();
    fs.rmSync(dir, { recursive: true, force: true });
    if (ORIGINAL_ENV === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = ORIGINAL_ENV;
  });

  it('writes the HTML and answers a strict local cache for it', async () => {
    const fetcher = jest.fn(() => Promise.resolve(page(HTML)));

    await expect(resolveWebVersionPin(fetcher as never, dir)).resolves.toEqual({
      webVersion: VERSION,
      webVersionCache: { type: 'local', path: dir, strict: true },
    });
    expect(fs.readFileSync(path.join(dir, `${VERSION}.html`), 'utf8')).toBe(HTML);
    expect(fs.readdirSync(dir)).toEqual([`${VERSION}.html`]);
    expect(htmlWarning()).toBeUndefined();
  });

  it('sends URL credentials as a Basic header, since fetch refuses a URL that carries them', async () => {
    process.env.WWEBJS_WEB_VERSION_REMOTE_PATH = 'https://u:p@mirror.example/{version}.html';
    try {
      const fetcher = jest.fn(() => Promise.resolve(page(HTML)));

      await expect(resolveWebVersionPin(fetcher as never, dir)).resolves.toMatchObject({
        webVersionCache: { type: 'local' },
      });
      expect(fetcher).toHaveBeenCalledWith(
        `https://mirror.example/${VERSION}.html`,
        expect.objectContaining({ headers: { Authorization: 'Basic dTpw' } }),
      );

      fetcher.mockResolvedValue(page('', 503));
      __resetWebVersionCache();
      await resolveWebVersionPin(fetcher as never, dir);
      expect(htmlWarning()?.remotePath).toBe(`https://mirror.example/${VERSION}.html`);
      const logged = JSON.stringify(mockWarn.mock.calls);
      expect(logged).not.toContain('u:p@');
    } finally {
      delete process.env.WWEBJS_WEB_VERSION_REMOTE_PATH;
    }
  });

  it('removes a build no start has written for a week, and keeps a recent one', async () => {
    const stale = path.join(dir, '2.3000.1.html');
    const recent = path.join(dir, '2.3000.2.html');
    fs.writeFileSync(stale, HTML);
    fs.writeFileSync(recent, HTML);
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, eightDaysAgo, eightDaysAgo);
    const fetcher = jest.fn(() => Promise.resolve(page(HTML)));

    await resolveWebVersionPin(fetcher as never, dir);

    expect(fs.readdirSync(dir).sort()).toEqual(['2.3000.1234.html', '2.3000.2.html']);
  });

  it('gives up at the bound and drops the pin with a named warning', async () => {
    jest.useFakeTimers();
    const fetcher = jest.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    );

    const pending = resolveWebVersionPin(fetcher as never, dir);
    await jest.advanceTimersByTimeAsync(PINNED_HTML_TIMEOUT_MS);

    await expect(pending).resolves.toBeUndefined();
    const warning = htmlWarning();
    expect(warning?.webVersion).toBe(VERSION);
    expect(warning?.reason).toContain(`${PINNED_HTML_TIMEOUT_MS} ms`);
    expect(warning?.remotePath).toContain(VERSION);
  });

  it.each([
    ['a non-ok status', page(HTML, 404), 'HTTP 404'],
    ['a body too short to be the page', page('<html></html>'), 'not a WhatsApp Web page'],
    ['a body that is not HTML', page('x'.repeat(4096)), 'not a WhatsApp Web page'],
  ])('drops the pin on %s and writes nothing', async (_label, response, reason) => {
    const fetcher = jest.fn(() => Promise.resolve(response));

    await expect(resolveWebVersionPin(fetcher as never, dir)).resolves.toBeUndefined();
    expect(htmlWarning()?.reason).toContain(reason);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('fetches a build once, shares a concurrent fetch, and retries after a failure', async () => {
    const fetcher = jest.fn().mockResolvedValueOnce(page('', 503)).mockResolvedValue(page(HTML));

    await expect(resolveWebVersionPin(fetcher as never, dir)).resolves.toBeUndefined();
    const [a, b] = await Promise.all([
      resolveWebVersionPin(fetcher as never, dir),
      resolveWebVersionPin(fetcher as never, dir),
    ]);
    await resolveWebVersionPin(fetcher as never, dir);

    expect(a?.webVersionCache.type).toBe('local');
    expect(b?.webVersionCache.type).toBe('local');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  // An auto pin moves to a newer build roughly daily, so keeping every build's page in memory grew
  // without bound over a long uptime. Only the current build is kept; an older one is fetched again.
  it('keeps only the latest build in memory', async () => {
    const fetcher = jest.fn(() => Promise.resolve(page(HTML)));

    await resolveWebVersionPin(fetcher as never, dir);
    process.env.WWEBJS_WEB_VERSION = '2.3000.5678';
    await resolveWebVersionPin(fetcher as never, dir);
    await resolveWebVersionPin(fetcher as never, dir);
    process.env.WWEBJS_WEB_VERSION = VERSION;
    await resolveWebVersionPin(fetcher as never, dir);

    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('refuses a version that is not a build number, without fetching or writing', async () => {
    process.env.WWEBJS_WEB_VERSION = '../../etc/x';
    const fetcher = jest.fn(() => Promise.resolve(page(HTML)));

    await expect(resolveWebVersionPin(fetcher as never, dir)).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(htmlWarning()).toBeDefined();
  });

  it('keeps the remote shape when no cache directory is given', async () => {
    const fetcher = jest.fn();

    await expect(resolveWebVersionPin(fetcher as never)).resolves.toMatchObject({
      webVersionCache: { type: 'remote' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('resolveWebVersionPin when a registry build is the logged-out page', () => {
  const ORIGINAL_ENV = process.env.WWEBJS_WEB_VERSION;
  const APP = `<!DOCTYPE html><html id="whatsapp-web" lang="en"><head></head><body>${'x'.repeat(2048)}</body></html>`;
  const LOGGED_OUT = `<!DOCTYPE html><html lang="en" id="whatsapp-web-logged-out"><head></head><body>${'x'.repeat(2048)}</body></html>`;
  const NEWEST = '2.3000.1053060988-alpha';
  const NEWER = '2.3000.1052966331-alpha';
  const OLDER = '2.3000.1052897873-alpha';
  const htmlUrl = (build: string) =>
    `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${build}.html`;
  let dir: string;

  // The builds are listed newest first, a day apart, so the picker names them in that order.
  const registry = (builds: string[]) => ({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        currentVersion: builds[0],
        versions: builds.map((version, i) => ({
          version,
          beta: false,
          released: new Date(Date.now() - (1 + i) * 86_400_000).toISOString(),
          expire: '2099-01-01T00:00:00Z',
        })),
      }),
  });
  const host = (builds: string[], pages: Record<string, string>) =>
    jest.fn((url: string) => {
      if (url === WA_VERSION_REGISTRY_URL) return Promise.resolve(registry(builds));
      const build = Object.keys(pages).find(b => url === htmlUrl(b));
      return Promise.resolve({
        ok: build !== undefined,
        status: build === undefined ? 404 : 200,
        text: () => Promise.resolve(build === undefined ? '' : pages[build]),
      });
    });
  const warnings = (action: string): Record<string, unknown>[] =>
    (mockWarn.mock.calls as [string, Record<string, unknown>][])
      .filter(([, meta]) => meta?.action === action)
      .map(([, meta]) => meta);

  beforeEach(() => {
    __resetWebVersionCache();
    mockWarn.mockClear();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-web-loggedout-'));
    delete process.env.WWEBJS_WEB_VERSION;
  });
  afterEach(() => {
    __resetWebVersionCache();
    fs.rmSync(dir, { recursive: true, force: true });
    if (ORIGINAL_ENV === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = ORIGINAL_ENV;
  });

  it('pins the next older settled build when the newest one is the logged-out page', async () => {
    const fetcher = host([NEWEST, NEWER, OLDER], { [NEWEST]: LOGGED_OUT, [NEWER]: APP, [OLDER]: APP });

    await expect(resolveWebVersionPin(fetcher as never, dir)).resolves.toEqual({
      webVersion: NEWER,
      webVersionCache: { type: 'local', path: dir, strict: true },
    });
    expect(fs.readdirSync(dir)).toEqual([`${NEWER}.html`]);
    expect(warnings('web_version_html_rejected')).toEqual([expect.objectContaining({ webVersion: NEWEST })]);
    expect(warnings('web_version_html_unavailable')).toEqual([]);
    expect(getEffectiveWebVersionInfo()).toEqual({ version: NEWER, source: 'auto' });
  });

  it('does not fetch the logged-out build again on the next start', async () => {
    const fetcher = host([NEWEST, NEWER], { [NEWEST]: LOGGED_OUT, [NEWER]: APP });

    await resolveWebVersionPin(fetcher as never, dir);
    await expect(resolveWebVersionPin(fetcher as never, dir)).resolves.toMatchObject({ webVersion: NEWER });

    expect(fetcher.mock.calls.filter(([url]) => url === htmlUrl(NEWEST))).toHaveLength(1);
    expect(warnings('web_version_html_rejected')).toHaveLength(1);
  });

  it('pins the next build from the same registry read when the registry cannot be read again', async () => {
    // The read that named the logged-out build is the only one that succeeds: the fallback must not need another.
    const pages = host([NEWEST, NEWER, OLDER], { [NEWEST]: LOGGED_OUT, [NEWER]: APP, [OLDER]: APP });
    let reads = 0;
    const fetcher = jest.fn((url: string) => {
      if (url !== WA_VERSION_REGISTRY_URL) return pages(url);
      reads += 1;
      return reads === 1 ? pages(url) : Promise.reject(new Error('registry unreachable'));
    });

    await expect(resolveWebVersionPin(fetcher as never, dir)).resolves.toMatchObject({ webVersion: NEWER });
    expect(reads).toBe(1);
    expect(fs.readdirSync(dir)).toEqual([`${NEWER}.html`]);
  });

  it('keeps skipping the rejected build after the daily refresh re-reads the registry', async () => {
    const DAY = 86_400_000;
    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const fetcher = host([NEWEST, NEWER], { [NEWEST]: LOGGED_OUT, [NEWER]: APP });
      await expect(resolveWebVersionPin(fetcher as never, dir)).resolves.toMatchObject({ webVersion: NEWER });

      now += DAY;
      await expect(resolveWebVersionPin(fetcher as never, dir)).resolves.toMatchObject({ webVersion: NEWER });
      expect(fetcher.mock.calls.filter(([url]) => url === htmlUrl(NEWEST))).toHaveLength(1);
      expect(warnings('web_version_html_rejected')).toHaveLength(1);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('reads the registry again when the only build of the last read was the logged-out page', async () => {
    // No candidate is left to fall back to, so the next resolve has to read the registry; the rejected build stays out.
    const FRESH = '2.3000.1053100000-alpha';
    let reads = 0;
    const pages = host([FRESH, NEWEST], { [FRESH]: APP, [NEWEST]: LOGGED_OUT });
    const fetcher = jest.fn((url: string) => {
      if (url !== WA_VERSION_REGISTRY_URL) return pages(url);
      reads += 1;
      return Promise.resolve(registry(reads === 1 ? [NEWEST] : [FRESH, NEWEST]));
    });

    await expect(resolveWebVersionPin(fetcher as never, dir)).resolves.toMatchObject({ webVersion: FRESH });
    expect(reads).toBe(2);
    expect(fs.readdirSync(dir)).toEqual([`${FRESH}.html`]);
  });

  it('shares one rejection between sessions that start together', async () => {
    const fetcher = host([NEWEST, NEWER], { [NEWEST]: LOGGED_OUT, [NEWER]: APP });

    const pins = await Promise.all([
      resolveWebVersionPin(fetcher as never, dir),
      resolveWebVersionPin(fetcher as never, dir),
      resolveWebVersionPin(fetcher as never, dir),
    ]);

    expect(pins.map(pin => pin?.webVersion)).toEqual([NEWER, NEWER, NEWER]);
    expect(fetcher.mock.calls.filter(([url]) => url === htmlUrl(NEWEST))).toHaveLength(1);
    expect(warnings('web_version_html_rejected')).toHaveLength(1);
  });

  it('gives up after three logged-out builds and drops the pin', async () => {
    const builds = [NEWEST, NEWER, OLDER, '2.3000.1052866173-alpha'];
    const fetcher = host(builds, Object.fromEntries(builds.map(b => [b, LOGGED_OUT])));

    await expect(resolveWebVersionPin(fetcher as never, dir)).resolves.toBeUndefined();

    const pages = fetcher.mock.calls.map(([url]) => url).filter(url => url !== WA_VERSION_REGISTRY_URL);
    expect(pages).toEqual([htmlUrl(NEWEST), htmlUrl(NEWER), htmlUrl(OLDER)]);
    expect(warnings('web_version_html_rejected')).toHaveLength(2);
    expect(warnings('web_version_html_unavailable')).toEqual([
      expect.objectContaining({ webVersion: OLDER, reason: expect.stringContaining('logged-out') as unknown }),
    ]);
    expect(fs.readdirSync(dir)).toEqual([]);
    // Out of builds, no rejected page is left reported as the resolved build; the next start reads the registry.
    expect(getEffectiveWebVersionInfo()).toEqual({ version: null, source: 'auto' });
  });

  it('does not swap an exact build the operator set', async () => {
    process.env.WWEBJS_WEB_VERSION = NEWEST;
    const fetcher = host([NEWEST, NEWER], { [NEWEST]: LOGGED_OUT, [NEWER]: APP });

    await expect(resolveWebVersionPin(fetcher as never, dir)).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(warnings('web_version_html_unavailable')).toEqual([expect.objectContaining({ webVersion: NEWEST })]);
    expect(warnings('web_version_html_rejected')).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it.each([
    ['single quotes and another attribute first', `<html lang="en" id='whatsapp-web-logged-out' dir="ltr">`],
    ['upper case', `<HTML ID="whatsapp-web-logged-out">`],
    ['spaces around the equals sign', `<html id = "whatsapp-web-logged-out">`],
    ['an unquoted value', `<html id=whatsapp-web-logged-out>`],
  ])('refuses the page with %s', async (_label, root) => {
    process.env.WWEBJS_WEB_VERSION = NEWEST;
    const page = `<!DOCTYPE html>${root}<head></head><body>${'x'.repeat(2048)}</body></html>`;

    await expect(resolveWebVersionPin(host([NEWEST], { [NEWEST]: page }) as never, dir)).resolves.toBeUndefined();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('keeps an app page that only mentions the logged-out id', async () => {
    process.env.WWEBJS_WEB_VERSION = NEWEST;
    const page = `<!DOCTYPE html><html id="whatsapp-web"><head><style>#whatsapp-web-logged-out{display:none}</style></head><body data-id="whatsapp-web-logged-out">${'x'.repeat(2048)}</body></html>`;

    await expect(resolveWebVersionPin(host([NEWEST], { [NEWEST]: page }) as never, dir)).resolves.toMatchObject({
      webVersion: NEWEST,
    });
    expect(fs.readdirSync(dir)).toEqual([`${NEWEST}.html`]);
  });
});

/**
 * The status reports the build the gateway resolves for sessions to pin, not the outcome of any one start: a
 * session whose pinned HTML cannot be loaded starts unpinned and logs it, and the reading stays what was resolved.
 * The infrastructure status and its documentation word it that way, and the dashboard shows the value as it is.
 */
describe('the build reported for sessions to pin', () => {
  const ORIGINAL_ENV = process.env.WWEBJS_WEB_VERSION;
  const BUILD = '2.3000.1047000000-alpha';
  const HTML = `<!DOCTYPE html><html><head></head><body>${'x'.repeat(2048)}</body></html>`;
  let dir: string;

  const html = (ok: boolean) => ({ ok, status: ok ? 200 : 404, text: () => Promise.resolve(ok ? HTML : '') });
  const registry = { ok: true, status: 200, json: () => Promise.resolve({ currentVersion: BUILD }) };
  const host = (htmlOk: boolean) =>
    jest.fn((url: string) => Promise.resolve(url === WA_VERSION_REGISTRY_URL ? registry : html(htmlOk)));

  beforeEach(() => {
    __resetWebVersionCache();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-web-reported-'));
  });
  afterEach(() => {
    __resetWebVersionCache();
    fs.rmSync(dir, { recursive: true, force: true });
    if (ORIGINAL_ENV === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = ORIGINAL_ENV;
  });

  it('stays the resolved registry build while the pinned HTML cannot be loaded, and after it can', async () => {
    delete process.env.WWEBJS_WEB_VERSION;

    await expect(resolveWebVersionPin(host(false) as never, dir)).resolves.toBeUndefined();
    expect(getEffectiveWebVersionInfo()).toEqual({ version: BUILD, source: 'auto' });

    await expect(resolveWebVersionPin(host(true) as never, dir)).resolves.toMatchObject({ webVersion: BUILD });
    expect(getEffectiveWebVersionInfo()).toEqual({ version: BUILD, source: 'auto' });
  });

  it('stays the operator-set build while its HTML cannot be loaded', async () => {
    process.env.WWEBJS_WEB_VERSION = '2.3000.1047000001-alpha';

    await expect(resolveWebVersionPin(host(false) as never, dir)).resolves.toBeUndefined();

    expect(getEffectiveWebVersionInfo()).toEqual({ version: '2.3000.1047000001-alpha', source: 'pinned' });
  });

  it('reports no build when the first-party build is chosen', () => {
    process.env.WWEBJS_WEB_VERSION = 'off';

    expect(getEffectiveWebVersionInfo()).toEqual({ version: null, source: 'native' });
  });
});
