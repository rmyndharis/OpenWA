import {
  DEFAULT_FORWARDED_HOP_MAX_SKEW_MS,
  FORWARDED_HOP_HEADER,
  FORWARDED_HOP_SIG_HEADER,
  FORWARDED_HOP_TS_HEADER,
  signForwardedHop,
  verifyForwardedHop,
} from './inter-node-proxy-auth';

describe('inter-node-proxy-auth', () => {
  const SECRET = 'shared-inter-node-secret-32chars!';
  const NOW = 1_750_000_000_000;
  const NODE_ID = 'node-a';
  const METHOD = 'POST';
  const PATH = '/api/sessions/s1/messages/send-text?trace=1';

  it('signs and verifies a valid forwarded hop within the default skew window', () => {
    const headers = signForwardedHop({
      secret: SECRET,
      nodeId: NODE_ID,
      method: 'post',
      path: PATH,
      nowMs: NOW,
    });

    expect(headers[FORWARDED_HOP_HEADER]).toBe(NODE_ID);
    expect(headers[FORWARDED_HOP_TS_HEADER]).toBe(String(NOW));
    expect(headers[FORWARDED_HOP_SIG_HEADER]).toMatch(/^[0-9a-f]{64}$/);

    expect(
      verifyForwardedHop({
        secret: SECRET,
        headers,
        method: METHOD,
        path: PATH,
        nowMs: NOW + DEFAULT_FORWARDED_HOP_MAX_SKEW_MS,
      }),
    ).toBe(true);

    expect(
      verifyForwardedHop({
        secret: SECRET,
        headers,
        method: METHOD,
        path: PATH,
        nowMs: NOW - DEFAULT_FORWARDED_HOP_MAX_SKEW_MS,
      }),
    ).toBe(true);
  });

  it('fails closed when secret is unset, empty, or whitespace-only', () => {
    const headers = signForwardedHop({
      secret: SECRET,
      nodeId: NODE_ID,
      method: METHOD,
      path: PATH,
      nowMs: NOW,
    });

    for (const secret of [undefined, '', '   ']) {
      expect(verifyForwardedHop({ secret, headers, method: METHOD, path: PATH, nowMs: NOW })).toBe(false);
    }
  });

  it('rejects empty secret or nodeId when signing', () => {
    expect(() => signForwardedHop({ secret: '', nodeId: NODE_ID, method: METHOD, path: PATH, nowMs: NOW })).toThrow();
    expect(() =>
      signForwardedHop({ secret: '   ', nodeId: NODE_ID, method: METHOD, path: PATH, nowMs: NOW }),
    ).toThrow();
    expect(() => signForwardedHop({ secret: SECRET, nodeId: '', method: METHOD, path: PATH, nowMs: NOW })).toThrow();
  });

  it('rejects expired or future-skewed timestamps outside maxSkewMs', () => {
    const headers = signForwardedHop({
      secret: SECRET,
      nodeId: NODE_ID,
      method: METHOD,
      path: PATH,
      nowMs: NOW,
    });

    expect(
      verifyForwardedHop({
        secret: SECRET,
        headers,
        method: METHOD,
        path: PATH,
        nowMs: NOW + DEFAULT_FORWARDED_HOP_MAX_SKEW_MS + 1,
      }),
    ).toBe(false);

    expect(
      verifyForwardedHop({
        secret: SECRET,
        headers,
        method: METHOD,
        path: PATH,
        nowMs: NOW - DEFAULT_FORWARDED_HOP_MAX_SKEW_MS - 1,
      }),
    ).toBe(false);

    expect(
      verifyForwardedHop({
        secret: SECRET,
        headers,
        method: METHOD,
        path: PATH,
        nowMs: NOW + 5_001,
        maxSkewMs: 5_000,
      }),
    ).toBe(false);
  });

  it('rejects tampered method, path, nodeId, timestamp, signature, or mismatched secret', () => {
    const headers = signForwardedHop({
      secret: SECRET,
      nodeId: NODE_ID,
      method: METHOD,
      path: PATH,
      nowMs: NOW,
    });

    expect(verifyForwardedHop({ secret: SECRET, headers, method: 'GET', path: PATH, nowMs: NOW })).toBe(false);
    expect(
      verifyForwardedHop({
        secret: SECRET,
        headers,
        method: METHOD,
        path: '/api/sessions/s1/messages/send-text?trace=2',
        nowMs: NOW,
      }),
    ).toBe(false);
    expect(
      verifyForwardedHop({
        secret: SECRET,
        headers: { ...headers, [FORWARDED_HOP_HEADER]: 'node-b' },
        method: METHOD,
        path: PATH,
        nowMs: NOW,
      }),
    ).toBe(false);
    expect(
      verifyForwardedHop({
        secret: SECRET,
        headers: { ...headers, [FORWARDED_HOP_TS_HEADER]: String(NOW + 1) },
        method: METHOD,
        path: PATH,
        nowMs: NOW,
      }),
    ).toBe(false);
    expect(
      verifyForwardedHop({
        secret: 'different-shared-secret-32chars!',
        headers,
        method: METHOD,
        path: PATH,
        nowMs: NOW,
      }),
    ).toBe(false);

    const flipped =
      (headers[FORWARDED_HOP_SIG_HEADER][0] === '0' ? '1' : '0') + headers[FORWARDED_HOP_SIG_HEADER].slice(1);
    expect(
      verifyForwardedHop({
        secret: SECRET,
        headers: { ...headers, [FORWARDED_HOP_SIG_HEADER]: flipped },
        method: METHOD,
        path: PATH,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it('rejects malformed signatures, non-integer timestamps, missing headers, and multi-value headers', () => {
    const headers = signForwardedHop({
      secret: SECRET,
      nodeId: NODE_ID,
      method: METHOD,
      path: PATH,
      nowMs: NOW,
    });

    for (const badTs of ['', 'abc', '123.45', `${NOW}ms`, ` ${NOW} `, '-1']) {
      expect(
        verifyForwardedHop({
          secret: SECRET,
          headers: { ...headers, [FORWARDED_HOP_TS_HEADER]: badTs },
          method: METHOD,
          path: PATH,
          nowMs: NOW,
        }),
      ).toBe(false);
    }

    for (const badSig of ['', 'deadbeef', 'z'.repeat(64), headers[FORWARDED_HOP_SIG_HEADER] + '00']) {
      expect(
        verifyForwardedHop({
          secret: SECRET,
          headers: { ...headers, [FORWARDED_HOP_SIG_HEADER]: badSig },
          method: METHOD,
          path: PATH,
          nowMs: NOW,
        }),
      ).toBe(false);
    }

    expect(
      verifyForwardedHop({
        secret: SECRET,
        headers: { [FORWARDED_HOP_HEADER]: NODE_ID },
        method: METHOD,
        path: PATH,
        nowMs: NOW,
      }),
    ).toBe(false);

    expect(
      verifyForwardedHop({
        secret: SECRET,
        headers: {
          ...headers,
          [FORWARDED_HOP_SIG_HEADER]: [headers[FORWARDED_HOP_SIG_HEADER], headers[FORWARDED_HOP_SIG_HEADER]],
        },
        method: METHOD,
        path: PATH,
        nowMs: NOW,
      }),
    ).toBe(false);

    expect(
      verifyForwardedHop({
        secret: SECRET,
        headers: {
          ...headers,
          'X-OpenWA-Forwarded-Sig': headers[FORWARDED_HOP_SIG_HEADER],
        },
        method: METHOD,
        path: PATH,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it('matches header names case-insensitively when unambiguous', () => {
    const headers = signForwardedHop({
      secret: SECRET,
      nodeId: NODE_ID,
      method: METHOD,
      path: PATH,
      nowMs: NOW,
    });

    expect(
      verifyForwardedHop({
        secret: SECRET,
        headers: {
          'X-OpenWA-Forwarded': headers[FORWARDED_HOP_HEADER],
          'X-OpenWA-Forwarded-Ts': headers[FORWARDED_HOP_TS_HEADER],
          'X-OpenWA-Forwarded-Sig': headers[FORWARDED_HOP_SIG_HEADER],
        },
        method: METHOD,
        path: PATH,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it('rejects dot-delimited cross-method and cross-route replay collisions', () => {
    const captured = signForwardedHop({
      secret: SECRET,
      nodeId: 'node-a',
      method: 'GET',
      path: '/api/sessions/s1/status?q=.POST./api/auth/login',
      nowMs: NOW,
    });

    // Under dot-joined signing, splitting nodeId/method/path on '.' collides with the same HMAC.
    expect(
      verifyForwardedHop({
        secret: SECRET,
        headers: {
          [FORWARDED_HOP_HEADER]: 'node-a.GET./api/sessions/s1/status?q=',
          [FORWARDED_HOP_TS_HEADER]: captured[FORWARDED_HOP_TS_HEADER],
          [FORWARDED_HOP_SIG_HEADER]: captured[FORWARDED_HOP_SIG_HEADER],
        },
        method: 'POST',
        path: '/api/auth/login',
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it('rejects non-canonical uppercase hex signatures', () => {
    const headers = signForwardedHop({
      secret: SECRET,
      nodeId: NODE_ID,
      method: METHOD,
      path: PATH,
      nowMs: NOW,
    });

    expect(
      verifyForwardedHop({
        secret: SECRET,
        headers: {
          ...headers,
          [FORWARDED_HOP_SIG_HEADER]: headers[FORWARDED_HOP_SIG_HEADER].toUpperCase(),
        },
        method: METHOD,
        path: PATH,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it('rejects whitespace-only nodeId, negative timestamps, and control characters', () => {
    expect(() => signForwardedHop({ secret: SECRET, nodeId: NODE_ID, method: METHOD, path: PATH, nowMs: -1 })).toThrow(
      /timestamp/i,
    );

    for (const bad of ['node\na', 'node\ra', 'node\0a']) {
      expect(() => signForwardedHop({ secret: SECRET, nodeId: bad, method: METHOD, path: PATH, nowMs: NOW })).toThrow();
      expect(() =>
        signForwardedHop({ secret: SECRET, nodeId: NODE_ID, method: bad, path: PATH, nowMs: NOW }),
      ).toThrow();
      expect(() =>
        signForwardedHop({ secret: SECRET, nodeId: NODE_ID, method: METHOD, path: `/${bad}`, nowMs: NOW }),
      ).toThrow();
    }

    const valid = signForwardedHop({
      secret: SECRET,
      nodeId: NODE_ID,
      method: METHOD,
      path: PATH,
      nowMs: NOW,
    });

    expect(
      verifyForwardedHop({
        secret: SECRET,
        headers: { ...valid, [FORWARDED_HOP_HEADER]: '   ' },
        method: METHOD,
        path: PATH,
        nowMs: NOW,
      }),
    ).toBe(false);

    for (const bad of ['node\na', 'node\ra', 'node\0a']) {
      expect(
        verifyForwardedHop({
          secret: SECRET,
          headers: { ...valid, [FORWARDED_HOP_HEADER]: bad },
          method: METHOD,
          path: PATH,
          nowMs: NOW,
        }),
      ).toBe(false);
      expect(
        verifyForwardedHop({
          secret: SECRET,
          headers: valid,
          method: bad,
          path: PATH,
          nowMs: NOW,
        }),
      ).toBe(false);
      expect(
        verifyForwardedHop({
          secret: SECRET,
          headers: valid,
          method: METHOD,
          path: `/${bad}`,
          nowMs: NOW,
        }),
      ).toBe(false);
    }
  });
});
