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
  it.each(['true', 1, null, {}])('rejects a non-boolean body mismatch option (%p)', value => {
    const m = baseManifest();
    Object.assign(m.ingress[0], { dedupBodyMismatchAsNew: value });
    expect(() => validateIngressManifest(m as never)).toThrow(/dedupBodyMismatchAsNew/);
  });

  it.each([true, false])('accepts the body mismatch option %p', value => {
    const m = baseManifest();
    Object.assign(m.ingress[0], { dedupBodyMismatchAsNew: value });
    expect(() => validateIngressManifest(m as never)).not.toThrow();
  });

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

  // An unknown scheme used to load and then fail every delivery as a signature mismatch, with nothing
  // pointing at the manifest; a missing signature object failed the load with a bare TypeError.
  it.each(['hmac_sha256', 'HMAC-SHA256', 'standard-webhook', undefined])(
    'rejects signature.scheme %p, naming the route',
    scheme => {
      const m = baseManifest();
      (m.ingress[0].signature as { scheme?: string }).scheme = scheme;
      expect(() => validateIngressManifest(m as never)).toThrow(/route 'chatwoot' signature\.scheme must be one of/);
    },
  );

  it('rejects a route with no signature object as a manifest error', () => {
    const m = baseManifest();
    delete (m.ingress[0] as { signature?: unknown }).signature;
    expect(() => validateIngressManifest(m as never)).toThrow(/route 'chatwoot' signature\.scheme must be one of/);
  });

  it('rejects an hmac-sha256 signature.encoding other than hex or base64', () => {
    const m = baseManifest();
    (m.ingress[0].signature as { encoding?: string }).encoding = 'b64';
    expect(() => validateIngressManifest(m as never)).toThrow(/route 'chatwoot' signature\.encoding must be/);
  });

  // Only hmac-sha256 reads `encoding`, so a stray value on another scheme must not fail the plugin's load.
  it.each(['shared-secret', 'standard-webhooks'])('ignores signature.encoding on a %s route', scheme => {
    const m = baseManifest();
    m.ingress[0].signature.scheme = scheme;
    (m.ingress[0].signature as { encoding?: string }).encoding = 'b64';
    expect(() => validateIngressManifest(m as never)).not.toThrow();
  });

  it('accepts every declared scheme', () => {
    for (const scheme of ['hmac-sha256', 'shared-secret', 'standard-webhooks', 'none']) {
      const m = baseManifest();
      m.ingress[0].signature.scheme = scheme;
      expect(() => validateIngressManifest(m as never, true)).not.toThrow();
    }
  });

  it('rejects a duplicate route within one manifest', () => {
    const m = baseManifest();
    m.ingress.push({ ...m.ingress[0] });
    expect(() => validateIngressManifest(m as never)).toThrow(/duplicate/i);
  });
});

