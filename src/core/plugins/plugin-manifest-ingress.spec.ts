import {
  validateIngressManifest,
  SUPPORTED_SDK_MAJOR,
  warnUnauthenticatedIngressRoutes,
  warnUnsignedTimestampRoutes,
} from './plugin.interfaces';

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

describe('validateIngressManifest: signature.scheme "none" opt-in gate', () => {
  // A none-scheme route is an unauthenticated @Public endpoint that can trigger WhatsApp sends.
  // It must be rejected at load unless the operator explicitly opted in via ALLOW_UNSIGNED_INGRESS.
  const noneManifest = () =>
    ({
      id: 'p',
      name: 'p',
      version: '1.0.0',
      type: 'extension',
      main: 'index.js',
      sdkVersion: '1',
      permissions: ['webhook:ingress'],
      ingress: [{ route: 'r', mode: 'async', verify: 'core', maxBodyBytes: 1024, signature: { scheme: 'none' } }],
    }) as never;

  it('rejects a none-scheme route by default (no opt-in)', () => {
    expect(() => validateIngressManifest(noneManifest())).toThrow(/ALLOW_UNSIGNED_INGRESS/i);
    expect(() => validateIngressManifest(noneManifest())).toThrow(/unauthenticated/i);
  });

  it('rejects a none-scheme route when explicitly passed allowUnsignedIngress=false', () => {
    expect(() => validateIngressManifest(noneManifest(), false)).toThrow(/ALLOW_UNSIGNED_INGRESS/i);
  });

  it('accepts a none-scheme route when the operator opted in (allowUnsignedIngress=true)', () => {
    expect(() => validateIngressManifest(noneManifest(), true)).not.toThrow();
  });

  it('still accepts signed routes regardless of the opt-in flag', () => {
    expect(() => validateIngressManifest(baseManifest() as never, false)).not.toThrow();
    expect(() => validateIngressManifest(baseManifest() as never, true)).not.toThrow();
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

describe('warnUnsignedTimestampRoutes', () => {
  const hmacRoute = (signature: Record<string, unknown>) => ({
    id: 'p',
    name: 'p',
    version: '1.0.0',
    main: 'index.js',
    sdkVersion: '1',
    permissions: ['webhook:ingress'],
    ingress: [{ route: 'r', mode: 'async', verify: 'core', maxBodyBytes: 1024, signature }],
  });

  it('warns when a timestampHeader is declared but the contentTemplate does not sign it', () => {
    const logger = { warn: jest.fn() };
    warnUnsignedTimestampRoutes(
      hmacRoute({
        scheme: 'hmac-sha256',
        header: 'X-Sig',
        contentTemplate: '{rawBody}',
        timestampHeader: 'X-Ts',
      }) as never,
      logger,
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/UNSIGNED/i),
      expect.objectContaining({ pluginId: 'p', route: 'r', action: 'ingress_unsigned_timestamp' }),
    );
  });

  it('warns when the contentTemplate signs {timestamp} but no timestampHeader is declared', () => {
    const logger = { warn: jest.fn() };
    warnUnsignedTimestampRoutes(
      hmacRoute({ scheme: 'hmac-sha256', header: 'X-Sig', contentTemplate: '{timestamp}.{rawBody}' }) as never,
      logger,
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/no timestampHeader/i),
      expect.objectContaining({ pluginId: 'p', route: 'r', action: 'ingress_unsigned_timestamp' }),
    );
  });

  it('stays silent when the declared timestamp is signed (the bound form)', () => {
    const logger = { warn: jest.fn() };
    warnUnsignedTimestampRoutes(
      hmacRoute({
        scheme: 'hmac-sha256',
        header: 'X-Sig',
        contentTemplate: '{timestamp}.{rawBody}',
        timestampHeader: 'X-Ts',
        toleranceSec: 300,
      }) as never,
      logger,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stays silent when no timestamp is involved at all', () => {
    const logger = { warn: jest.fn() };
    warnUnsignedTimestampRoutes(
      hmacRoute({ scheme: 'hmac-sha256', header: 'X-Sig', contentTemplate: '{rawBody}' }) as never,
      logger,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('ignores non-hmac schemes (their wire format is not templatable)', () => {
    const logger = { warn: jest.fn() };
    warnUnsignedTimestampRoutes(hmacRoute({ scheme: 'standard-webhooks', dedupHeader: 'webhook-id' }) as never, logger);
    warnUnsignedTimestampRoutes(
      hmacRoute({ scheme: 'shared-secret', header: 'X-Token', timestampHeader: 'X-Ts' }) as never,
      logger,
    );
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
      // Default to a signed scheme so the response-contract / standard-webhooks suites below
      // exercise fields other than the scheme. The scheme:'none' opt-in gate has its own block.
      {
        route: 'r',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: 1024,
        signature: { scheme: 'hmac-sha256', header: 'X-Sig', contentTemplate: '{rawBody}', encoding: 'hex' },
        ...overrides,
      },
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
