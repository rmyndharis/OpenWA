import { MessageMedia, WAState } from 'whatsapp-web.js';
import { EventEmitter } from 'events';
import {
  WhatsAppWebJsAdapter,
  extractLinkedParentJID,
  isHttpUrl,
  isSupportedProxyUrl,
  loadRemoteMedia,
  resolveAuthTimeoutMs,
  resolveWebVersionPin,
  wwebjsAckToDeliveryStatus,
} from './whatsapp-web-js.adapter';
import * as fs from 'fs';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { SsrfBlockedError } from '../../common/security/ssrf-guard';
import { fetch as undiciFetch } from 'undici';

// loadRemoteMedia now fetches bytes through the SSRF-pinned path (undici fetch), then builds the
// MessageMedia locally — so mock undici fetch, not MessageMedia.fromUrl.
jest.mock('undici', () => {
  const actual = jest.requireActual<typeof import('undici')>('undici');
  return { __esModule: true, ...actual, fetch: jest.fn() };
});

describe('wwebjsAckToDeliveryStatus (engine ack-int -> neutral DeliveryStatus boundary, #265)', () => {
  // Regression-locks the integer boundary the decoupling moved behaviour into, incl. the
  // PLAYED(4) -> 'read' collapse that the old ackToMessageStatus(4) -> READ test used to cover.
  it.each([
    [-1, 'failed'],
    [0, 'pending'],
    [1, 'sent'],
    [2, 'delivered'],
    [3, 'read'],
    [4, 'read'], // PLAYED collapses to read
    [5, 'read'], // any future/higher ack stays read, never crashes
  ])('maps wwebjs ack %i -> %s', (ack, expected) => {
    expect(wwebjsAckToDeliveryStatus(ack)).toBe(expected);
  });
});

describe('isHttpUrl (remote-media detection, case-insensitive like Baileys)', () => {
  it.each(['http://x/y.png', 'https://x/y.png', 'HTTP://X/Y.PNG', 'Https://x/y.png', 'hTtPs://x'])(
    'treats %s as a remote URL',
    url => {
      expect(isHttpUrl(url)).toBe(true);
    },
  );

  it.each(['data:image/png;base64,iVBOR', 'iVBORw0KGgoAAAANSU', 'ftp://x/y', 'httpserver-not-a-url'])(
    'treats %s as non-URL (base64 / other)',
    s => {
      expect(isHttpUrl(s)).toBe(false);
    },
  );
});

describe('isSupportedProxyUrl', () => {
  it.each(['http://proxy:8080', 'https://proxy:8443', 'socks4://proxy:1080', 'socks5://user:pass@proxy:1080'])(
    'accepts %s',
    url => {
      expect(isSupportedProxyUrl(url)).toBe(true);
    },
  );

  it.each(['not a url', 'ftp://proxy:21', 'proxy:8080', ''])('rejects %s', url => {
    expect(isSupportedProxyUrl(url)).toBe(false);
  });
});

describe('extractLinkedParentJID (#201)', () => {
  it('returns null when no metadata is provided', () => {
    expect(extractLinkedParentJID()).toBeNull();
    expect(extractLinkedParentJID({})).toBeNull();
  });

  it('reads a string candidate directly', () => {
    expect(extractLinkedParentJID({ parentGroup: '120363000@g.us' })).toBe('120363000@g.us');
  });

  it('reads the _serialized field of a Wid candidate', () => {
    expect(extractLinkedParentJID({ parentGroup: { _serialized: '120363111@g.us' } })).toBe('120363111@g.us');
  });

  it('returns null when a Wid candidate has no _serialized', () => {
    expect(extractLinkedParentJID({ parentGroup: {} })).toBeNull();
  });

  it('prefers parentGroup, then linkedParentGroup, then linkedParent', () => {
    expect(
      extractLinkedParentJID({
        parentGroup: 'a@g.us',
        linkedParentGroup: 'b@g.us',
        linkedParent: 'c@g.us',
      }),
    ).toBe('a@g.us');

    expect(extractLinkedParentJID({ linkedParentGroup: 'b@g.us', linkedParent: 'c@g.us' })).toBe('b@g.us');
    expect(extractLinkedParentJID({ linkedParent: 'c@g.us' })).toBe('c@g.us');
  });

  it('ignores null/undefined candidates and falls through to the next', () => {
    expect(extractLinkedParentJID({ parentGroup: null, linkedParentGroup: 'b@g.us' })).toBe('b@g.us');
  });
});