describe('validateIngressManifest: a declaration the load-time warnings cannot read', () => {
  // warnUnauthenticatedIngressRoutes iterates `ingress` and warnUnsignedTimestampRoutes calls `includes` on an hmac-sha256
  // template, so the loader refused some of these by throwing from a warning, with an engine text and no field named, and an
  // update had already stopped the running plugin by then. The rest loaded and then failed, an empty string when the plugin
  // was enabled and an array template at every delivery. All are refused up front, naming the field.
  const withIngress = (ingress: unknown) => ({ ...baseManifest(), ingress }) as never;
  const withTemplate = (contentTemplate: unknown, scheme = 'hmac-sha256') =>
    manifestWithRoute({ signature: { scheme, header: 'X-Sig', contentTemplate } });

  it.each([
    ['one route instead of a list', baseManifest().ingress[0]],
    ['an empty object', {}],
    ['true', true],
    ['false', false],
    ['zero', 0],
    ['a positive number', 7],
    ['a negative number', -1],
    ['an empty string', ''],
    ['a string', 'chatwoot'],
  ])('refuses ingress written as %s, naming the field', (_label, ingress) => {
    expect(() => validateIngressManifest(withIngress(ingress))).toThrow(
      'Plugin chatwoot: ingress must be a list of routes',
    );
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['an empty list', []],
  ])('still accepts ingress written as %s', (_label, ingress) => {
    expect(() => validateIngressManifest(withIngress(ingress))).not.toThrow();
  });

  it.each([5, 0, true, false, {}, { template: '{rawBody}' }, ['{rawBody}'], []])(
    'refuses an hmac-sha256 contentTemplate of %p, naming the route and the field',
    contentTemplate => {
      expect(() => validateIngressManifest(withTemplate(contentTemplate))).toThrow(
        "Plugin p: route 'r' signature.contentTemplate must be a string",
      );
    },
  );

  it.each([
    ['a template with tokens', '{timestamp}.{rawBody}'],
    ['an empty template', ''],
    ['an absent template', undefined],
    ['a null template', null],
  ])('accepts an hmac-sha256 route with %s', (_label, contentTemplate) => {
    expect(() => validateIngressManifest(withTemplate(contentTemplate))).not.toThrow();
  });

  it.each(['shared-secret', 'standard-webhooks'])('does not read contentTemplate on a %s route', scheme => {
    expect(() => validateIngressManifest(withTemplate(5, scheme))).not.toThrow();
  });

  // The delivery path lower-cases these names to read the request headers, so a non-string one fails every delivery with
  // a TypeError: for conversationId.header only after the delivery was stored, which leaves a row no sweep can replay.
  it.each([
    ['signature.header', { signature: { scheme: 'hmac-sha256', header: 5 } }],
    ['signature.header', { signature: { scheme: 'shared-secret', header: 5 } }],
    ['signature.timestampHeader', { signature: { scheme: 'hmac-sha256', header: 'X-Sig', timestampHeader: 5 } }],
    ['signature.dedupHeader', { signature: { scheme: 'hmac-sha256', header: 'X-Sig', dedupHeader: 5 } }],
    ['dedupHeader', { dedupHeader: ['X-Delivery'] }],
    ['conversationId.header', { conversationId: { header: 5 } }],
  ])('refuses a route whose %s is not a string, naming the route and the field', (field, overrides) => {
    const base = { signature: { scheme: 'hmac-sha256', header: 'X-Sig' } };
    expect(() => validateIngressManifest(manifestWithRoute({ ...base, ...overrides }))).toThrow(
      `Plugin p: route 'r' ${field} must be a string`,
    );
  });

  it('accepts string and absent header names, and does not hold a scheme to the headers it never reads', () => {
    const named = { signature: { scheme: 'hmac-sha256', header: 'X-Sig', timestampHeader: 'X-Ts', dedupHeader: null } };
    for (const overrides of [
      named,
      { ...named, dedupHeader: 'X-Delivery', conversationId: { header: 'X-Conversation' } },
      { signature: { scheme: 'standard-webhooks', header: 5, timestampHeader: 5, dedupHeader: 'webhook-id' } },
      { signature: { scheme: 'none', header: 5 } },
    ]) {
      expect(() => validateIngressManifest(manifestWithRoute(overrides), true)).not.toThrow();
    }
  });

  // Seeded, so a failure names the same declaration on every run. Whatever the validator accepts, the loader's warnings
  // must be able to read.
  it('accepts no declaration the load-time warnings then throw on', () => {
    let seed = 1;
    const next = (): number => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const junk: unknown[] = [undefined, null, 0, 7, -1, true, false, '', 'x', [], {}, [1], { a: 1 }];
    const pick = <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)];
    const warn = { warn: () => undefined };
    let accepted = 0;
    for (let i = 0; i < 4000; i++) {
      const signature: Record<string, unknown> = {
        scheme: pick(['hmac-sha256', 'shared-secret', 'standard-webhooks']),
      };
      for (const key of ['header', 'timestampHeader', 'contentTemplate', 'dedupHeader']) {
        if (next() < 0.4) signature[key] = pick(junk);
      }
      const route: Record<string, unknown> = { route: 'hook', signature: next() < 0.9 ? signature : pick(junk) };
      const ingress = pick([[route], [route], route, pick(junk), [route, null]]);
      const manifest = JSON.parse(
        JSON.stringify({ id: 'p', permissions: ['webhook:ingress'], ingress: ingress ?? null }),
      ) as never;
      try {
        validateIngressManifest(manifest);
      } catch {
        continue;
      }
      accepted++;
      expect(() => warnUnauthenticatedIngressRoutes(manifest, warn)).not.toThrow();
      expect(() => warnUnsignedTimestampRoutes(manifest, warn)).not.toThrow();
    }
    expect(accepted).toBeGreaterThan(500); // a vacuous loop would pass too
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
