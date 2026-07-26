const mockWarn = jest.fn();
jest.mock('../common/services/logger.service', () => ({
  createLogger: () => ({ warn: mockWarn, log: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));

import {
  __resetWebVersionCache,
  pickSettledWebVersion,
  resolveCurrentWebVersion,
  resolveWebVersionPin,
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
    expect(pickSettledWebVersion(versions, now, '2.3000.FRESH-alpha')).toBe('2.3000.FRESH-alpha'); // none settled → fallback
  });

  it('picks the NEWEST qualifying (settled) build', () => {
    const versions = [
      entry('2.3000.OLD-alpha', 10 * 86_400_000, 50 * 86_400_000),
      entry('2.3000.NEW-alpha', settled() + 60_000, 50 * 86_400_000), // just past settle, newest qualifying
      entry('2.3000.MID-alpha', 5 * 86_400_000, 50 * 86_400_000),
    ];
    expect(pickSettledWebVersion(versions, now, '2.3000.NEW-alpha')).toBe('2.3000.NEW-alpha');
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
