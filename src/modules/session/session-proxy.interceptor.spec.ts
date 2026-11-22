import http from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import { of, lastValueFrom } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { SessionProxyInterceptor, FORWARDED_HEADER, forwardTarget } from './session-proxy.interceptor';
import type { Session } from './entities/session.entity';
import { runWithRequestId } from '../../common/services/request-context';

/**
 * The forwarding decision IS the security surface: forwarding when the session is local answers a
 * request twice; not forwarding when the owner is live strands the caller with a conflict; ever
 * forwarding a forwarded request is a loop between two nodes that both think the other owns the
 * session. The matrix below pins every arm, and the mechanics tests run against a real HTTP server
 * because header pass-through and body re-serialisation are exactly the parts a stubbed fetch
 * would vacuously approve.
 */
describe('SessionProxyInterceptor', () => {
  // Exercise both UUID ids and the safe string ids accepted by data import.
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
    rawBody?: Buffer;
    socket?: { remoteAddress?: string };
  };

  const request = (over: Partial<Req> = {}): Req => ({
    headers: { 'x-api-key': 'k-123', 'content-type': 'application/json' },
    params: { sessionId: SID },
    method: 'GET',
    originalUrl: `/api/sessions/${SID}/messages?limit=5`,
    ...over,
  });

  /** A port nothing listens on: connecting to it is refused before any request is sent. */
  const closedPort = async (): Promise<number> => {
    const probe = http.createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    return port;
  };

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
    it.each([SID, 'legacy-session'])(
      'refuses a marked request for session %s that lands on a live non-owner',
      async sessionId => {
        const req = request({
          params: { sessionId },
          headers: { [FORWARDED_HEADER]: 'peer-node', 'x-api-key': 'k' },
        });
        const { interceptor, context, next, handle } = build({ req, row: row({ id: sessionId }) });
        await expect(interceptor.intercept(context, next)).rejects.toMatchObject({ status: 409 });
        expect(handle).not.toHaveBeenCalled();
      },
    );

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

    it('handles an unknown string id locally after looking up its owner', async () => {
      const req = request({ params: { sessionId: 'missing-session' } });
      const { interceptor, context, next, findOne } = build({ req, row: null });
      expect(await ranLocally(await interceptor.intercept(context, next))).toBe(true);
      expect(findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'missing-session' } }));
    });

    // The lookup is the first statement of every session request on a routed node, so a database failure there would
    // answer 500 before the checks of a start, stop or delete that answer a retryable 503 were reached.
    it.each([
      ['a lost connection', new Error('Connection terminated unexpectedly')],
      ['lock contention', Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })],
    ])('answers a retryable 503 when the owner lookup fails on %s', async (_label, failure) => {
      const { interceptor, context, next, handle, findOne } = build({});
      findOne.mockRejectedValueOnce(failure);
      await expect(interceptor.intercept(context, next)).rejects.toMatchObject({ status: 503 });
      expect(handle).not.toHaveBeenCalled();
    });

    it('lets a statement the database rejected through as it was', async () => {
      const { interceptor, context, next, handle, findOne } = build({});
      const rejected = new Error('column "nodeUrl" does not exist');
      findOne.mockRejectedValueOnce(rejected);
      await expect(interceptor.intercept(context, next)).rejects.toBe(rejected);
      expect(handle).not.toHaveBeenCalled();
    });

    it('handles an id containing NUL locally without querying its owner', async () => {
      const req = request({ params: { sessionId: 'session\0name' } });
      const { interceptor, context, next, findOne } = build({ req, row: null });
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

    it.each([SID, 'legacy-session'])('relays a send for session %s and the owner response', async sessionId => {
      const req = request({
        params: { sessionId },
        method: 'POST',
        originalUrl: `/api/sessions/${sessionId}/messages/send-text?trace=1`,
        body: { chatId: '628@c.us', text: 'halo' },
      });
      const { interceptor, context, next, handle, res, findOne } = build({
        req,
        row: row({ id: sessionId, nodeUrl: serverUrl }),
      });

      const result = await interceptor.intercept(context, next);
      // The response was written directly, so nothing may flow to the route handler. The observable
      // still EMITS (undefined) rather than completing empty: Nest resolves it with lastValueFrom,
      // which rejects on an empty one and logged an ERROR for every successful forward.
      expect(await lastValueFrom(result)).toBeUndefined();
      expect(handle).not.toHaveBeenCalled();
      expect(findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { id: sessionId } }));

      expect(seen).toHaveLength(1);
      expect(seen[0].method).toBe('POST');
      expect(seen[0].url).toBe(`/api/sessions/${sessionId}/messages/send-text?trace=1`);
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

    it('preserves application/x-www-form-urlencoded and serializes parsed form bodies with bracket notation when rawBody is absent', async () => {
      const mentions = Array.from({ length: 25 }, (_, i) => `628${i}@c.us`);
      const req = request({
        method: 'POST',
        originalUrl: `/api/sessions/${SID}/messages/send-text`,
        headers: { 'x-api-key': 'k-123', 'content-type': 'application/x-www-form-urlencoded; charset=iso-8859-1' },
        body: {
          chatId: '628@c.us',
          text: 'hi & bye café',
          mentions,
          items: [
            { id: '1', qty: '2' },
            { id: '3', qty: '4' },
          ],
          meta: { source: 'web', nested: { flag: true } },
        },
      });
      const { interceptor, context, next } = build({ req, row: row({ nodeUrl: serverUrl }) });

      await interceptor.intercept(context, next);

      // Re-serialised UTF-8 form bytes always declare charset=utf-8 rather than a mismatched caller charset.
      expect(seen[0].headers['content-type']).toBe('application/x-www-form-urlencoded; charset=utf-8');
      const params = new URLSearchParams(seen[0].body);
      expect(params.get('chatId')).toBe('628@c.us');
      expect(params.get('text')).toBe('hi & bye café');
      expect(params.getAll('mentions[]')).toEqual(mentions);
      expect(params.get('items[0][id]')).toBe('1');
      expect(params.get('items[1][qty]')).toBe('4');
      expect(params.get('meta[source]')).toBe('web');
      expect(params.get('meta[nested][flag]')).toBe('true');

      // Verify end-to-end parsing through Express's extended urlencoded parser (matching the owner node).
      const ownerApp = express();
      ownerApp.use(express.urlencoded({ extended: true }));
      let parsedOnOwner: Record<string, unknown> | undefined;
      ownerApp.post('/echo', (ownerReq, ownerRes) => {
        parsedOnOwner = ownerReq.body as Record<string, unknown>;
        ownerRes.json({ ok: true });
      });
      const ownerServer = ownerApp.listen(0, '127.0.0.1');
      await new Promise<void>(resolve => ownerServer.once('listening', resolve));
      try {
        const ownerUrl = `http://127.0.0.1:${(ownerServer.address() as AddressInfo).port}`;
        const ownerFwd = build({
          req: { ...req, originalUrl: '/echo' },
          row: row({ nodeUrl: ownerUrl }),
        });
        await ownerFwd.interceptor.intercept(ownerFwd.context, ownerFwd.next);
        expect(Array.isArray(parsedOnOwner?.mentions)).toBe(true);
        expect(parsedOnOwner?.mentions).toEqual(mentions);
        expect(parsedOnOwner?.items).toEqual([
          { id: '1', qty: '2' },
          { id: '3', qty: '4' },
        ]);
        expect(parsedOnOwner?.text).toBe('hi & bye café');
      } finally {
        await new Promise<void>(resolve => ownerServer.close(() => resolve()));
      }
    });

    it('normalizes mismatched non-UTF-8 JSON charset to utf-8 when re-serializing without rawBody', async () => {
      const req = request({
        method: 'POST',
        originalUrl: `/api/sessions/${SID}/messages/send-text`,
        headers: { 'x-api-key': 'k-123', 'content-type': 'application/json; charset=utf-16le' },
        body: { chatId: '628@c.us', text: 'café' },
      });
      const { interceptor, context, next } = build({ req, row: row({ nodeUrl: serverUrl }) });

      await interceptor.intercept(context, next);

      expect(seen[0].headers['content-type']).toBe('application/json; charset=utf-8');
      expect(JSON.parse(seen[0].body)).toEqual({ chatId: '628@c.us', text: 'café' });
    });

    it('forwards non-empty rawBody bytes and original content-type verbatim on non-GET/HEAD requests', async () => {
      const rawJson = Buffer.from('{  "text": "halo",  "chatId": "628@c.us" }');
      const jsonReq = request({
        method: 'POST',
        originalUrl: `/api/sessions/${SID}/messages/send-text`,
        headers: { 'x-api-key': 'k-123', 'content-type': 'application/json; charset=utf-8' },
        body: { chatId: '628@c.us', text: 'halo' },
        rawBody: rawJson,
      });
      const first = build({ req: jsonReq, row: row({ nodeUrl: serverUrl }) });
      await first.interceptor.intercept(first.context, first.next);

      expect(seen[0].headers['content-type']).toBe('application/json; charset=utf-8');
      expect(seen[0].body).toBe(rawJson.toString('utf8'));

      const rawForm = Buffer.from('chatId=628%40c.us&text=hi+%26+bye');
      const formReq = request({
        method: 'POST',
        originalUrl: `/api/sessions/${SID}/messages/send-text`,
        headers: { 'x-api-key': 'k-123', 'content-type': 'application/x-www-form-urlencoded' },
        body: { chatId: '628@c.us', text: 'hi & bye' },
        rawBody: rawForm,
      });
      const second = build({ req: formReq, row: row({ nodeUrl: serverUrl }) });
      await second.interceptor.intercept(second.context, second.next);

      expect(seen[1].headers['content-type']).toBe('application/x-www-form-urlencoded');
      expect(seen[1].body).toBe(rawForm.toString('utf8'));
    });

    it('omits content-type and body on bodyless DELETE requests while keeping bodies on DELETE with payload', async () => {
      // Bodyless DELETE with Express default empty object and no content-type / content-length > 0.
      const defaultEmpty = build({
        req: request({
          method: 'DELETE',
          originalUrl: `/api/sessions/${SID}`,
          headers: { 'x-api-key': 'k-123' },
          body: {},
        }),
        row: row({ nodeUrl: serverUrl }),
      });
      await defaultEmpty.interceptor.intercept(defaultEmpty.context, defaultEmpty.next);
      expect(seen[0].method).toBe('DELETE');
      expect(seen[0].headers['content-type']).toBeUndefined();
      expect(seen[0].body).toBe('');

      // Bodyless DELETE with undefined body.
      const undefinedBody = build({
        req: request({
          method: 'DELETE',
          originalUrl: `/api/sessions/${SID}`,
          headers: { 'x-api-key': 'k-123' },
          body: undefined,
        }),
        row: row({ nodeUrl: serverUrl }),
      });
      await undefinedBody.interceptor.intercept(undefinedBody.context, undefinedBody.next);
      expect(seen[1].headers['content-type']).toBeUndefined();
      expect(seen[1].body).toBe('');

      // Bodyless DELETE with 0-byte chunked rawBody does not fabricate "{}".
      const zeroByteChunked = build({
        req: request({
          method: 'DELETE',
          originalUrl: `/api/sessions/${SID}`,
          headers: { 'x-api-key': 'k-123', 'transfer-encoding': 'chunked', 'content-type': 'application/json' },
          body: {},
          rawBody: Buffer.alloc(0),
        }),
        row: row({ nodeUrl: serverUrl }),
      });
      await zeroByteChunked.interceptor.intercept(zeroByteChunked.context, zeroByteChunked.next);
      expect(seen[2].headers['content-type']).toBeUndefined();
      expect(seen[2].body).toBe('');

      // Bodyless DELETE with empty-string body does not fabricate '""'.
      const emptyStringBody = build({
        req: request({
          method: 'DELETE',
          originalUrl: `/api/sessions/${SID}`,
          headers: { 'x-api-key': 'k-123', 'content-type': 'application/json' },
          body: '',
        }),
        row: row({ nodeUrl: serverUrl }),
      });
      await emptyStringBody.interceptor.intercept(emptyStringBody.context, emptyStringBody.next);
      expect(seen[3].headers['content-type']).toBeUndefined();
      expect(seen[3].body).toBe('');

      // DELETE carrying an actual JSON payload still forwards it.
      const withPayload = build({
        req: request({
          method: 'DELETE',
          originalUrl: `/api/sessions/${SID}/messages/m1`,
          headers: { 'x-api-key': 'k-123', 'content-type': 'application/json' },
          body: { everyone: true },
        }),
        row: row({ nodeUrl: serverUrl }),
      });
      await withPayload.interceptor.intercept(withPayload.context, withPayload.next);
      expect(seen[4].headers['content-type']).toBe('application/json; charset=utf-8');
      expect(JSON.parse(seen[4].body)).toEqual({ everyone: true });
    });

    it('forwards x-request-id from request context or falls back to a valid inbound header while dropping invalid ones', async () => {
      const fromContext = build({
        req: request({ headers: { 'x-api-key': 'k-123', 'x-request-id': 'header-id' } }),
        row: row({ nodeUrl: serverUrl }),
      });
      await runWithRequestId('ctx-req-42', () =>
        fromContext.interceptor.intercept(fromContext.context, fromContext.next),
      );
      expect(seen[0].headers['x-request-id']).toBe('ctx-req-42');

      const fromHeader = build({
        req: request({ headers: { 'x-api-key': 'k-123', 'x-request-id': 'inbound-req-99' } }),
        row: row({ nodeUrl: serverUrl }),
      });
      await fromHeader.interceptor.intercept(fromHeader.context, fromHeader.next);
      expect(seen[1].headers['x-request-id']).toBe('inbound-req-99');

      // Malformed CRLF or non-ByteString inbound headers must be dropped instead of crashing fetch() into 502.
      for (const badId of ['bad\r\nX-Injected: 1', 'req-\u2603', 'x'.repeat(129)]) {
        const bad = build({
          req: request({ headers: { 'x-api-key': 'k-123', 'x-request-id': badId } }),
          row: row({ nodeUrl: serverUrl }),
        });
        await bad.interceptor.intercept(bad.context, bad.next);
        expect(bad.res.status).toHaveBeenCalledWith(201);
        expect(seen.at(-1)?.headers['x-request-id']).toBeUndefined();
      }
    });

    it('a GET carries no body', async () => {
      const { interceptor, context, next } = build({ req: request(), row: row({ nodeUrl: serverUrl }) });

      await interceptor.intercept(context, next);

      expect(seen[0].method).toBe('GET');
      expect(seen[0].body).toBe('');
    });

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

    // Without the chain the owner sees every forwarded call as coming from THIS node: an
    // allowedIps-restricted key is refused with 403 on every forwarded request, and the per-IP
    // throttler pools all forwarded traffic into one bucket.
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

    // The owner claims the Idempotency-Key, not this hop: a send landing on a non-owner node is
    // forwarded before the route's own interceptor runs. Without the header the owner would run the
    // send unclaimed, and a client retry after a timeout would send the message twice.
    it('forwards the Idempotency-Key to the owner', async () => {
      const req = request({
        method: 'POST',
        originalUrl: `/api/sessions/${SID}/messages/send-text`,
        headers: { 'x-api-key': 'k-123', 'content-type': 'application/json', 'idempotency-key': 'order-42' },
        body: { chatId: '628@c.us', text: 'halo' },
      });
      const { interceptor, context, next } = build({ req, row: row({ nodeUrl: serverUrl }) });

      await interceptor.intercept(context, next);

      expect(seen[0].headers['idempotency-key']).toBe('order-42');
    });

    // Without it a client cannot tell an answer replayed from a stored key from a new send.
    it('relays Idempotent-Replayed from the owner to the client', async () => {
      const replaying = http.createServer((_req, res) => {
        res.writeHead(201, { 'content-type': 'application/json', 'Idempotent-Replayed': 'true' });
        res.end(JSON.stringify({ messageId: 'M1' }));
      });
      await new Promise<void>(resolve => replaying.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(replaying.address() as AddressInfo).port}`;

      try {
        const { interceptor, context, next, res } = build({ row: row({ nodeUrl: url }) });
        await interceptor.intercept(context, next);

        expect(res.setHeader).toHaveBeenCalledWith('idempotent-replayed', 'true');
      } finally {
        await new Promise<void>(resolve => replaying.close(() => resolve()));
      }
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
        row: row({ nodeUrl: `http://127.0.0.1:${await closedPort()}` }),
        timeoutMs: 2000,
      });

      await interceptor.intercept(context, next);

      expect(res.status).toHaveBeenCalledWith(503);
      const errorBody = (res.json.mock.calls[0] as [{ statusCode: number; message: string }])[0];
      expect(errorBody.statusCode).toBe(503);
      expect(errorBody.message).toContain('peer-node');
      expect(handle).not.toHaveBeenCalled();
    });

    // Once the request has been sent the owner may have acted on it, and clients replay a POST on
    // 503 as declined-before-acting. A send that timed out or broke mid-flight must not look like
    // that, or a retry sends the WhatsApp message twice.
    const withOwner = async (handler: http.RequestListener, run: (url: string) => Promise<void>): Promise<void> => {
      const owner = http.createServer(handler);
      await new Promise<void>(resolve => owner.listen(0, '127.0.0.1', resolve));
      try {
        await run(`http://127.0.0.1:${(owner.address() as AddressInfo).port}`);
      } finally {
        owner.closeAllConnections();
        await new Promise<void>(resolve => owner.close(() => resolve()));
      }
    };
    const sendRequest = () => request({ method: 'POST', originalUrl: `/api/sessions/${SID}/messages/send-text` });

    it('answers 504, not 503, when the owner received the send but did not answer in time', async () => {
      await withOwner(
        () => undefined,
        async url => {
          const { interceptor, context, next, res } = build({
            row: row({ nodeUrl: url }),
            req: sendRequest(),
            timeoutMs: 200,
          });
          await interceptor.intercept(context, next);

          expect(res.status).toHaveBeenCalledTimes(1);
          expect(res.status).toHaveBeenCalledWith(504);
          expect((res.json.mock.calls[0] as [{ error: string }])[0].error).toBe('Gateway Timeout');
        },
      );
    });

    // A setting past what a timer takes would fire after 1 ms and time every forwarded request out at once.
    it('does not time requests out at once for a timeout setting beyond the timer ceiling', async () => {
      await withOwner(
        (_req, res) => {
          setTimeout(() => res.end('{}'), 100);
        },
        async url => {
          const { interceptor, context, next, res } = build({
            row: row({ nodeUrl: url }),
            req: sendRequest(),
            timeoutMs: 5_000_000_000,
          });
          await interceptor.intercept(context, next);

          expect(res.status).toHaveBeenCalledTimes(1);
          expect(res.status).toHaveBeenCalledWith(200);
        },
      );
    });

    it('answers 502, not 503, when the connection breaks after the send was dispatched', async () => {
      await withOwner(
        req => req.socket.destroy(),
        async url => {
          const { interceptor, context, next, res } = build({ row: row({ nodeUrl: url }), req: sendRequest() });
          const warn = jest.spyOn((interceptor as unknown as { logger: { warn: () => void } }).logger, 'warn');
          await interceptor.intercept(context, next);

          expect(res.status).toHaveBeenCalledTimes(1);
          expect(res.status).toHaveBeenCalledWith(502);
          // A 502 can also come from a failure before anything was sent (an untrusted TLS
          // certificate), so the answer must not claim a send and must point at NODE_URL.
          const { message } = (res.json.mock.calls[0] as [{ message: string }])[0];
          expect(message).toContain('possibly after the request was sent');
          expect(message).toContain('NODE_URL');
          // fetch only says 'fetch failed'; the cause code is what names the real failure.
          const [, logged] = warn.mock.calls[0] as unknown as [string, { cause: unknown }];
          expect(logged.cause).toMatch(/^[A-Z_]+$/);
        },
      );
    });

    it('answers 502 without relaying the owner status or headers when the body read fails', async () => {
      await withOwner(
        (req, res) => {
          res.writeHead(201, { 'content-type': 'application/json', 'content-length': '100' });
          res.write('{"id":');
          setTimeout(() => req.socket.destroy(), 20);
        },
        async url => {
          const { interceptor, context, next, res } = build({ row: row({ nodeUrl: url }), req: sendRequest() });
          await interceptor.intercept(context, next);

          expect(res.status).toHaveBeenCalledTimes(1);
          expect(res.status).toHaveBeenCalledWith(502);
          expect(res.setHeader).not.toHaveBeenCalled();
        },
      );
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
    // An owner behind a path-prefixed reverse proxy: the prefix is where its API lives.
    expect(forwardTarget('/api/sessions/s1?x=1', 'https://node-a.example.com/openwa/')).toBe(
      'https://node-a.example.com/openwa/api/sessions/s1?x=1',
    );
    expect(forwardTarget('/api/sessions/s1', 'https://node-a.example.com/openwa')).toBe(
      'https://node-a.example.com/openwa/api/sessions/s1',
    );
  });

  it('keeps the owner origin and prefix for a network-path target under a prefixed base', () => {
    const target = new URL(forwardTarget('http://attacker.tld//evil.host/x', 'https://node-a.example.com/openwa'));
    expect(target.origin).toBe('https://node-a.example.com');
    expect(target.pathname.startsWith('/openwa/')).toBe(true);
  });
});
