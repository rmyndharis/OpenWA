import { MessageMedia } from 'whatsapp-web.js';
import {
  WhatsAppWebJsAdapter,
  extractLinkedParentJID,
  loadRemoteMedia,
  resolveWebVersionPin,
  wwebjsAckToDeliveryStatus,
} from './whatsapp-web-js.adapter';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { SsrfBlockedError } from '../../common/security/ssrf-guard';

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

describe('loadRemoteMedia — media-fetch SSRF guard + cap + timeout', () => {
  let fromUrlSpy: jest.SpyInstance;

  beforeEach(() => {
    fromUrlSpy = jest
      .spyOn(MessageMedia, 'fromUrl')
      .mockResolvedValue(new MessageMedia('image/png', 'ZmFrZQ==', 'x.png'));
  });

  afterEach(() => {
    fromUrlSpy.mockRestore();
    delete process.env.SSRF_ALLOWED_HOSTS;
  });

  it('blocks an internal/loopback URL BEFORE any fetch (no outbound socket)', async () => {
    await expect(loadRemoteMedia('http://127.0.0.1/x.png')).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(fromUrlSpy).not.toHaveBeenCalled();
  });

  it('blocks the cloud-metadata IP before fetching', async () => {
    await expect(loadRemoteMedia('http://169.254.169.254/latest/meta-data/x.png')).rejects.toBeInstanceOf(
      SsrfBlockedError,
    );
    expect(fromUrlSpy).not.toHaveBeenCalled();
  });

  it('fetches a public URL with a byte cap and an abort-timeout signal', async () => {
    await loadRemoteMedia('https://8.8.8.8/x.png');

    expect(fromUrlSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fromUrlSpy.mock.calls[0] as [
      string,
      { reqOptions: { size: number; signal: unknown; redirect: string } },
    ];
    expect(url).toBe('https://8.8.8.8/x.png');
    expect(typeof options.reqOptions.size).toBe('number');
    expect(options.reqOptions.size).toBeGreaterThan(0);
    expect(options.reqOptions.signal).toBeInstanceOf(AbortSignal);
    expect(options.reqOptions.redirect).toBe('error'); // never follow redirects
  });

  it('honors the SSRF_ALLOWED_HOSTS escape-hatch for trusted internal media stores', async () => {
    process.env.SSRF_ALLOWED_HOSTS = 'minio';
    await loadRemoteMedia('http://minio:9000/bucket/x.png');
    expect(fromUrlSpy).toHaveBeenCalledTimes(1);
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
  });

  it('carries HTTP 409 so NestJS returns "session not connected" (not 500) without a custom filter', () => {
    expect(new EngineNotReadyError().getStatus()).toBe(409);
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
