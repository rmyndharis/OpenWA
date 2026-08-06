import http from 'http';
import { AddressInfo } from 'net';
import { of, lastValueFrom } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { SessionProxyInterceptor, FORWARDED_HEADER, forwardTarget } from './session-proxy.interceptor';
import type { Session } from './entities/session.entity';

/**
 * The forwarding decision IS the security surface: forwarding when the session is local answers a
 * request twice; not forwarding when the owner is live strands the caller with a conflict; ever
 * forwarding a forwarded request is a loop between two nodes that both think the other owns the
 * session. The matrix below pins every arm, and the mechanics tests run against a real HTTP server
 * because header pass-through and body re-serialisation are exactly the parts a stubbed fetch
 * would vacuously approve.
 */
describe('SessionProxyInterceptor', () => {
  // A real UUID: the interceptor refuses to route malformed ids (they cannot name a session, and a
  // raw uuid-column lookup on Postgres would 500 before the route pipe could answer 400).
  const SID = '3f8d1c2a-4b6e-4f0d-9a7c-2e5b8d1f6a3c';

  const row = (over: Partial<Session> = {}): Partial<Session> => ({
    id: SID,
    nodeId: 'peer-node',
    nodeUrl: 'http://127.0.0.1:9',
    leaseExpiresAt: new Date(Date.now() + 60_000),
    ...over,
  });

  type Req = {
    headers: Record<string, string>;
    params: Record<string, string>;
    method: string;
    originalUrl: string;
    body?: unknown;
    socket?: { remoteAddress?: string };
  };

  const request = (over: Partial<Req> = {}): Req => ({
    headers: { 'x-api-key': 'k-123', 'content-type': 'application/json' },
    params: { sessionId: SID },
    method: 'GET',
    originalUrl: `/api/sessions/${SID}/messages?limit=5`,
    ...over,
  });

  const makeResponse = () => {
    const res = {
      status: jest.fn(),
      setHeader: jest.fn(),
      send: jest.fn(),
      end: jest.fn(),
      json: jest.fn(),
    };
    res.status.mockReturnValue(res);
    return res;
  };

  const build = (opts: {
    myUrl?: string;
    row?: Partial<Session> | null;
    sessionScoped?: boolean;
    req?: Req;
    timeoutMs?: number;
  }) => {
    const req = opts.req ?? request();
    const res = makeResponse();
    const findOne = jest.fn().mockResolvedValue(opts.row === undefined ? row() : opts.row);
    const interceptor = new SessionProxyInterceptor(
      { getAllAndOverride: jest.fn().mockReturnValue(opts.sessionScoped ?? false) } as never,
      { findOne } as never,
      { nodeId: 'me', nodeUrl: opts.myUrl ?? 'http://127.0.0.1:2785' } as never,
      { get: jest.fn().mockReturnValue(opts.timeoutMs ?? 5000) } as never,
    );
    const context = {
      getType: () => 'http',
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;
    const handle = jest.fn(() => of('handled-locally'));
    const next: CallHandler = { handle };
    return { interceptor, context, next, handle, res, findOne, req };
  };

  const ranLocally = async (result: Awaited<ReturnType<SessionProxyInterceptor['intercept']>>): Promise<boolean> =>
    lastValueFrom(result, { defaultValue: 'EMPTY' }).then(v => v === 'handled-locally');

  describe('the forwarding decision', () => {
    it('is inert without NODE_URL on this node — no lookup, handled locally', async () => {
      const { interceptor, context, next, findOne } = build({ myUrl: '' });
      expect(await ranLocally(await interceptor.intercept(context, next))).toBe(true);
      expect(findOne).not.toHaveBeenCalled();
    });

    // The hop marker is client-settable: honoring it blindly would let any authenticated caller
    // force local execution on a non-owner (a stop() here writes DISCONNECTED while the owner's
    // engine stays up). The refusal doubles as the loop guard — a marked request is never
    // forwarded again, it is answered with a retryable conflict instead.
    it('refuses (409) a request already marked forwarded that lands on a live non-owner', async () => {
      const req = request({ headers: { [FORWARDED_HEADER]: 'peer-node', 'x-api-key': 'k' } });
      const { interceptor, context, next, handle } = build({ req });
      await expect(interceptor.intercept(context, next)).rejects.toMatchObject({ status: 409 });
      expect(handle).not.toHaveBeenCalled();
    });

    it('executes a forwarded request locally when this node hosts (or may host) the session', async () => {
      const req = request({ headers: { [FORWARDED_HEADER]: 'peer-node', 'x-api-key': 'k' } });
      const owned = build({ req, row: row({ nodeId: 'me' }) });
      expect(await ranLocally(await owned.interceptor.intercept(owned.context, owned.next))).toBe(true);

      const unowned = build({
        req: request({ headers: { [FORWARDED_HEADER]: 'peer-node', 'x-api-key': 'k' } }),
        row: row({ nodeId: null }),
      });
      expect(await ranLocally(await unowned.interceptor.intercept(unowned.context, unowned.next))).toBe(true);
    });

    it('skips routing for a malformed id — the route pipe answers 400, not a raw uuid-column query', async () => {
      const req = request({ params: { sessionId: 'not-a-uuid' } });
      const { interceptor, context, next, findOne } = build({ req });
      expect(await ranLocally(await interceptor.intercept(context, next))).toBe(true);
      expect(findOne).not.toHaveBeenCalled();
    });

    it('ignores routes without a session dimension', async () => {
      const { interceptor, context, next, findOne } = build({ req: request({ params: {} }) });
      expect(await ranLocally(await interceptor.intercept(context, next))).toBe(true);
      expect(findOne).not.toHaveBeenCalled();
    });

    it('reads :id only on @SessionScoped controllers', async () => {
      const req = request({ params: { id: SID } });
      const scoped = build({ req, sessionScoped: true, row: row({ nodeId: 'me' }) });
      expect(await ranLocally(await scoped.interceptor.intercept(scoped.context, scoped.next))).toBe(true);
      expect(scoped.findOne).toHaveBeenCalled();

      const unscoped = build({ req: request({ params: { id: SID } }), sessionScoped: false });
      expect(await ranLocally(await unscoped.interceptor.intercept(unscoped.context, unscoped.next))).toBe(true);
      expect(unscoped.findOne).not.toHaveBeenCalled();
    });

    it.each([
      ['unknown session', null],
      ['unowned session', row({ nodeId: null })],
      ['owned by this node', row({ nodeId: 'me' })],
      ['owner lease lapsed (takeover semantics)', row({ leaseExpiresAt: new Date(Date.now() - 1000) })],
      ['owner without a nodeUrl', row({ nodeUrl: null })],
    ])('handles locally when the owner is not a live routable peer: %s', async (_label, ownerRow) => {
      const { interceptor, context, next } = build({ row: ownerRow });
      expect(await ranLocally(await interceptor.intercept(context, next))).toBe(true);
    });
  });

  describe('the forward itself (real upstream server)', () => {
    let server: http.Server;
    let serverUrl: string;
    let seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }>;

    beforeAll(async () => {
      seen = [];
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
          seen.push({ method: req.method, url: req.url, headers: req.headers, body });
          res.writeHead(201, { 'content-type': 'application/json', 'x-hop-by-hop': 'must-not-relay' });
          res.end(JSON.stringify({ servedBy: 'the-owner' }));
        });
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
    });

    beforeEach(() => {
      seen = [];
    });

    it('relays method, path, query, body and auth to the owner, and the owner’s answer back', async () => {
      const req = request({
        method: 'POST',
        originalUrl: `/api/sessions/${SID}/messages/send-text?trace=1`,
        body: { chatId: '628@c.us', text: 'halo' },
      });
      const { interceptor, context, next, handle, res } = build({ req, row: row({ nodeUrl: serverUrl }) });

      const result = await interceptor.intercept(context, next);
      // The response was written directly, so nothing may flow to the route handler. The observable
      // still EMITS (undefined) rather than completing empty: Nest resolves it with lastValueFrom,
      // which rejects on an empty one and logged an ERROR for every successful forward.
      expect(await lastValueFrom(result)).toBeUndefined();
      expect(handle).not.toHaveBeenCalled();

      expect(seen).toHaveLength(1);
      expect(seen[0].method).toBe('POST');
      expect(seen[0].url).toBe(`/api/sessions/${SID}/messages/send-text?trace=1`);
      expect(seen[0].headers['x-api-key']).toBe('k-123');
      expect(seen[0].headers[FORWARDED_HEADER]).toBe('me');
      expect(JSON.parse(seen[0].body)).toEqual({ chatId: '628@c.us', text: 'halo' });

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.setHeader).toHaveBeenCalledWith('content-type', 'application/json');
      expect(res.setHeader).toHaveBeenCalledWith('x-openwa-served-by', 'peer-node');
      expect(res.setHeader).not.toHaveBeenCalledWith('x-hop-by-hop', expect.anything());
      const sentBody = (res.send.mock.calls[0] as [Buffer])[0];
      expect(JSON.parse(String(sentBody))).toEqual({ servedBy: 'the-owner' });
    });

    it('a GET carries no body', async () => {
      const { interceptor, context, next } = build({ req: request(), row: row({ nodeUrl: serverUrl }) });

      await interceptor.intercept(context, next);

      expect(seen[0].method).toBe('GET');
      expect(seen[0].body).toBe('');
    });

    // Without the chain the owner sees every forwarded call as coming from THIS node — an
    // allowedIps-restricted key 401s on every forwarded request, and the per-IP throttler pools
    // all forwarded traffic into one bucket.
    // End-to-end proof of the absolute-form vector: a raw HTTP request whose target names another
    // origin must still be forwarded to the OWNER, never to the origin the caller chose — otherwise
    // the caller receives the attacker origin's response with their own API key already spent on it.
    it('forwards to the owner even when the caller supplies an absolute-form request target', async () => {
      const attacker = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ stolenBy: 'attacker' }));
      });
      await new Promise<void>(resolve => attacker.listen(0, '127.0.0.1', resolve));
      const attackerPort = (attacker.address() as AddressInfo).port;

      try {
        const req = request({ originalUrl: `http://127.0.0.1:${attackerPort}/api/sessions/${SID}` });
        const { interceptor, context, next, res } = build({ req, row: row({ nodeUrl: serverUrl }) });

        await interceptor.intercept(context, next);

        // The owner answered, not the attacker's origin.
        expect(seen).toHaveLength(1);
        expect(seen[0].url).toBe(`/api/sessions/${SID}`);
        const sentBody = (res.send.mock.calls[0] as [Buffer])[0];
        expect(JSON.parse(String(sentBody))).toEqual({ servedBy: 'the-owner' });
      } finally {
        await new Promise<void>(resolve => attacker.close(() => resolve()));
      }
    });

    it('appends the observed peer to x-forwarded-for so the owner can resolve the real client', async () => {
      const direct = build({
        req: request({ socket: { remoteAddress: '::ffff:203.0.113.7' } }),
        row: row({ nodeUrl: serverUrl }),
      });
      await direct.interceptor.intercept(direct.context, direct.next);
      expect(seen[0].headers['x-forwarded-for']).toBe('203.0.113.7');

      const chained = build({
        req: request({
          headers: { 'x-api-key': 'k-123', 'x-forwarded-for': '198.51.100.9' },
          socket: { remoteAddress: '10.0.0.4' },
        }),
        row: row({ nodeUrl: serverUrl }),
      });
      await chained.interceptor.intercept(chained.context, chained.next);
      expect(seen[1].headers['x-forwarded-for']).toBe('198.51.100.9, 10.0.0.4');
    });

    // A forwarded 429 comes from the OWNER's counters; without relaying its throttle headers the
    // client is told to back off with no indication of for how long.
    it('relays the owner’s throttle headers to the client', async () => {
      const throttling = http.createServer((_req, res) => {
        res.writeHead(429, {
          'content-type': 'application/json',
          'Retry-After-short': '7',
          'X-RateLimit-Remaining-short': '0',
        });
        res.end(JSON.stringify({ statusCode: 429 }));
      });
      await new Promise<void>(resolve => throttling.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(throttling.address() as AddressInfo).port}`;

      try {
        const { interceptor, context, next, res } = build({ row: row({ nodeUrl: url }) });
        await interceptor.intercept(context, next);

        expect(res.status).toHaveBeenCalledWith(429);
        expect(res.setHeader).toHaveBeenCalledWith('retry-after-short', '7');
        expect(res.setHeader).toHaveBeenCalledWith('x-ratelimit-remaining-short', '0');
      } finally {
        await new Promise<void>(resolve => throttling.close(() => resolve()));
      }
    });

    // A NODE_URL that is not a usable absolute URL is an unreachable owner, not a server fault on a
    // request that had nothing wrong with it.
    it('answers 503, not 500, when the owner’s recorded URL is unusable', async () => {
      const { interceptor, context, next, res } = build({ row: row({ nodeUrl: 'node-a:2785' }) });

      await interceptor.intercept(context, next);

      expect(res.status).toHaveBeenCalledWith(503);
    });

    it('an unreachable owner answers 503 with the owner named, never a hang or a crash', async () => {
      const { interceptor, context, next, handle, res } = build({
        row: row({ nodeUrl: 'http://127.0.0.1:1' }),
        timeoutMs: 2000,
      });

      await interceptor.intercept(context, next);

      expect(res.status).toHaveBeenCalledWith(503);
      const errorBody = (res.json.mock.calls[0] as [{ statusCode: number; message: string }])[0];
      expect(errorBody.statusCode).toBe(503);
      expect(errorBody.message).toContain('peer-node');
      expect(handle).not.toHaveBeenCalled();
    });
  });
});

// The request target is caller-controlled: HTTP/1.1's absolute form is matched by Express and left
// verbatim in `req.originalUrl`, and resolving that against a base DISCARDS the base. Forwarding it
// would aim this node at an attacker's origin and hand over the caller's API key with the request.
describe('forwardTarget', () => {
  const OWNER = 'http://10.0.0.5:2785';

  it('keeps path and query, on the owner origin', () => {
    expect(forwardTarget('/api/sessions/s1/messages?limit=5', OWNER)).toBe(
      'http://10.0.0.5:2785/api/sessions/s1/messages?limit=5',
    );
  });

  it.each([
    ['absolute form', 'http://attacker.tld/api/sessions/s1'],
    ['absolute form, https', 'https://attacker.tld/api/sessions/s1'],
    ['protocol-relative', '//attacker.tld/api/sessions/s1'],
    ['absolute form with credentials and port', 'http://user:pw@attacker.tld:9999/api/sessions/s1'],
  ])('never leaves the owner origin for a %s target', (_label, originalUrl) => {
    const target = new URL(forwardTarget(originalUrl, OWNER));
    expect(target.origin).toBe('http://10.0.0.5:2785');
    expect(target.pathname).toBe('/api/sessions/s1');
  });

  it.each([
    // A pathname that resolves to a leading `//` is a network-path reference: re-anchoring it with
    // `new URL(path, base)` would read `attacker` as the authority. The setter-based rebuild must not.
    ['double-slash path after an absolute host', 'http://attacker.tld//evil.host/api/x'],
    ['bare network-path in the path', 'http://attacker.tld//evil.host/foo?keep=1'],
    // A control character can split the parse and shift the host the same way.
    ['embedded tab', 'http://attacker.tld/\t/evil.host/x'],
  ])('keeps the owner origin for a %s (network-path / control-char hijack)', (_label, originalUrl) => {
    expect(new URL(forwardTarget(originalUrl, OWNER)).origin).toBe('http://10.0.0.5:2785');
  });

  it('carries the owner base path when one is configured', () => {
    expect(forwardTarget('/api/sessions/s1', 'http://10.0.0.5:2785/')).toBe('http://10.0.0.5:2785/api/sessions/s1');
  });
});
