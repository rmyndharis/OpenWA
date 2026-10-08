import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { createLogger } from '../../common/services/logger.service';
import { BaileysEvents, type BaileysEventsHost } from './baileys-events';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import {
  __resetGlobalInboundMediaGate,
  globalInboundMediaGate,
  inboundMediaGlobalConcurrency,
  runUnderGlobalMediaGate,
  capInboundMedia,
  chatHistoryMediaBudgetBytes,
  inboundMediaMaxBytes,
  inboundMediaConcurrency,
  inboundMediaTimeoutMs,
  withInboundDownloadTimeout,
  coerceDeclaredSize,
  isMediaDownloadEnabled,
  ingestMediaBudgetBytes,
} from './inbound-media-cap';

/**
 * Serve a message's media download from `download`: production reads it through the page
 * (downloadCappedMedia), and the same mock stays reachable as `downloadMedia` for assertions.
 */
const onPage = <T extends jest.Mock>(download: T) => ({
  downloadMedia: download,
  client: { pupPage: { evaluate: download } },
});

describe('inbound media cap', () => {
  const ENV = 'MEDIA_DOWNLOAD_MAX_BYTES';
  const CONC = 'INBOUND_MEDIA_CONCURRENCY';
  const TMO = 'MEDIA_DOWNLOAD_TIMEOUT_MS';
  const orig = process.env[ENV];
  const origConc = process.env[CONC];
  const origTmo = process.env[TMO];
  afterEach(() => {
    if (orig === undefined) delete process.env[ENV];
    else process.env[ENV] = orig;
    if (origConc === undefined) delete process.env[CONC];
    else process.env[CONC] = origConc;
    if (origTmo === undefined) delete process.env[TMO];
    else process.env[TMO] = origTmo;
  });

  describe('inboundMediaTimeoutMs', () => {
    it('defaults to 30000', () => {
      delete process.env[TMO];
      expect(inboundMediaTimeoutMs()).toBe(30_000);
    });
    it('honors a positive override', () => {
      process.env[TMO] = '5000';
      expect(inboundMediaTimeoutMs()).toBe(5000);
    });
    it('falls back to the default for a non-positive/garbage override', () => {
      process.env[TMO] = '0';
      expect(inboundMediaTimeoutMs()).toBe(30_000);
      process.env[TMO] = 'abc';
      expect(inboundMediaTimeoutMs()).toBe(30_000);
    });
  });

  describe('withInboundDownloadTimeout', () => {
    it('returns the value when the download settles before the deadline', async () => {
      const onTimeout = jest.fn();
      await expect(withInboundDownloadTimeout(Promise.resolve('buf'), 1000, onTimeout)).resolves.toBe('buf');
      expect(onTimeout).not.toHaveBeenCalled();
    });

    it('resolves null and runs onTimeout when the download outlasts the deadline', async () => {
      const onTimeout = jest.fn();
      const slow = new Promise<string>(resolve => setTimeout(() => resolve('late'), 1000).unref?.());
      await expect(withInboundDownloadTimeout(slow, 5, onTimeout)).resolves.toBeNull();
      expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it('swallows a late rejection from the abandoned download (no unhandled rejection)', async () => {
      let rejectFn: (e: Error) => void = () => undefined;
      const slow = new Promise<string>((_, reject) => {
        rejectFn = reject;
      });
      await expect(withInboundDownloadTimeout(slow, 5)).resolves.toBeNull();
      // Reject AFTER the race settled — must not surface as an unhandled rejection.
      rejectFn(new Error('media socket closed'));
      await Promise.resolve();
    });
  });

  describe('inboundMediaConcurrency', () => {
    it('defaults to 4', () => {
      delete process.env[CONC];
      expect(inboundMediaConcurrency()).toBe(4);
    });
    it('honors a positive override', () => {
      process.env[CONC] = '2';
      expect(inboundMediaConcurrency()).toBe(2);
    });
    it('falls back to the default for a non-positive/garbage override', () => {
      process.env[CONC] = '0';
      expect(inboundMediaConcurrency()).toBe(4);
      process.env[CONC] = 'abc';
      expect(inboundMediaConcurrency()).toBe(4);
    });
  });

  describe('coerceDeclaredSize', () => {
    it('passes a finite number through', () => {
      expect(coerceDeclaredSize(1234)).toBe(1234);
    });
    it('reads a Long-like { toNumber() }', () => {
      expect(coerceDeclaredSize({ toNumber: () => 5000 })).toBe(5000);
    });
    it('parses a numeric string', () => {
      expect(coerceDeclaredSize('4096')).toBe(4096);
    });
    it("returns 0 for absent/garbage (never NaN — don't pre-gate on unknown)", () => {
      expect(coerceDeclaredSize(undefined)).toBe(0);
      expect(coerceDeclaredSize(null)).toBe(0);
      expect(coerceDeclaredSize('xyz')).toBe(0);
      expect(coerceDeclaredSize(NaN)).toBe(0);
      expect(coerceDeclaredSize({})).toBe(0);
    });
  });

  describe('inboundMediaMaxBytes', () => {
    it('defaults to 50 MiB', () => {
      delete process.env[ENV];
      expect(inboundMediaMaxBytes()).toBe(50 * 1024 * 1024);
    });
    it('honors a positive override', () => {
      process.env[ENV] = '1024';
      expect(inboundMediaMaxBytes()).toBe(1024);
    });
    it('falls back to the default for a non-positive/garbage override', () => {
      process.env[ENV] = '0';
      expect(inboundMediaMaxBytes()).toBe(50 * 1024 * 1024);
      process.env[ENV] = 'abc';
      expect(inboundMediaMaxBytes()).toBe(50 * 1024 * 1024);
    });
  });

  describe('isMediaDownloadEnabled', () => {
    const ENV = 'MEDIA_DOWNLOAD_ENABLED';
    const orig = process.env[ENV];
    afterEach(() => {
      if (orig === undefined) delete process.env[ENV];
      else process.env[ENV] = orig;
    });

    it('defaults to true when unset', () => {
      delete process.env[ENV];
      expect(isMediaDownloadEnabled()).toBe(true);
    });

    it('returns false when set to "false"', () => {
      process.env[ENV] = 'false';
      expect(isMediaDownloadEnabled()).toBe(false);
    });

    it('returns false for case/whitespace variants of false', () => {
      process.env[ENV] = 'FALSE';
      expect(isMediaDownloadEnabled()).toBe(false);
      process.env[ENV] = 'False';
      expect(isMediaDownloadEnabled()).toBe(false);
      process.env[ENV] = ' false ';
      expect(isMediaDownloadEnabled()).toBe(false);
      process.env[ENV] = ' FALSE ';
      expect(isMediaDownloadEnabled()).toBe(false);
    });

    it('returns false when set to "0"', () => {
      process.env[ENV] = '0';
      expect(isMediaDownloadEnabled()).toBe(false);
    });

    it('returns false when set to "no"', () => {
      process.env[ENV] = 'no';
      expect(isMediaDownloadEnabled()).toBe(false);
    });

    it('returns true for any other value', () => {
      process.env[ENV] = 'true';
      expect(isMediaDownloadEnabled()).toBe(true);
      process.env[ENV] = '1';
      expect(isMediaDownloadEnabled()).toBe(true);
      process.env[ENV] = 'yes';
      expect(isMediaDownloadEnabled()).toBe(true);
      process.env[ENV] = 'whatever';
      expect(isMediaDownloadEnabled()).toBe(true);
    });
  });

  describe('chatHistoryMediaBudgetBytes', () => {
    const ENV = 'CHAT_HISTORY_MEDIA_BUDGET_BYTES';
    const orig = process.env[ENV];
    afterEach(() => {
      if (orig === undefined) delete process.env[ENV];
      else process.env[ENV] = orig;
    });

    it('defaults to 25 MiB', () => {
      delete process.env[ENV];
      expect(chatHistoryMediaBudgetBytes()).toBe(25 * 1024 * 1024);
    });
    it('honors a positive override', () => {
      process.env[ENV] = '1024';
      expect(chatHistoryMediaBudgetBytes()).toBe(1024);
    });
    it('falls back to the default for a non-positive/garbage override', () => {
      process.env[ENV] = '0';
      expect(chatHistoryMediaBudgetBytes()).toBe(25 * 1024 * 1024);
      process.env[ENV] = 'abc';
      expect(chatHistoryMediaBudgetBytes()).toBe(25 * 1024 * 1024);
    });
  });

  describe('capInboundMedia', () => {
    it('keeps media within the cap, encoding base64 exactly once', () => {
      const toBase64 = jest.fn(() => 'BASE64DATA');
      const res = capInboundMedia({
        mimetype: 'image/png',
        filename: 'p.png',
        sizeBytes: 1000,
        toBase64,
        maxBytes: 5000,
      });
      expect(res).toEqual({ mimetype: 'image/png', filename: 'p.png', data: 'BASE64DATA' });
      expect(toBase64).toHaveBeenCalledTimes(1);
    });

    it('drops over-cap media WITHOUT encoding it — marker only, no base64 (the RAM fix)', () => {
      const toBase64 = jest.fn(() => 'SHOULD-NOT-BE-CALLED');
      const res = capInboundMedia({
        mimetype: 'video/mp4',
        filename: 'v.mp4',
        sizeBytes: 99_999,
        toBase64,
        maxBytes: 5000,
      });
      expect(res).toEqual({ mimetype: 'video/mp4', filename: 'v.mp4', omitted: true, sizeBytes: 99_999 });
      expect(res.data).toBeUndefined();
      expect(toBase64).not.toHaveBeenCalled();
    });

    it('treats exactly-at-the-cap as within the limit', () => {
      const res = capInboundMedia({ mimetype: 'image/jpeg', sizeBytes: 5000, toBase64: () => 'D', maxBytes: 5000 });
      expect(res.data).toBe('D');
      expect(res.omitted).toBeUndefined();
    });
  });
});

describe('ingestMediaBudgetBytes', () => {
  // An ingest caller (the status seed) needs more headroom than one HTTP response, but "more" must
  // never mean unbounded: at a 10 MiB per-item cap a 50-item seed would otherwise stack ~650 MiB of
  // base64 on the heap at connect time.
  it('stays finite and scales with the per-item cap', () => {
    const budget = ingestMediaBudgetBytes(10 * 1024 * 1024);
    expect(Number.isFinite(budget)).toBe(true);
    expect(budget).toBeGreaterThan(ingestMediaBudgetBytes(1024));
  });

  it('leaves room for several full-size items (the two-videos case that motivated it)', () => {
    const perItem = 10 * 1024 * 1024;
    // ~1.37x accounts for base64 inflation of the decoded cap.
    expect(ingestMediaBudgetBytes(perItem)).toBeGreaterThan(2 * perItem * 1.37);
  });

  it('never drops below the response budget, and falls back to it for a garbage cap', () => {
    expect(ingestMediaBudgetBytes(1)).toBe(chatHistoryMediaBudgetBytes());
    expect(ingestMediaBudgetBytes(0)).toBe(chatHistoryMediaBudgetBytes());
    expect(ingestMediaBudgetBytes(Number.NaN)).toBe(chatHistoryMediaBudgetBytes());
  });
});

describe('process-wide inbound media gate (INBOUND_MEDIA_GLOBAL_CONCURRENCY)', () => {
  const KEYS = [
    'INBOUND_MEDIA_GLOBAL_CONCURRENCY',
    'INBOUND_MEDIA_CONCURRENCY',
    'MEDIA_DOWNLOAD_TIMEOUT_MS',
    'MEDIA_DOWNLOAD_MAX_BYTES',
    'MEDIA_DOWNLOAD_ENABLED',
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    KEYS.forEach(k => (saved[k] = process.env[k]));
    process.env.MEDIA_DOWNLOAD_ENABLED = 'true';
    process.env.MEDIA_DOWNLOAD_MAX_BYTES = String(10 * 1024 * 1024);
    __resetGlobalInboundMediaGate();
  });
  afterEach(() => {
    KEYS.forEach(k => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    });
    __resetGlobalInboundMediaGate();
    jest.useRealTimers();
  });

  type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
  const defer = <T>(): Deferred<T> => {
    let resolve: (v: T) => void = () => undefined;
    const promise = new Promise<T>(res => (resolve = res));
    return { promise, resolve };
  };

  it('is off unless set to a positive integer', () => {
    for (const value of [undefined, '', '0', 'abc']) {
      if (value === undefined) delete process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY;
      else process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY = value;
      expect(inboundMediaGlobalConcurrency()).toBe(0);
      __resetGlobalInboundMediaGate();
      expect(globalInboundMediaGate()).toBeNull();
    }
    process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY = '8';
    expect(inboundMediaGlobalConcurrency()).toBe(8);
  });

  it('builds one shared gate and runs tasks directly when off', async () => {
    process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY = '3';
    const gate = globalInboundMediaGate();
    expect(gate).toBeInstanceOf(ConcurrencyLimiter);
    expect(globalInboundMediaGate()).toBe(gate);

    __resetGlobalInboundMediaGate();
    process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY = '0';
    let ran = false;
    const pending = runUnderGlobalMediaGate(() => {
      ran = true;
      return Promise.resolve('ok');
    });
    expect(ran).toBe(true); // no gate: the task starts synchronously
    await expect(pending).resolves.toBe('ok');
  });

  describe('whatsapp-web.js', () => {
    const newAdapter = (sessionId: string): WhatsAppWebJsAdapter =>
      new WhatsAppWebJsAdapter({ sessionId, sessionDataPath: './data/sessions', puppeteer: {} });
    const cap = (adapter: WhatsAppWebJsAdapter, m: unknown): Promise<{ data?: string; omitted?: boolean }> =>
      (
        adapter as unknown as { capInboundMediaFor: (msg: unknown) => Promise<{ data?: string; omitted?: boolean }> }
      ).capInboundMediaFor(m);

    it('caps downloads in flight across sessions while each session keeps its own cap', async () => {
      process.env.INBOUND_MEDIA_CONCURRENCY = '4';
      process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY = '2';
      process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '100000';
      let inFlight = 0;
      let maxInFlight = 0;
      const downloads: Deferred<{ mimetype: string; data: string }>[] = [];
      const makeMsg = (id: string): unknown => ({
        id: { _serialized: id },
        _data: { size: 100, mimetype: 'image/png' },
        ...onPage(
          jest.fn(() => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            const d = defer<{ mimetype: string; data: string }>();
            downloads.push(d);
            return d.promise.finally(() => inFlight--);
          }),
        ),
      });
      const a = newAdapter('gate-a');
      const b = newAdapter('gate-b');

      const results = [
        ...['a1', 'a2', 'a3'].map(id => cap(a, makeMsg(id))),
        ...['b1', 'b2', 'b3'].map(id => cap(b, makeMsg(id))),
      ];
      for (let settled = 0; settled < 6; settled++) {
        await new Promise(resolve => setImmediate(resolve));
        expect(inFlight).toBeLessThanOrEqual(2);
        downloads[settled].resolve({ mimetype: 'image/png', data: Buffer.from(`m${settled}`).toString('base64') });
      }

      expect((await Promise.all(results)).every(r => typeof r.data === 'string')).toBe(true);
      expect(maxInFlight).toBe(2);
    });

    it('never downloads a message that timed out while queued on the shared gate', async () => {
      process.env.INBOUND_MEDIA_CONCURRENCY = '4';
      process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY = '1';
      process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '50';
      jest.useFakeTimers();
      const held = defer<{ mimetype: string; data: string }>();
      const first = {
        id: { _serialized: 'x1' },
        _data: { size: 100, mimetype: 'image/png' },
        ...onPage(jest.fn(() => held.promise)),
      };
      const second = {
        id: { _serialized: 'y1' },
        _data: { size: 100, mimetype: 'image/png' },
        ...onPage(jest.fn()),
      };

      const r1 = cap(newAdapter('gate-x'), first);
      const r2 = cap(newAdapter('gate-y'), second);
      await jest.advanceTimersByTimeAsync(60);

      expect(await r2).toEqual(expect.objectContaining({ omitted: true, sizeBytes: 100 }));
      held.resolve({ mimetype: 'image/png', data: Buffer.from('late').toString('base64') });
      await jest.advanceTimersByTimeAsync(0);
      expect(second.downloadMedia).not.toHaveBeenCalled();
      await r1;
    });
  });

  describe('Baileys', () => {
    type Stream = AsyncIterable<Buffer> & { destroy: jest.Mock };
    const imageMessage = (id: string): WAMessage => ({
      key: { id, remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
      messageTimestamp: 1_700_000_000,
      message: { imageMessage: { mimetype: 'image/png', fileLength: 64 } },
    });
    const build = (downloadMediaMessage: jest.Mock): BaileysEvents =>
      new BaileysEvents({
        getSocket: () => ({ updateMediaMessage: jest.fn() }) as unknown as WASocket,
        getSocketOrNull: () => null,
        logger: { ...createLogger('InboundMediaGateSpec'), warn: () => undefined },
        loadLib: () =>
          Promise.resolve({
            normalizeMessageContent: (c: unknown) => c,
            extractMessageContent: (c: unknown) => c,
            getContentType: (c: Record<string, unknown> | undefined) => Object.keys(c ?? {})[0],
            downloadMediaMessage,
          }),
        getFetchDispatcher: () => undefined,
        toNeutralJid: (jid: string) => jid,
        normalizedSelfJid: () => '6280000000000@s.whatsapp.net',
        inboundLimiter: new ConcurrencyLimiter(4),
      } as unknown as BaileysEventsHost);

    it('makes a second session wait for the gate and gives up at the deadline without downloading', async () => {
      process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY = '1';
      process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '1000';
      jest.useFakeTimers();
      const release = defer<void>();
      const slow: Stream = {
        async *[Symbol.asyncIterator]() {
          await release.promise;
          yield Buffer.from('first');
        },
        destroy: jest.fn(),
      };
      const downloadA = jest.fn().mockResolvedValue(slow);
      const downloadB = jest.fn();

      // Session A takes the only slot at t=0 with a 1s deadline; session B asks at t=30 with a 50 ms
      // one, so B's deadline (t=80) passes while A still holds the gate.
      const pendingA = build(downloadA).mapMessage(imageMessage('A1'), 'imageMessage');
      await jest.advanceTimersByTimeAsync(30);
      process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '50';
      const pendingB = build(downloadB).mapMessage(imageMessage('B1'), 'imageMessage');
      await jest.advanceTimersByTimeAsync(60);

      expect((await pendingB).media).toEqual(expect.objectContaining({ omitted: true, sizeBytes: 64 }));
      release.resolve();
      await jest.advanceTimersByTimeAsync(0);
      await pendingA;
      expect(downloadA).toHaveBeenCalledTimes(1);
      expect(downloadB).not.toHaveBeenCalled();
    });

    it('frees the slot at the deadline when a download never produces a stream', async () => {
      process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY = '1';
      process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '50';
      jest.useFakeTimers();
      // Session A's fetch never settles: an expired-media re-upload that the phone never answers.
      const stuck = jest.fn(() => new Promise<never>(() => undefined));
      const stream: Stream = {
        // eslint-disable-next-line @typescript-eslint/require-await
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('ok');
        },
        destroy: jest.fn(),
      };
      const downloadB = jest.fn().mockResolvedValue(stream);

      const pendingA = build(stuck).mapMessage(imageMessage('A2'), 'imageMessage');
      await jest.advanceTimersByTimeAsync(60);
      expect((await pendingA).media).toEqual(expect.objectContaining({ omitted: true }));

      const pendingB = build(downloadB).mapMessage(imageMessage('B2'), 'imageMessage');
      await jest.advanceTimersByTimeAsync(60);

      expect((await pendingB).media).toEqual(expect.objectContaining({ data: Buffer.from('ok').toString('base64') }));
      expect(stuck).toHaveBeenCalledTimes(1);
    });

    it('downloads immediately when the gate is off', async () => {
      process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY = '0';
      process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '10000';
      const stream: Stream = {
        // eslint-disable-next-line @typescript-eslint/require-await
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('ok');
        },
        destroy: jest.fn(),
      };
      const download = jest.fn().mockResolvedValue(stream);

      const incoming = await build(download).mapMessage(imageMessage('C1'), 'imageMessage');

      expect(incoming.media).toEqual(expect.objectContaining({ data: Buffer.from('ok').toString('base64') }));
    });
  });
});
