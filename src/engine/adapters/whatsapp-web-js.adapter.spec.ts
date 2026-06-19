import { MessageMedia } from 'whatsapp-web.js';
import {
  WhatsAppWebJsAdapter,
  extractLinkedParentJID,
  isSupportedProxyUrl,
  loadRemoteMedia,
  resolveWebVersionPin,
  wwebjsAckToDeliveryStatus,
} from './whatsapp-web-js.adapter';
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

  it('returns undefined (default auto-version) when unset / "latest" / "off"', () => {
    delete process.env.WWEBJS_WEB_VERSION;
    expect(resolveWebVersionPin()).toBeUndefined();
    process.env.WWEBJS_WEB_VERSION = 'latest';
    expect(resolveWebVersionPin()).toBeUndefined();
    process.env.WWEBJS_WEB_VERSION = 'off';
    expect(resolveWebVersionPin()).toBeUndefined();
  });

  it('pins a remote webVersionCache from the version when set', () => {
    delete process.env.WWEBJS_WEB_VERSION_REMOTE_PATH;
    process.env.WWEBJS_WEB_VERSION = '2.3000.1023204257';
    expect(resolveWebVersionPin()).toEqual({
      webVersion: '2.3000.1023204257',
      webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1023204257.html',
      },
    });
  });

  it('honors a custom WWEBJS_WEB_VERSION_REMOTE_PATH template ({version} placeholder)', () => {
    process.env.WWEBJS_WEB_VERSION = '2.9999.0';
    process.env.WWEBJS_WEB_VERSION_REMOTE_PATH = 'https://cdn.example.com/wa/{version}.html';
    expect(resolveWebVersionPin()?.webVersionCache.remotePath).toBe('https://cdn.example.com/wa/2.9999.0.html');
  });
});