describe('loadRemoteMedia — routes through the SSRF-pinned media fetch', () => {
  let fromUrlSpy: jest.SpyInstance;

  // A Response-like with a single-chunk body stream (mirrors load-remote-media.spec).
  const fakeResponse = (bytes: number[], headers: Record<string, string>) => ({
    ok: true,
    status: 200,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body: {
      getReader: () => {
        let done = false;
        return {
          read: () =>
            done
              ? Promise.resolve({ done: true, value: undefined })
              : ((done = true), Promise.resolve({ done: false, value: new Uint8Array(bytes) })),
          cancel: () => Promise.resolve(),
        };
      },
    },
  });

  beforeEach(() => {
    // Spied only to assert the vulnerable fromUrl path is NEVER taken.
    fromUrlSpy = jest.spyOn(MessageMedia, 'fromUrl');
    (undiciFetch as jest.Mock).mockReset();
  });

  afterEach(() => {
    fromUrlSpy.mockRestore();
    (undiciFetch as jest.Mock).mockReset();
    delete process.env.SSRF_ALLOWED_HOSTS;
  });

  it('builds MessageMedia from the pinned fetch bytes, never via MessageMedia.fromUrl', async () => {
    (undiciFetch as jest.Mock).mockResolvedValue(fakeResponse([104, 105], { 'content-type': 'image/png' }));

    const media = await loadRemoteMedia('https://8.8.8.8/x.png');

    expect(fromUrlSpy).not.toHaveBeenCalled(); // the unpinned node-fetch path is gone
    expect(media.mimetype).toBe('image/png');
    expect(media.data).toBe(Buffer.from([104, 105]).toString('base64'));
    expect(undiciFetch).toHaveBeenCalledWith(
      'https://8.8.8.8/x.png',
      expect.objectContaining({ redirect: 'manual' }), // pinned + redirects refused
    );
  });

  it('blocks an internal/loopback URL BEFORE any fetch (no outbound socket)', async () => {
    await expect(loadRemoteMedia('http://127.0.0.1/x.png')).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(undiciFetch).not.toHaveBeenCalled();
    expect(fromUrlSpy).not.toHaveBeenCalled();
  });

  it('blocks the cloud-metadata IP before fetching', async () => {
    await expect(loadRemoteMedia('http://169.254.169.254/latest/meta-data/x.png')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    expect(undiciFetch).not.toHaveBeenCalled();
  });

  it('honors the SSRF_ALLOWED_HOSTS escape-hatch for trusted internal media stores', async () => {
    process.env.SSRF_ALLOWED_HOSTS = 'minio';
    (undiciFetch as jest.Mock).mockResolvedValue(fakeResponse([1], { 'content-type': 'image/png' }));

    const media = await loadRemoteMedia('http://minio:9000/bucket/x.png');

    expect(media.mimetype).toBe('image/png');
    expect(fromUrlSpy).not.toHaveBeenCalled();
  });
});

describe('WhatsAppWebJsAdapter readiness guard (#100)', () => {
  const newAdapter = (): WhatsAppWebJsAdapter =>
    new WhatsAppWebJsAdapter({ sessionId: 'sess-1', sessionDataPath: './data/sessions', puppeteer: {} });

  it('rejects engine read ops with EngineNotReadyError when not connected', async () => {
    const adapter = newAdapter(); // status defaults to DISCONNECTED, no client

    await expect(adapter.getGroups()).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(adapter.checkNumberExists('628123')).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(adapter.getNumberId('628123')).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(adapter.resolveContactPhone('123@lid')).rejects.toBeInstanceOf(EngineNotReadyError);
  });

  it('carries HTTP 409 so NestJS returns "session not connected" (not 500) without a custom filter', () => {
    expect(new EngineNotReadyError().getStatus()).toBe(409);
  });
});

describe('WhatsAppWebJsAdapter.forwardMessage (returns the real sent id, not a synthetic fwd_ id)', () => {
  const readyAdapter = (client: unknown): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = client;
    return adapter;
  };

  it('returns the real id of the forwarded copy fetched from the destination chat', async () => {
    const forward = jest.fn().mockResolvedValue(undefined);
    const sourceChat = { fetchMessages: jest.fn().mockResolvedValue([{ id: { _serialized: 'SRC1' }, forward }]) };
    const destChat = {
      fetchMessages: jest.fn().mockResolvedValue([
        { id: { _serialized: 'OLD' }, timestamp: 100 },
        { id: { _serialized: 'REAL_FWD' }, timestamp: 200 }, // most recent fromMe = the forwarded copy
      ]),
    };
    const client = {
      getChatById: jest.fn((id: string) => Promise.resolve(id === 'dest@c.us' ? destChat : sourceChat)),
    };

    const result = await readyAdapter(client).forwardMessage('src@c.us', 'dest@c.us', 'SRC1');

    expect(forward).toHaveBeenCalledWith('dest@c.us');
    expect(result.id).toBe('REAL_FWD');
    expect(result.id).not.toMatch(/^fwd_/);
  });

  it('returns an explicit-unknown id (empty, not a real/synthetic id) when the sent copy cannot be identified', async () => {
    // Empty id leaves the forward row's waMessageId unset, so no ack can mis-match it (a source/synthetic
    // id could cross-drive another row's delivery status).
    const forward = jest.fn().mockResolvedValue(undefined);
    const sourceChat = { fetchMessages: jest.fn().mockResolvedValue([{ id: { _serialized: 'SRC1' }, forward }]) };
    const destChat = { fetchMessages: jest.fn().mockResolvedValue([]) };
    const client = {
      getChatById: jest.fn((id: string) => Promise.resolve(id === 'dest@c.us' ? destChat : sourceChat)),
    };

    const result = await readyAdapter(client).forwardMessage('src@c.us', 'dest@c.us', 'SRC1');

    expect(result.id).toBe('');
    expect(result.id).not.toMatch(/^fwd_/);
  });

  it('does not report a failure when post-forward id recovery throws (the forward already happened)', async () => {
    const forward = jest.fn().mockResolvedValue(undefined);
    const sourceChat = { fetchMessages: jest.fn().mockResolvedValue([{ id: { _serialized: 'SRC1' }, forward }]) };
    const client = {
      getChatById: jest.fn((id: string) =>
        id === 'dest@c.us' ? Promise.reject(new Error('puppeteer detached')) : Promise.resolve(sourceChat),
      ),
    };

    const result = await readyAdapter(client).forwardMessage('src@c.us', 'dest@c.us', 'SRC1');

    expect(forward).toHaveBeenCalledWith('dest@c.us');
    expect(result.id).toBe('');
  });
});

