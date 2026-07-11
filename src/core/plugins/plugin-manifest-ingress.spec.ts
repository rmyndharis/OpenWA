import { validateIngressManifest, SUPPORTED_SDK_MAJOR, warnUnauthenticatedIngressRoutes } from './plugin.interfaces';

const baseManifest = () => ({
  id: 'chatwoot',
  name: 'Chatwoot',
  version: '1.0.0',
  main: 'index.js',
  sdkVersion: '1',
  permissions: ['webhook:ingress', 'conversation:send', 'net:fetch'],
  ingress: [
    {
      route: 'chatwoot',
      mode: 'async',
      verify: 'core',
      maxBodyBytes: 262144,
      signature: {
        scheme: 'hmac-sha256',
        header: 'X-Chatwoot-Signature',
        contentTemplate: '{rawBody}',
        encoding: 'hex',
        toleranceSec: 300,
        dedupHeader: 'X-Chatwoot-Delivery',
      },
    },
  ],
});

describe('validateIngressManifest', () => {
  it('accepts a well-formed sdkVersion 1 ingress manifest', () => {
    expect(() => validateIngressManifest(baseManifest() as never)).not.toThrow();
  });

  it('refuses a plugin whose declared SDK major differs from the host major', () => {
    const m = baseManifest();
    m.sdkVersion = '2';
    expect(() => validateIngressManifest(m as never)).toThrow(/sdk.*major/i);
    expect(SUPPORTED_SDK_MAJOR).toBe(1);
  });

  it('rejects an ingress route declared without the webhook:ingress permission', () => {
    const m = baseManifest();
    m.permissions = ['conversation:send'];
    expect(() => validateIngressManifest(m as never)).toThrow(/webhook:ingress/);
  });

  it('rejects toleranceSec <= 0 (replay guard would be a no-op)', () => {
    const m = baseManifest();
    m.ingress[0].signature.toleranceSec = 0;
    expect(() => validateIngressManifest(m as never)).toThrow(/toleranceSec/);
  });

  it('rejects a duplicate route within one manifest', () => {
    const m = baseManifest();
    m.ingress.push({ ...m.ingress[0] });
    expect(() => validateIngressManifest(m as never)).toThrow(/duplicate/i);
  });
});

describe('warnUnauthenticatedIngressRoutes', () => {
  it('warns once per scheme:none route, naming the plugin and route', () => {
    const logger = { warn: jest.fn() };
    const m = baseManifest();
    (m.ingress[0].signature as { scheme: string }).scheme = 'none';
    warnUnauthenticatedIngressRoutes(m as never, logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/UNAUTHENTICATED/i),
      expect.objectContaining({ pluginId: 'chatwoot', route: 'chatwoot', action: 'ingress_unauthenticated_route' }),
    );
  });

  it('does not warn for an authenticated scheme', () => {
    const logger = { warn: jest.fn() };
    warnUnauthenticatedIngressRoutes(baseManifest() as never, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('is a no-op for a manifest with no ingress routes', () => {
    const logger = { warn: jest.fn() };
    warnUnauthenticatedIngressRoutes({ id: 'x', name: 'X', version: '1.0.0', main: 'i.js' } as never, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

function manifestWithRoute(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p',
    name: 'p',
    version: '1.0.0',
    type: 'extension',
    main: 'index.js',
    sdkVersion: '1',
    permissions: ['webhook:ingress'],
    ingress: [
      { route: 'r', mode: 'async', verify: 'core', maxBodyBytes: 1024, signature: { scheme: 'none' }, ...overrides },
    ],
  } as never;
}

describe('validateIngressManifest: response contract', () => {
  it('accepts a route with no response (default fast-ack)', () => {
    expect(() => validateIngressManifest(manifestWithRoute())).not.toThrow();
  });

  it('accepts a valid response contract', () => {
    expect(() =>
      validateIngressManifest(
        manifestWithRoute({
          response: {
            preflight: [{ type: 'session-alive' }],
            ack: { status: 200, body: '{"ok":true}', headers: { 'content-type': 'application/json' } },
          },
        }),
      ),
    ).not.toThrow();
  });

  it('rejects an out-of-range ack.status', () => {
    expect(() => validateIngressManifest(manifestWithRoute({ response: { ack: { status: 99 } } }))).toThrow(
      /ack\.status/,
    );
    expect(() => validateIngressManifest(manifestWithRoute({ response: { ack: { status: 600 } } }))).toThrow(
      /ack\.status/,
    );
  });

  it('rejects a CR/LF in an ack header value (injection guard)', () => {
    expect(() =>
      validateIngressManifest(
        manifestWithRoute({ response: { ack: { headers: { 'content-type': 'text/plain\r\nX-Injected: yes' } } } }),
      ),
    ).toThrow(/invalid characters/);
  });

  it('rejects a non-token ack header name', () => {
    expect(() =>
      validateIngressManifest(manifestWithRoute({ response: { ack: { headers: { 'bad header': 'x' } } } })),
    ).toThrow(/'bad header'/);
  });
});

describe('validateIngressManifest: standard-webhooks scheme', () => {
  it('loads a standard-webhooks route without header/contentTemplate', () => {
    expect(() =>
      validateIngressManifest(
        manifestWithRoute({ signature: { scheme: 'standard-webhooks', dedupHeader: 'webhook-id' } }),
      ),
    ).not.toThrow();
  });

  it('rejects a standard-webhooks route with a non-positive toleranceSec', () => {
    expect(() =>
      validateIngressManifest(
        manifestWithRoute({ signature: { scheme: 'standard-webhooks', dedupHeader: 'webhook-id', toleranceSec: 0 } }),
      ),
    ).toThrow(/toleranceSec/);
  });
});
