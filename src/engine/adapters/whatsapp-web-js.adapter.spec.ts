import { MessageMedia } from 'whatsapp-web.js';
import { WhatsAppWebJsAdapter, extractLinkedParentJID, loadRemoteMedia } from './whatsapp-web-js.adapter';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { SsrfBlockedError } from '../../common/security/ssrf-guard';

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
  });

  it('carries HTTP 409 so NestJS returns "session not connected" (not 500) without a custom filter', () => {
    expect(new EngineNotReadyError().getStatus()).toBe(409);
  });
});