describe('WhatsAppWebJsAdapter.forceDestroy (recover a wedged session, #351)', () => {
  const newAdapter = (): WhatsAppWebJsAdapter =>
    new WhatsAppWebJsAdapter({ sessionId: 'sess-1', sessionDataPath: './data/sessions', puppeteer: {} });
  const setClient = (adapter: WhatsAppWebJsAdapter, client: unknown): void => {
    (adapter as unknown as { client: unknown }).client = client;
  };
  const getClient = (adapter: WhatsAppWebJsAdapter): unknown => (adapter as unknown as { client: unknown }).client;

  it('SIGKILLs only its own browser process, then best-effort destroys the client', async () => {
    const kill = jest.fn();
    const destroy = jest.fn().mockResolvedValue(undefined);
    const adapter = newAdapter();
    setClient(adapter, { pupBrowser: { process: () => ({ kill }) }, destroy });

    await adapter.forceDestroy();

    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(getClient(adapter)).toBeNull();
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  it('still completes when the process handle is gone and destroy() rejects (best-effort)', async () => {
    const adapter = newAdapter();
    setClient(adapter, {
      pupBrowser: { process: () => null },
      destroy: jest.fn().mockRejectedValue(new Error('wedged')),
    });

    await expect(adapter.forceDestroy()).resolves.toBeUndefined();
    expect(getClient(adapter)).toBeNull();
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
  });

  it('is a no-op when there is no client', async () => {
    const adapter = newAdapter();
    await expect(adapter.forceDestroy()).resolves.toBeUndefined();
  });
});

describe('WhatsAppWebJsAdapter ready reconciliation (#251/#273)', () => {
  const newAdapter = (): WhatsAppWebJsAdapter =>
    new WhatsAppWebJsAdapter({ sessionId: 'sess-1', sessionDataPath: './data/sessions', puppeteer: {} });
  type FakeClient = EventEmitter & {
    info?: { wid?: { user?: string }; pushname?: string };
    getState: jest.Mock;
    pupPage: { evaluate: jest.Mock };
    destroy?: jest.Mock;
    logout?: jest.Mock;
    pupBrowser?: { process?: jest.Mock };
  };
  const attachFakeClient = (
    adapter: WhatsAppWebJsAdapter,
    overrides: Partial<FakeClient> = {},
  ): { client: FakeClient; onReady: jest.Mock; onStateChanged: jest.Mock } => {
    const client = Object.assign(new EventEmitter(), {
      info: { wid: { user: '628123' }, pushname: 'Tester' },
      getState: jest.fn().mockResolvedValue(WAState.CONNECTED),
      pupPage: {
        evaluate: jest.fn().mockResolvedValue(true),
      },
      ...overrides,
    }) as FakeClient;
    const onReady = jest.fn();
    const onStateChanged = jest.fn();

    (adapter as unknown as { client: unknown }).client = client;
    (adapter as unknown as { callbacks: unknown }).callbacks = { onReady, onStateChanged };
    (adapter as unknown as { setupEventHandlers: () => void }).setupEventHandlers();

    return { client, onReady, onStateChanged };
  };
  const deferredVoid = (): { promise: Promise<void>; resolve: () => void } => {
    let resolve = (): void => undefined;
    const promise = new Promise<void>(res => {
      resolve = res;
    });
    return { promise, resolve };
  };
  const expectNoReadyDuringTeardown = async (
    configureClient: (client: FakeClient, teardownWait: Promise<void>) => void,
    startTeardown: (adapter: WhatsAppWebJsAdapter) => Promise<void>,
  ): Promise<void> => {
    jest.useFakeTimers();

    const adapter = newAdapter();
    const teardownWait = deferredVoid();
    const { client, onReady, onStateChanged } = attachFakeClient(adapter);
    configureClient(client, teardownWait.promise);

    client.emit('authenticated');
    expect(adapter.getStatus()).toBe(EngineStatus.AUTHENTICATING);
    expect(jest.getTimerCount()).toBe(1);

    const teardown = startTeardown(adapter);

    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    expect(onStateChanged).toHaveBeenLastCalledWith(EngineStatus.DISCONNECTED);
    expect(jest.getTimerCount()).toBe(0);

    client.emit('ready');
    await jest.advanceTimersByTimeAsync(2100);

    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    expect(onReady).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);

    teardownWait.resolve();
    await teardown;

    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    expect(onReady).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  it('marks the adapter ready when authenticated runtime is connected but the ready event is missed', async () => {
    jest.useFakeTimers();

    const adapter = newAdapter();
    const { client, onReady } = attachFakeClient(adapter);

    client.emit('authenticated');
    expect(adapter.getStatus()).toBe(EngineStatus.AUTHENTICATING);

    await jest.advanceTimersByTimeAsync(2100);

    expect(adapter.getStatus()).toBe(EngineStatus.READY);
    expect(onReady).toHaveBeenCalledWith('628123', 'Tester');
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('does not promote while the runtime is connected but client info is not populated yet', async () => {
    jest.useFakeTimers();

    const adapter = newAdapter();
    const { client, onReady } = attachFakeClient(adapter, { info: undefined });

    client.emit('authenticated');
    await jest.advanceTimersByTimeAsync(2100);

    expect(adapter.getStatus()).toBe(EngineStatus.AUTHENTICATING);
    expect(onReady).not.toHaveBeenCalled();

    client.emit('auth_failure', 'stop test timer');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('deduplicates the genuine ready event after reconciliation promotes the adapter', async () => {
    jest.useFakeTimers();

    const adapter = newAdapter();
    const { client, onReady } = attachFakeClient(adapter);

    client.emit('authenticated');
    await jest.advanceTimersByTimeAsync(2100);
    client.emit('ready');

    expect(adapter.getStatus()).toBe(EngineStatus.READY);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it.each([['disconnected', EngineStatus.DISCONNECTED] as const, ['auth_failure', EngineStatus.FAILED] as const])(
    'does not promote if %s fires during an in-flight probe tick',
    async (event, expectedStatus) => {
      jest.useFakeTimers();

      const adapter = newAdapter();
      const { client, onReady } = attachFakeClient(adapter);
      client.pupPage.evaluate.mockImplementation(() => {
        client.emit(event, 'test teardown');
        return Promise.resolve(true);
      });

      client.emit('authenticated');
      await jest.advanceTimersByTimeAsync(2100);

      expect(adapter.getStatus()).toBe(expectedStatus);
      expect(onReady).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('keeps repeated authenticated events to one timer chain and ignores authenticated after ready', async () => {
    jest.useFakeTimers();

    const adapter = newAdapter();
    const { client, onReady } = attachFakeClient(adapter);

    client.emit('authenticated');
    expect(jest.getTimerCount()).toBe(1);
    client.emit('authenticated');
    expect(jest.getTimerCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(2100);
    client.emit('authenticated');

    expect(adapter.getStatus()).toBe(EngineStatus.READY);
    expect(jest.getTimerCount()).toBe(0);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('disables ready reconciliation before disconnect awaits client teardown', async () => {
    await expectNoReadyDuringTeardown(
      (client, teardownWait) => {
        client.destroy = jest.fn().mockReturnValue(teardownWait);
      },
      adapter => adapter.disconnect(),
    );
  });

  it('disables ready reconciliation before logout awaits client teardown', async () => {
    await expectNoReadyDuringTeardown(
      (client, teardownWait) => {
        client.logout = jest.fn().mockReturnValue(teardownWait);
        client.destroy = jest.fn().mockResolvedValue(undefined);
      },
      adapter => adapter.logout(),
    );
  });

  it('disables ready reconciliation before destroy awaits client teardown', async () => {
    await expectNoReadyDuringTeardown(
      (client, teardownWait) => {
        client.destroy = jest.fn().mockReturnValue(teardownWait);
      },
      adapter => adapter.destroy(),
    );
  });

  it('disables ready reconciliation before forceDestroy awaits client teardown', async () => {
    await expectNoReadyDuringTeardown(
      (client, teardownWait) => {
        client.pupBrowser = { process: jest.fn().mockReturnValue({ kill: jest.fn() }) };
        client.destroy = jest.fn().mockReturnValue(teardownWait);
      },
      adapter => adapter.forceDestroy(),
    );
  });

  // A re-fired 'authenticated' (whatsapp-web.js can emit it again on a resume/resync before 'ready')
  // must NOT restart the 90s reconcile window, or a flapping link keeps the probe alive forever.
  it('does not reset the 90s reconcile deadline when authenticated re-fires mid-probe', async () => {
    jest.useFakeTimers();

    const adapter = newAdapter();
    // Runtime never reports the WWebJS global, so the probe never promotes and ticks to the deadline.
    const { client } = attachFakeClient(adapter, { pupPage: { evaluate: jest.fn().mockResolvedValue(false) } });

    client.emit('authenticated');
    await jest.advanceTimersByTimeAsync(80_000);
    expect(adapter.getStatus()).toBe(EngineStatus.AUTHENTICATING);

    client.emit('authenticated'); // re-fire 80s in — must not restart the window
    await jest.advanceTimersByTimeAsync(11_000); // 91s total since the FIRST authenticated

    expect(adapter.getStatus()).toBe(EngineStatus.AUTHENTICATING);
    expect(jest.getTimerCount()).toBe(0); // gave up at 90s; not reset by the re-fire
  });

  // beginClientTeardown sets DISCONNECTED before the awaited destroy/logout; an 'authenticated' event
  // arriving in that window must not resurrect the adapter to AUTHENTICATING.
  it('ignores an authenticated event fired during teardown (status stays disconnected)', async () => {
    jest.useFakeTimers();

    const adapter = newAdapter();
    const teardownWait = deferredVoid();
    const { client, onReady } = attachFakeClient(adapter);
    client.destroy = jest.fn().mockReturnValue(teardownWait.promise);

    client.emit('authenticated');
    expect(adapter.getStatus()).toBe(EngineStatus.AUTHENTICATING);

    const teardown = adapter.disconnect();
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    expect(jest.getTimerCount()).toBe(0);

    client.emit('authenticated'); // must NOT revive to AUTHENTICATING / re-arm the probe
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    expect(jest.getTimerCount()).toBe(0);

    teardownWait.resolve();
    await teardown;
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    expect(onReady).not.toHaveBeenCalled();
  });

  // A wedged page can make getState() hang (the exact #251/#273 condition). The probe must keep its
  // own cadence (a hung probe can't stall the loop) and still honor the 90s give-up deadline.
  it('keeps probing and self-heals (clears auth + disconnects) when getState hangs past the deadline', async () => {
    jest.useFakeTimers();
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);

    const adapter = newAdapter();
    const { client } = attachFakeClient(adapter, {
      getState: jest.fn().mockReturnValue(new Promise<never>(() => {})),
      destroy: jest.fn().mockResolvedValue(undefined),
    });
    const onDisconnected = jest.fn();
    (adapter as unknown as { callbacks: { onDisconnected?: jest.Mock } }).callbacks.onDisconnected = onDisconnected;

    client.emit('authenticated');
    await jest.advanceTimersByTimeAsync(50_000);
    expect(jest.getTimerCount()).toBe(1); // chain still alive despite the hung probe

    await jest.advanceTimersByTimeAsync(45_000); // ~95s total
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED); // never falsely promoted; self-healed
    expect(jest.getTimerCount()).toBe(0); // gave up at the 90s deadline
    expect(client.getState).toHaveBeenCalledTimes(1); // at-most-one-in-flight guard held
    // Self-heal: the broken auth is cleared and a disconnect surfaced so the lifecycle re-pairs (QR).
    expect(rmSpy).toHaveBeenCalledWith(expect.stringContaining('session-sess-1'), { recursive: true, force: true });
    expect(onDisconnected).toHaveBeenCalled();

    rmSpy.mockRestore();
  });

  it('fails terminally on a second stuck-auth cycle (no QR -> timeout -> clear loop)', async () => {
    const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
    const adapter = newAdapter();
    const onError = jest.fn();
    (adapter as unknown as { callbacks: { onError?: jest.Mock } }).callbacks = { onError };
    const recover = (adapter as unknown as { recoverFromStuckAuth: () => Promise<void> }).recoverFromStuckAuth.bind(
      adapter,
    );

    await recover(); // first stuck cycle: clears + disconnects
    expect(adapter.getStatus()).toBe(EngineStatus.DISCONNECTED);
    await recover(); // second: terminal failure, not another clear
    expect(adapter.getStatus()).toBe(EngineStatus.FAILED);
    expect(onError).toHaveBeenCalled();
    expect(rmSpy).toHaveBeenCalledTimes(1); // auth cleared only once
    rmSpy.mockRestore();
  });
});

describe('WhatsAppWebJsAdapter.resolveContactPhone (@lid -> phone, #263)', () => {
  // Stub a "ready" adapter with a fake client so we exercise the mapping without a real browser.
  const readyAdapter = (getContactLidAndPhone: jest.Mock): WhatsAppWebJsAdapter => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    (adapter as unknown as { status: EngineStatus }).status = EngineStatus.READY;
    (adapter as unknown as { client: unknown }).client = { getContactLidAndPhone };
    return adapter;
  };

  it('returns the phone JID stripped to MSISDN digits', async () => {
    const adapter = readyAdapter(jest.fn().mockResolvedValue([{ lid: '123@lid', pn: '628123456789@c.us' }]));
    await expect(adapter.resolveContactPhone('123@lid')).resolves.toBe('628123456789');
  });

  it('returns null when the engine has no mapping (empty result or empty pn)', async () => {
    await expect(readyAdapter(jest.fn().mockResolvedValue([])).resolveContactPhone('123@lid')).resolves.toBeNull();
    await expect(
      readyAdapter(jest.fn().mockResolvedValue([{ lid: '123@lid', pn: '' }])).resolveContactPhone('123@lid'),
    ).resolves.toBeNull();
  });

  it('is best-effort: a thrown engine error resolves to null, not a rejection', async () => {
    const adapter = readyAdapter(jest.fn().mockRejectedValue(new Error('Evaluation failed')));
    await expect(adapter.resolveContactPhone('123@lid')).resolves.toBeNull();
  });
});

describe('resolveWebVersionPin (#251 — opt-in WA-Web version pin)', () => {
  const orig = { v: process.env.WWEBJS_WEB_VERSION, p: process.env.WWEBJS_WEB_VERSION_REMOTE_PATH };
  afterEach(() => {
    if (orig.v === undefined) delete process.env.WWEBJS_WEB_VERSION;
    else process.env.WWEBJS_WEB_VERSION = orig.v;
    if (orig.p === undefined) delete process.env.WWEBJS_WEB_VERSION_REMOTE_PATH;
    else process.env.WWEBJS_WEB_VERSION_REMOTE_PATH = orig.p;
  });

  it('returns undefined (default auto-version) when unset / "latest" / "off" / "auto"', () => {
    delete process.env.WWEBJS_WEB_VERSION;
    expect(resolveWebVersionPin()).toBeUndefined();
    for (const value of ['latest', 'off', 'auto']) {
      process.env.WWEBJS_WEB_VERSION = value;
      expect(resolveWebVersionPin()).toBeUndefined();
    }
  });

  it('pins a remote webVersionCache from the version when set', () => {
    delete process.env.WWEBJS_WEB_VERSION_REMOTE_PATH;
    process.env.WWEBJS_WEB_VERSION = '2.3000.1041203030-alpha';
    expect(resolveWebVersionPin()).toEqual({
      webVersion: '2.3000.1041203030-alpha',
      webVersionCache: {
        type: 'remote',
        remotePath:
          'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1041203030-alpha.html',
      },
    });
  });

  it('honors a custom WWEBJS_WEB_VERSION_REMOTE_PATH template ({version} placeholder)', () => {
    process.env.WWEBJS_WEB_VERSION = '2.9999.0';
    process.env.WWEBJS_WEB_VERSION_REMOTE_PATH = 'https://cdn.example.com/wa/{version}.html';
    expect(resolveWebVersionPin()?.webVersionCache.remotePath).toBe('https://cdn.example.com/wa/2.9999.0.html');
  });
});

describe('resolveAuthTimeoutMs (#353 — configurable first-boot init wait)', () => {
  const orig = process.env.WWEBJS_AUTH_TIMEOUT_MS;
  afterEach(() => {
    if (orig === undefined) delete process.env.WWEBJS_AUTH_TIMEOUT_MS;
    else process.env.WWEBJS_AUTH_TIMEOUT_MS = orig;
  });

  it('returns undefined (wwebjs default) when unset', () => {
    delete process.env.WWEBJS_AUTH_TIMEOUT_MS;
    expect(resolveAuthTimeoutMs()).toBeUndefined();
  });

  it('parses a positive integer milliseconds value', () => {
    process.env.WWEBJS_AUTH_TIMEOUT_MS = '120000';
    expect(resolveAuthTimeoutMs()).toBe(120000);
  });

  it('ignores non-positive-integer values (falls back to the default)', () => {
    for (const bad of ['', '  ', '0', '-5', '1.5', 'abc', '60s']) {
      process.env.WWEBJS_AUTH_TIMEOUT_MS = bad;
      expect(resolveAuthTimeoutMs()).toBeUndefined();
    }
  });

  it('ignores all-digit values that are not finite safe integers (falls back to the default)', () => {
    // A huge digit string coerces to Infinity; MAX_SAFE_INTEGER + 1 is a finite but unsafe integer.
    // Both pass the /^\d+$/ shape check, so without a numeric guard they would reach whatsapp-web.js
    // as an effectively unbounded inject wait.
    for (const bad of ['9'.repeat(352), String(Number.MAX_SAFE_INTEGER + 1)]) {
      process.env.WWEBJS_AUTH_TIMEOUT_MS = bad;
      expect(resolveAuthTimeoutMs()).toBeUndefined();
    }
  });

  it('accepts large but safe integer millisecond values', () => {
    process.env.WWEBJS_AUTH_TIMEOUT_MS = '600000';
    expect(resolveAuthTimeoutMs()).toBe(600000);
  });
});
