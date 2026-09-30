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

  it('the ingress refusal names the array and the manifest file to fix', () => {
    // Load-time twin of the capability denial: an author who sees only "is missing the
    // 'webhook:ingress' permission" is told the fault, not where to declare it.
    const m = baseManifest();
    m.permissions = ['conversation:send'];
    const error = (() => {
      try {
        validateIngressManifest(m as never);
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toContain('webhook:ingress');
    expect(error?.message).toContain('permissions');
    expect(error?.message).toContain('manifest.json');
  });

  it('rejects toleranceSec <= 0 (replay guard would be a no-op)', () => {
    const m = baseManifest();
    m.ingress[0].signature.toleranceSec = 0;
    expect(() => validateIngressManifest(m as never)).toThrow(/toleranceSec/);
  });

  it('rejects a toleranceSec that is not a finite number, which would disable the replay window', () => {
    for (const tol of ['5m', '300s', '', {}, true, [], null, JSON.parse('1e999') as number]) {
      for (const scheme of ['hmac-sha256', 'standard-webhooks']) {
        const m = baseManifest();
        m.ingress[0].signature.scheme = scheme;
        (m.ingress[0].signature as { toleranceSec?: unknown }).toleranceSec = tol;
        expect(() => validateIngressManifest(m as never)).toThrow(/toleranceSec/);
      }
    }
  });

  it('still loads a numeric toleranceSec, quoted or not', () => {
    for (const tol of [300, '300']) {
      const m = baseManifest();
      (m.ingress[0].signature as { toleranceSec?: unknown }).toleranceSec = tol;
      expect(() => validateIngressManifest(m as never)).not.toThrow();
    }
  });

  it('rejects a route that is not a single URL path segment', () => {
    for (const route of ['events/message', '/hook', 'a\\b', 'a?b', 'a#b', 'a%2Fb', 'a\nb', '.', '..']) {
      const m = baseManifest();
      m.ingress[0].route = route;
      expect(() => validateIngressManifest(m as never)).toThrow(/single URL path segment/);
    }
    // A space or a non-ASCII letter is percent-encoded by the client and decoded before the match.
    for (const route of ['send-sms', 'chatwoot', 'v1.events', 'a_b~c', 'a b', 'café', '...']) {
      const m = baseManifest();
      m.ingress[0].route = route;
      expect(() => validateIngressManifest(m as never)).not.toThrow();
    }
  });

  it('rejects a route holding a lone UTF-16 surrogate (no URL can encode or decode to it)', () => {
    for (const route of ['\ud800', 'a\udc00b', 'x\ud83d']) {
      const m = baseManifest();
      m.ingress[0].route = route;
      expect(() => validateIngressManifest(m as never)).toThrow(/single URL path segment/);
    }
    // A well-formed surrogate pair is an ordinary astral character.
    const m = baseManifest();
    m.ingress[0].route = 'hook-\ud83d\ude80';
    expect(() => validateIngressManifest(m as never)).not.toThrow();
  });

  it('rejects a dedupOn value other than header or body', () => {
    const m = baseManifest();
    (m.ingress[0] as { dedupOn?: string }).dedupOn = 'bdy';
    expect(() => validateIngressManifest(m as never)).toThrow(/dedupOn/);
  });

  it('accepts dedupOn: body', () => {
    const m = baseManifest();
    (m.ingress[0] as { dedupOn?: string }).dedupOn = 'body';
    expect(() => validateIngressManifest(m as never)).not.toThrow();
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

  const withDedupOnBody = (manifest: ReturnType<typeof hmacRoute>) => ({
    ...manifest,
    ingress: manifest.ingress.map(route => ({ ...route, dedupOn: 'body' })),
  });

  it('warns once when an hmac route binds no timestamp and dedups on its header', () => {
    const logger = { warn: jest.fn() };
    warnUnsignedTimestampRoutes(
      hmacRoute({ scheme: 'hmac-sha256', header: 'X-Sig', contentTemplate: '{rawBody}' }) as never,
      logger,
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/dedupOn: 'body'/),
      expect.objectContaining({ pluginId: 'p', route: 'r', action: 'ingress_replayable_route' }),
    );
  });

  it('stays silent for an hmac route without a timestamp that dedups on the body', () => {
    const logger = { warn: jest.fn() };
    warnUnsignedTimestampRoutes(
      withDedupOnBody(hmacRoute({ scheme: 'hmac-sha256', header: 'X-Sig', contentTemplate: '{rawBody}' })) as never,
      logger,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns for a shared-secret route unless it dedups on the body', () => {
    const logger = { warn: jest.fn() };
    const route = hmacRoute({ scheme: 'shared-secret', header: 'X-Token', timestampHeader: 'X-Ts' });
    warnUnsignedTimestampRoutes(route as never, logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/shared-secret/),
      expect.objectContaining({ pluginId: 'p', route: 'r', action: 'ingress_replayable_route' }),
    );

    logger.warn.mockClear();
    warnUnsignedTimestampRoutes(withDedupOnBody(route) as never, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('ignores standard-webhooks (its dedup id and timestamp are signed)', () => {
    const logger = { warn: jest.fn() };
    warnUnsignedTimestampRoutes(hmacRoute({ scheme: 'standard-webhooks', dedupHeader: 'webhook-id' }) as never, logger);
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

  it('rejects a 1xx ack.status, which Node sends with no final response after it', () => {
    for (const status of [100, 103, 199]) {
      expect(() => validateIngressManifest(manifestWithRoute({ response: { ack: { status } } }))).toThrow(
        /ack\.status/,
      );
    }
    expect(() => validateIngressManifest(manifestWithRoute({ response: { ack: { status: 200 } } }))).not.toThrow();
  });

  it('rejects an ack header value Node cannot write, and keeps Latin-1 and HTAB', () => {
    for (const value of ['ok \u2713', 'a\u0000b', 'a\u007fb', 'a\u001bb']) {
      expect(() =>
        validateIngressManifest(manifestWithRoute({ response: { ack: { headers: { 'x-note': value } } } })),
      ).toThrow(/invalid characters/);
    }
    for (const value of ['caf\u00e9', 'a\tb']) {
      expect(() =>
        validateIngressManifest(manifestWithRoute({ response: { ack: { headers: { 'x-note': value } } } })),
      ).not.toThrow();
    }
  });

  it('rejects a non-string ack body', () => {
    // A manifest is third-party JSON. Left unchecked, a number or object here reached the renderer,
    // which drops anything that is not a string, so the route answered every delivery with an EMPTY
    // ack while the manifest read as if it declared one.
    expect(() =>
      validateIngressManifest(manifestWithRoute({ response: { ack: { body: 42 as unknown as string } } })),
    ).toThrow(/ack\.body/);
  });

  it('rejects a non-string ack header value', () => {
    // Same silent drop, and the character guard does not catch it: RegExp.test coerces its
    // argument, so a number passes the injection check and is then filtered out at render time.
    expect(() =>
      validateIngressManifest(
        manifestWithRoute({ response: { ack: { headers: { 'x-retry': 5 as unknown as string } } } }),
      ),
    ).toThrow(/'x-retry'/);
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
