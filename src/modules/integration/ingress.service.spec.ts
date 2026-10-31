import { IngressService, extractConversationId, redactSensitiveHeaders } from './ingress.service';
import { EngineStatus } from '../../engine/interfaces/whatsapp-engine.interface';
import { createHmac } from 'node:crypto';

function deps(overrides: Record<string, unknown> = {}) {
  return {
    instances: {
      resolve: jest.fn().mockResolvedValue({
        id: 'chatwoot:acct1',
        pluginId: 'chatwoot',
        instanceId: 'acct1',
        secret: 's',
        enabled: true,
        sessionScope: 'sess-1',
        verifyToken: null,
      }),
    },
    manifestRoute: jest.fn().mockReturnValue({
      route: 'chatwoot',
      mode: 'async',
      verify: 'core',
      maxBodyBytes: 1024,
      signature: { scheme: 'none' },
      dedupHeader: 'x-delivery',
    }),
    events: { recordOrSkip: jest.fn().mockResolvedValue(true) },
    enqueue: jest.fn().mockResolvedValue(undefined),
    now: () => 0,
    ...overrides,
  };
}

describe('redactSensitiveHeaders (persisted ingress payloads)', () => {
  it('redacts credential and signature headers, keeps the rest verbatim', () => {
    const out = redactSensitiveHeaders({
      authorization: 'Bearer eyJhbGciOi',
      'x-hub-signature-256': 'sha256=abc',
      cookie: 'session=secret',
      'x-delivery': 'd1',
      'content-type': 'application/json',
    });
    expect(out.authorization).toBe('[redacted]');
    expect(out['x-hub-signature-256']).toBe('[redacted]');
    expect(out.cookie).toBe('[redacted]');
    expect(out['x-delivery']).toBe('d1');
    expect(out['content-type']).toBe('application/json');
  });

  it('the persisted payload carries redacted headers (wiring, not just the helper)', async () => {
    const recordOrSkip = jest.fn().mockResolvedValue(true);
    const d = deps();
    d.events.recordOrSkip = recordOrSkip;
    const svc = new IngressService(d);
    await svc.handle({
      pluginId: 'chatwoot',
      instanceId: 'acct1',
      route: 'chatwoot',
      method: 'POST',
      headers: { 'x-delivery': 'd1', authorization: 'Bearer tok' },
      query: {},
      rawBody: '{}',
    });
    // jest's mock.calls typing erodes through the deps() override — one explicit cast at the
    // boundary beats a chain of eslint suppressions.
    const calls = recordOrSkip.mock.calls as unknown as [[{ payload: { headers: Record<string, string> } }]];
    const recorded = calls[0][0];
    expect(recorded.payload.headers.authorization).toBe('[redacted]');
    expect(recorded.payload.headers['x-delivery']).toBe('d1');
  });

  it('redacts a Standard Webhooks signature after authenticating, before persistence and the queue', async () => {
    const key = Buffer.from('dummy-standard-webhooks-secret');
    const signature = 'v1,' + createHmac('sha256', key).update('delivery.1000.{}').digest('base64');
    const recordOrSkip = jest.fn().mockResolvedValue(true);
    const enqueue = jest.fn().mockResolvedValue(undefined);
    const d = deps({
      now: () => 1_000_000,
      events: { recordOrSkip },
      enqueue,
      instances: {
        resolve: jest.fn().mockResolvedValue({
          id: 'chatwoot:acct1',
          pluginId: 'chatwoot',
          instanceId: 'acct1',
          secret: `whsec_${key.toString('base64')}`,
          enabled: true,
          sessionScope: 'sess-1',
          verifyToken: null,
        }),
      },
      manifestRoute: jest.fn().mockReturnValue({
        route: 'chatwoot',
        maxBodyBytes: 1024,
        signature: { scheme: 'standard-webhooks' },
      }),
    });
    const res = await new IngressService(d).handle({
      pluginId: 'chatwoot',
      instanceId: 'acct1',
      route: 'chatwoot',
      method: 'POST',
      query: {},
      rawBody: '{}',
      headers: { 'webhook-id': 'delivery', 'webhook-timestamp': '1000', 'webhook-signature': signature },
    });
    expect(res.status).toBe(202);
    const expected = { 'webhook-id': 'delivery', 'webhook-timestamp': '1000', 'webhook-signature': '[redacted]' };
    const recorded = recordOrSkip.mock.calls as unknown as [[{ payload: { headers: unknown } }]];
    const queued = enqueue.mock.calls as unknown as [[{ payload: { headers: unknown } }]];
    expect(recorded[0][0].payload.headers).toEqual(expected);
    expect(queued[0][0].payload.headers).toEqual(expected);
  });

  it("redacts an hmac route's declared signature header in the persisted and enqueued payload", async () => {
    const d = deps({
      manifestRoute: jest.fn().mockReturnValue({
        route: 'shop',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: 1024,
        signature: { scheme: 'hmac-sha256', header: 'X-Custom-Sig' },
        dedupHeader: 'x-delivery',
      }),
    });
    const res = await new IngressService(d).handle({
      pluginId: 'shop',
      instanceId: 'acct1',
      route: 'shop',
      method: 'POST',
      headers: { 'x-delivery': 'd1', 'x-custom-sig': createHmac('sha256', 's').update('{}').digest('hex') },
      query: {},
      rawBody: '{}',
    });
    expect(res.status).toBe(202);
    const recorded = (
      d.events.recordOrSkip.mock.calls as unknown as [[{ payload: { headers: Record<string, string> } }]]
    )[0][0];
    expect(recorded.payload.headers['x-custom-sig']).toBe('[redacted]');
    expect(recorded.payload.headers['x-delivery']).toBe('d1');
    const job = (d.enqueue.mock.calls as unknown as [[{ payload: { headers: Record<string, string> } }]])[0][0];
    expect(job.payload.headers['x-custom-sig']).toBe('[redacted]');
  });

  it("redacts a shared-secret route's declared credential header in the persisted and enqueued payload", async () => {
    const d = deps({
      manifestRoute: jest.fn().mockReturnValue({
        route: 'chatwoot',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: 1024,
        signature: { scheme: 'shared-secret', header: 'X-Provider-Token' },
        dedupHeader: 'x-delivery',
      }),
    });
    const res = await new IngressService(d).handle({
      pluginId: 'chatwoot',
      instanceId: 'acct1',
      route: 'chatwoot',
      method: 'POST',
      headers: { 'x-delivery': 'd1', 'x-provider-token': 's' },
      query: {},
      rawBody: '{}',
    });
    expect(res.status).toBe(202);
    const recorded = (
      d.events.recordOrSkip.mock.calls as unknown as [[{ payload: { headers: Record<string, string> } }]]
    )[0][0];
    expect(recorded.payload.headers['x-provider-token']).toBe('[redacted]');
    expect(recorded.payload.headers['x-delivery']).toBe('d1');
    const job = (d.enqueue.mock.calls as unknown as [[{ payload: { headers: Record<string, string> } }]])[0][0];
    expect(job.payload.headers['x-provider-token']).toBe('[redacted]');
  });
});

describe('IngressService admission verdict', () => {
  it.each([
    {
      label: 'an unauthenticated route',
      signature: { scheme: 'none' },
      headers: {} as Record<string, string>,
      verified: false,
    },
    {
      label: 'a shared-secret route',
      signature: { scheme: 'shared-secret', header: 'X-Provider-Token' },
      headers: { 'x-provider-token': 's' },
      verified: true,
    },
  ])(
    'records $label as verified: $verified in the stored and queued payload',
    async ({ signature, headers, verified }) => {
      const d = deps({
        manifestRoute: jest.fn().mockReturnValue({
          route: 'chatwoot',
          mode: 'async',
          verify: 'core',
          maxBodyBytes: 1024,
          signature,
          dedupHeader: 'x-delivery',
        }),
      });
      const res = await new IngressService(d).handle({
        pluginId: 'chatwoot',
        instanceId: 'acct1',
        route: 'chatwoot',
        method: 'POST',
        headers: { 'x-delivery': 'd1', ...headers },
        query: {},
        rawBody: '{}',
      });
      expect(res.status).toBe(202);
      const stored = (d.events.recordOrSkip.mock.calls as unknown as [[{ payload: { admission?: unknown } }]])[0][0];
      const queued = (d.enqueue.mock.calls as unknown as [[{ payload: { admission?: unknown } }]])[0][0];
      expect(stored.payload.admission).toEqual({ verified });
      expect(queued.payload.admission).toEqual({ verified });
    },
  );
});

describe('IngressService.handle', () => {
  const req = {
    pluginId: 'chatwoot',
    instanceId: 'acct1',
    route: 'chatwoot',
    method: 'POST',
    headers: { 'x-delivery': 'd1' },
    query: {},
    rawBody: '{}',
  };

  it('verifies, persists, enqueues, and fast-acks 202', async () => {
    const d = deps();
    const svc = new IngressService(d);
    const res = await svc.handle(req);
    expect(d.events.recordOrSkip).toHaveBeenCalled();
    expect(d.enqueue).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'd1', method: 'POST' }), 'd1');
    expect(res.status).toBe(202);
  });

  it('persists the request method so a replay keeps it', async () => {
    const d = deps();
    await new IngressService(d).handle({ ...req, method: 'PUT' });
    const [recorded] = d.events.recordOrSkip.mock.calls[0] as [{ payload: { method?: string } }];
    expect(recorded.payload.method).toBe('PUT');
    // The job carries the method at its top level; its payload stays the plain request shape.
    const [job] = d.enqueue.mock.calls[0] as [{ method: string; payload: { method?: string } }];
    expect(job.method).toBe('PUT');
    expect(job.payload.method).toBeUndefined();
  });

  // A body no parser read would be handled as the empty body: it passes a header-only scheme, and every
  // such delivery hashes to the same dedup key, so all but the first are acked and dropped.
  it('refuses a body in a content type no parser read (415), before anything is persisted', async () => {
    const d = deps();
    const res = await new IngressService(d).handle({ ...req, rawBody: '', unparsedBody: true });
    expect(res).toMatchObject({ status: 415 });
    expect(d.events.recordOrSkip).not.toHaveBeenCalled();
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it('uses the signed webhook-id as the default Standard Webhooks dedup key', async () => {
    const rawKey = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
    const secret = `v1,whsec_${rawKey.toString('base64')}`;
    const body = '{}';
    const timestamp = '1000';
    const webhookId = 'msg_signed_1';
    const signature = 'v1,' + createHmac('sha256', rawKey).update(`${webhookId}.${timestamp}.${body}`).digest('base64');
    const d = deps({
      instances: {
        resolve: jest.fn().mockResolvedValue({
          id: 'chatwoot:acct1',
          pluginId: 'chatwoot',
          instanceId: 'acct1',
          secret,
          enabled: true,
          sessionScope: 'sess-1',
          verifyToken: null,
        }),
      },
      manifestRoute: jest.fn().mockReturnValue({
        route: 'chatwoot',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: 1024,
        signature: { scheme: 'standard-webhooks' },
      }),
      now: () => 1_000_000,
    });

    const res = await new IngressService(d).handle({
      ...req,
      rawBody: body,
      headers: {
        'webhook-id': webhookId,
        'webhook-timestamp': timestamp,
        'webhook-signature': signature,
      },
    });

    expect(res.status).toBe(202);
    expect(d.events.recordOrSkip).toHaveBeenCalledWith(expect.objectContaining({ providerDeliveryId: webhookId }));
    expect(d.enqueue).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: webhookId }), webhookId);
  });

  it('short-circuits a duplicate delivery with the route ack and no enqueue', async () => {
    const d = deps({ events: { recordOrSkip: jest.fn().mockResolvedValue(false) } });
    const svc = new IngressService(d);
    const res = await svc.handle(req);
    expect(d.enqueue).not.toHaveBeenCalled();
    // No declared `response`, so this is the default ack: byte-identical to a first delivery's.
    expect(res).toEqual({ status: 202, body: 'accepted' });
  });

  it('rejects an oversized body with 413 before any dedup or enqueue', async () => {
    const d = deps({
      manifestRoute: jest.fn().mockReturnValue({
        route: 'chatwoot',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: 1,
        signature: { scheme: 'none' },
        dedupHeader: 'x-delivery',
      }),
    });
    const svc = new IngressService(d);
    const res = await svc.handle(req);
    expect(res.status).toBe(413);
    expect(d.events.recordOrSkip).not.toHaveBeenCalled();
  });

  // `Buffer.byteLength(rawBody) > route.maxBodyBytes` is always false when the manifest omits the
  // field, so a route declaring no cap silently enforced none — the 413 the published contract
  // promises was inert, and every accepted delivery is persisted with the body stored twice. A
  // manifest that forgets one field must not turn a route into an unbounded write amplifier.
  it.each([
    ['omitted', undefined],
    ['non-numeric', 'lots' as unknown as number],
    ['negative', -1],
  ])('falls back to a real cap when maxBodyBytes is %s', async (_label, maxBodyBytes) => {
    const d = deps({
      manifestRoute: jest.fn().mockReturnValue({
        route: 'chatwoot',
        mode: 'async',
        verify: 'core',
        maxBodyBytes,
        signature: { scheme: 'none' },
        dedupHeader: 'x-delivery',
      }),
    });
    const svc = new IngressService(d);
    const huge = { ...req, rawBody: 'x'.repeat(64 * 1024 * 1024) };
    const res = await svc.handle(huge);

    expect(res.status).toBe(413);
    expect(d.events.recordOrSkip).not.toHaveBeenCalled();
  });

  /**
   * The guard replaced `bodyLen > route.maxBodyBytes` with a typed check, and `>` COERCES: a manifest
   * is third-party JSON with no runtime validation, so a quoted number (`"1024"`) enforced a real cap
   * before and silently lost it to the much larger process-wide fallback after. The value is usable —
   * the point of the guard was to catch values that are not.
   */
  it('honours a numeric string cap rather than falling back past it', async () => {
    const d = deps({
      manifestRoute: jest.fn().mockReturnValue({
        route: 'chatwoot',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: '1024' as unknown as number,
        signature: { scheme: 'none' },
        dedupHeader: 'x-delivery',
      }),
    });
    const res = await new IngressService(d).handle({ ...req, rawBody: 'x'.repeat(2048) });

    expect(res.status).toBe(413);
    expect(d.events.recordOrSkip).not.toHaveBeenCalled();
  });

  // Negative twin: the coercion must not swallow the cap it declares.
  it('accepts a body inside a numeric string cap', async () => {
    const d = deps({
      manifestRoute: jest.fn().mockReturnValue({
        route: 'chatwoot',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: '1024' as unknown as number,
        signature: { scheme: 'none' },
        dedupHeader: 'x-delivery',
      }),
    });
    const res = await new IngressService(d).handle({ ...req, rawBody: 'x'.repeat(100) });

    expect(res.status).not.toBe(413);
  });

  /**
   * Zero is a cap, not a missing value: it admits only an empty body, which is what a verification
   * callback sends. Treating it as "unusable" handed such a route the process-wide limit instead —
   * a change in the permissive direction, on the one route shape that asked to accept nothing.
   * A SMALL body is what discriminates: any body is over a cap of 0, but well under the fallback.
   */
  it('treats a zero cap as strict rather than missing', async () => {
    const d = deps({
      manifestRoute: jest.fn().mockReturnValue({
        route: 'chatwoot',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: 0,
        signature: { scheme: 'none' },
        dedupHeader: 'x-delivery',
      }),
    });
    const res = await new IngressService(d).handle({ ...req, rawBody: 'x' });

    expect(res.status).toBe(413);
    expect(d.events.recordOrSkip).not.toHaveBeenCalled();
  });

  /**
   * The `negative` case above uses a huge body, which is over BOTH a -1 cap and the fallback — so it
   * cannot tell "fell back" from "used -1 as the cap". An empty body separates them: it is over -1
   * and inside any real cap. Without this, dropping the `>= 0` guard changes nothing observable.
   */
  it('does not use a negative cap as the limit', async () => {
    const d = deps({
      manifestRoute: jest.fn().mockReturnValue({
        route: 'chatwoot',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: -1,
        signature: { scheme: 'none' },
        dedupHeader: 'x-delivery',
      }),
    });
    const res = await new IngressService(d).handle({ ...req, rawBody: '' });

    expect(res.status).not.toBe(413);
  });

  it('still admits the empty body a zero cap exists to allow', async () => {
    const d = deps({
      manifestRoute: jest.fn().mockReturnValue({
        route: 'chatwoot',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: 0,
        signature: { scheme: 'none' },
        dedupHeader: 'x-delivery',
      }),
    });
    const res = await new IngressService(d).handle({ ...req, rawBody: '' });

    expect(res.status).not.toBe(413);
  });

  it('rejects a bad signature with 401 before any dedup or enqueue', async () => {
    const d = deps({
      manifestRoute: jest.fn().mockReturnValue({
        route: 'chatwoot',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: 1024,
        signature: { scheme: 'hmac-sha256', header: 'x-sig', prefix: 'sha256=' },
        dedupHeader: 'x-delivery',
      }),
    });
    const svc = new IngressService(d);
    const res = await svc.handle({ ...req, headers: { 'x-delivery': 'd1', 'x-sig': 'sha256=deadbeef' } });
    expect(res.status).toBe(401);
    expect(d.events.recordOrSkip).not.toHaveBeenCalled();
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it('404s for an unknown or disabled instance', async () => {
    const d = deps({ instances: { resolve: jest.fn().mockResolvedValue(null) } });
    const svc = new IngressService(d);
    expect((await svc.handle(req)).status).toBe(404);
  });

  it('404s for a disabled instance', async () => {
    const d = deps({
      instances: {
        resolve: jest.fn().mockResolvedValue({
          id: 'chatwoot:acct1',
          pluginId: 'chatwoot',
          instanceId: 'acct1',
          secret: 's',
          enabled: false,
          sessionScope: null,
          verifyToken: null,
        }),
      },
    });
    const svc = new IngressService(d);
    expect((await svc.handle(req)).status).toBe(404);
  });

  it('answers a GET challenge handshake host-side without enqueuing', async () => {
    const d = deps({
      instances: {
        resolve: jest.fn().mockResolvedValue({
          id: 'meta:acct1',
          pluginId: 'meta',
          instanceId: 'acct1',
          secret: 's',
          enabled: true,
          sessionScope: null,
          verifyToken: 'vtok',
        }),
      },
      manifestRoute: jest.fn().mockReturnValue({
        route: 'meta',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: 1024,
        signature: { scheme: 'none' },
        challenge: { method: 'GET', tokenParam: 'hub.verify_token', echoParam: 'hub.challenge' },
      }),
    });
    const svc = new IngressService(d);
    const res = await svc.handle({
      pluginId: 'meta',
      instanceId: 'acct1',
      route: 'meta',
      method: 'GET',
      headers: {},
      query: { 'hub.verify_token': 'vtok', 'hub.challenge': '12345' },
      rawBody: '',
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('12345');
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it('rejects a GET challenge with the wrong verify token', async () => {
    const d = deps({
      instances: {
        resolve: jest.fn().mockResolvedValue({
          id: 'meta:acct1',
          pluginId: 'meta',
          instanceId: 'acct1',
          secret: 's',
          enabled: true,
          sessionScope: null,
          verifyToken: 'vtok',
        }),
      },
      manifestRoute: jest.fn().mockReturnValue({
        route: 'meta',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: 1024,
        signature: { scheme: 'none' },
        challenge: { method: 'GET', tokenParam: 'hub.verify_token', echoParam: 'hub.challenge' },
      }),
    });
    const svc = new IngressService(d);
    const res = await svc.handle({
      pluginId: 'meta',
      instanceId: 'acct1',
      route: 'meta',
      method: 'GET',
      headers: {},
      query: { 'hub.verify_token': 'wrong', 'hub.challenge': '12345' },
      rawBody: '',
    });
    expect(res.status).toBe(403);
  });

  it('rejects a GET challenge when the instance has no verify token (no match against null)', async () => {
    const d = deps({
      instances: {
        resolve: jest.fn().mockResolvedValue({
          id: 'meta:acct1',
          pluginId: 'meta',
          instanceId: 'acct1',
          secret: 's',
          enabled: true,
          sessionScope: null,
          verifyToken: null,
        }),
      },
      manifestRoute: jest.fn().mockReturnValue({
        route: 'meta',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: 1024,
        signature: { scheme: 'none' },
        challenge: { method: 'GET', tokenParam: 'hub.verify_token', echoParam: 'hub.challenge' },
      }),
    });
    const svc = new IngressService(d);
    const res = await svc.handle({
      pluginId: 'meta',
      instanceId: 'acct1',
      route: 'meta',
      method: 'GET',
      headers: {},
      query: { 'hub.verify_token': '', 'hub.challenge': 'x' },
      rawBody: '',
    });
    expect(res.status).toBe(403);
  });

  it('404s for an unknown route', async () => {
    const d = deps({ manifestRoute: jest.fn().mockReturnValue(undefined) });
    const svc = new IngressService(d);
    expect((await svc.handle(req)).status).toBe(404);
  });

  it('derives a DETERMINISTIC delivery id from the body when the dedup header is absent', async () => {
    // A random UUID here would defeat both persist-dedup and BullMQ jobId idempotency, so a provider
    // retry of the same body must produce the SAME id, and a different body a DIFFERENT id.
    const d = deps();
    const svc = new IngressService(d);
    const res = await svc.handle({ ...req, headers: {} });
    expect(res.status).toBe(202);
    const [jobData, jobId] = d.enqueue.mock.calls[0] as [{ deliveryId: string }, string];
    expect(typeof jobId).toBe('string');
    expect(jobId.length).toBeGreaterThan(0);
    expect(jobData.deliveryId).toBe(jobId);

    // same body → same id (retry dedups)
    const d2 = deps();
    await new IngressService(d2).handle({ ...req, headers: {} });
    expect((d2.enqueue.mock.calls[0] as [unknown, string])[1]).toBe(jobId);

    // different body → different id
    const d3 = deps();
    await new IngressService(d3).handle({ ...req, headers: {}, rawBody: '{"a":1}' });
    expect((d3.enqueue.mock.calls[0] as [unknown, string])[1]).not.toBe(jobId);
  });
});

describe('dedupOn: body (a provider that rotates its delivery id on retry)', () => {
  // supabase/auth mints a fresh webhook-id for every attempt inside its own retry loop, so a lost
  // ack means the same signed body arrives under a new id and is treated as a new delivery: the
  // contact receives a second OTP. A route can declare that the body, not the header, is the
  // retry key; the header keeps deciding for every route that does not.
  // The request fixture above is scoped to the service describe, so this block carries its own.
  const req = {
    pluginId: 'chatwoot',
    instanceId: 'acct1',
    route: 'chatwoot',
    method: 'POST',
    headers: { 'x-delivery': 'd1' },
    query: {},
    rawBody: '{}',
  };
  const bodyKeyedRoute = () => ({
    route: 'send-sms',
    mode: 'async',
    verify: 'core',
    maxBodyBytes: 1024,
    // scheme none, as the fixture above: this block is about the retry key, not the signature.
    signature: { scheme: 'none' },
    dedupHeader: 'webhook-id',
    dedupOn: 'body',
  });

  it('keys the delivery on the body even when the dedup header is present', async () => {
    const first = deps({ manifestRoute: jest.fn().mockReturnValue(bodyKeyedRoute()) });
    await new IngressService(first).handle({ ...req, headers: { 'webhook-id': 'attempt-1' } });
    const firstId = (first.enqueue.mock.calls[0] as [unknown, string])[1];

    const retry = deps({ manifestRoute: jest.fn().mockReturnValue(bodyKeyedRoute()) });
    await new IngressService(retry).handle({ ...req, headers: { 'webhook-id': 'attempt-2' } });
    expect((retry.enqueue.mock.calls[0] as [unknown, string])[1]).toBe(firstId);

    const other = deps({ manifestRoute: jest.fn().mockReturnValue(bodyKeyedRoute()) });
    await new IngressService(other).handle({ ...req, headers: { 'webhook-id': 'attempt-3' }, rawBody: '{"a":1}' });
    expect((other.enqueue.mock.calls[0] as [unknown, string])[1]).not.toBe(firstId);
  });

  it('leaves a route without the flag on the header', async () => {
    const d = deps();
    await new IngressService(d).handle({ ...req, headers: { 'x-delivery': 'd-1' } });
    expect((d.enqueue.mock.calls[0] as [unknown, string])[1]).toBe('d-1');
  });

  it('falls back to the body hash when the dedup header is longer than 255 characters', async () => {
    const d = deps();
    await new IngressService(d).handle({ ...req, headers: { 'x-delivery': 'x'.repeat(256) }, rawBody: '{"n":1}' });
    const id = (d.enqueue.mock.calls[0] as [unknown, string])[1];
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    // The bound is inclusive: an id of exactly 255 characters is still the provider's.
    const edge = deps();
    await new IngressService(edge).handle({ ...req, headers: { 'x-delivery': 'y'.repeat(255) }, rawBody: '{"n":1}' });
    expect((edge.enqueue.mock.calls[0] as [unknown, string])[1]).toBe('y'.repeat(255));
  });

  // A header that is present but blank is no id at all. Taking it as one gave every delivery the
  // same empty key, so the dedup row admitted the first and dropped the rest while still answering
  // each provider with the route's success ack.
  it('falls back to the body hash when the dedup header is present but blank', async () => {
    const first = deps();
    await new IngressService(first).handle({ ...req, headers: { 'x-delivery': '' }, rawBody: '{"n":1}' });
    const firstId = (first.enqueue.mock.calls[0] as [unknown, string])[1];
    expect(firstId).not.toBe('');

    const second = deps();
    await new IngressService(second).handle({ ...req, headers: { 'x-delivery': '' }, rawBody: '{"n":2}' });
    // The ids differ, which is the whole point: a blank header must not collapse two bodies onto one
    // dedup row. (A fresh `deps()` always enqueues, so asserting the call count would prove nothing.)
    expect((second.enqueue.mock.calls[0] as [unknown, string])[1]).not.toBe(firstId);

    // And the fallback is the BODY hash, not a fresh value per delivery: the same bytes must key the
    // same row, or a provider's retry of a blank-header delivery is processed a second time. An id
    // minted per call would satisfy the inequality above while breaking what dedup exists for.
    const repeat = deps();
    await new IngressService(repeat).handle({ ...req, headers: { 'x-delivery': '' }, rawBody: '{"n":1}' });
    expect((repeat.enqueue.mock.calls[0] as [unknown, string])[1]).toBe(firstId);
  });
});

describe('extractConversationId', () => {
  it('returns undefined when no spec is declared', () => {
    expect(extractConversationId(undefined, {}, '{}')).toBeUndefined();
  });

  it('reads a declared header (case-insensitive)', () => {
    expect(extractConversationId({ header: 'X-Conv' }, { 'x-conv': 'c1' }, '{}')).toBe('c1');
  });

  it('reads a JSON pointer into the body', () => {
    expect(extractConversationId({ jsonPointer: '/conversation/id' }, {}, '{"conversation":{"id":42}}')).toBe('42');
  });

  it('returns undefined on a malformed body without throwing', () => {
    expect(extractConversationId({ jsonPointer: '/a/b' }, {}, 'not json')).toBeUndefined();
  });

  it.each([
    ['/a~1b/id', { 'a/b': { id: 'slash' } }, 'slash'],
    ['/a~0b/id', { 'a~b': { id: 'tilde' } }, 'tilde'],
    ['/a~01b/id', { 'a~1b': { id: 'once' } }, 'once'],
    ['/box//id', { box: { '': { id: 'empty' }, id: 'wrong' } }, 'empty'],
    ['/', { '': 'empty-root-key' }, 'empty-root-key'],
    ['/items/0/id', { items: [{ id: 42 }] }, '42'],
    ['conversation/id', { conversation: { id: 'no-leading-slash' } }, 'no-leading-slash'],
  ])('resolves the pointer %s by its RFC 6901 tokens', (jsonPointer, body, expected) => {
    expect(extractConversationId({ jsonPointer }, {}, JSON.stringify(body))).toBe(expected);
  });

  it.each(['/a~2b', '/a~', '/items/01/id', '/items/length', '/toString', '/name/length'])(
    'finds nothing for the pointer %s',
    jsonPointer => {
      const body = { 'a~2b': 'wrong', 'a~': 'wrong', items: [{ id: 1 }], name: 'abc' };
      expect(extractConversationId({ jsonPointer }, {}, JSON.stringify(body))).toBeUndefined();
    },
  );

  it('keeps the declared header ahead of a body pointer', () => {
    expect(extractConversationId({ header: 'X-Conv', jsonPointer: '/' }, { 'x-conv': 'header' }, '{"":"body"}')).toBe(
      'header',
    );
  });
});

describe('IngressService.handle — response contract', () => {
  const baseReq = {
    pluginId: 'p',
    instanceId: 'i1',
    route: 'send-sms',
    method: 'POST',
    headers: { 'x-delivery': 'd1' },
    query: {} as Record<string, string>,
    rawBody: '{}',
  };

  function depsWith(overrides: Record<string, unknown> = {}) {
    return {
      instances: {
        resolve: jest.fn().mockResolvedValue({
          id: 'p:i1',
          pluginId: 'p',
          instanceId: 'i1',
          secret: 's',
          enabled: true,
          sessionScope: 'sess-1',
          verifyToken: null,
        }),
      },
      manifestRoute: jest.fn().mockReturnValue({
        route: 'send-sms',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: 1024,
        signature: { scheme: 'none' },
        dedupHeader: 'x-delivery',
      }),
      events: { recordOrSkip: jest.fn().mockResolvedValue(true) },
      enqueue: jest.fn().mockResolvedValue(undefined),
      log: jest.fn(),
      now: () => 0,
      ...overrides,
    };
  }

  it('rejects 503 on a dead session BEFORE dedup or enqueue (no dedup trap)', async () => {
    const d = depsWith({
      sessionStatus: jest.fn().mockReturnValue(undefined),
      manifestRoute: jest.fn().mockReturnValue({
        route: 'send-sms',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: 1024,
        signature: { scheme: 'none' },
        dedupHeader: 'x-delivery',
        response: { preflight: [{ type: 'session-alive' }] },
      }),
    });
    const res = await new IngressService(d).handle(baseReq);
    expect(res.status).toBe(503);
    // The provider retries a 503 only when it carries Retry-After, so re-packing the rejection into
    // {status, body} silently turned a retryable rejection into a lost delivery.
    expect(res.headers).toEqual({ 'Retry-After': '5' });
    expect(d.events.recordOrSkip).not.toHaveBeenCalled();
    expect(d.enqueue).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(
      'ingress_preflight_rejected',
      expect.objectContaining({ status: 503, route: 'send-sms' }),
    );
  });

  it('passes a READY session through to ack + enqueue', async () => {
    const d = depsWith({
      sessionStatus: jest.fn().mockReturnValue(EngineStatus.READY),
      manifestRoute: jest.fn().mockReturnValue({
        route: 'send-sms',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: 1024,
        signature: { scheme: 'none' },
        dedupHeader: 'x-delivery',
        response: { preflight: [{ type: 'session-alive' }] },
      }),
    });
    const res = await new IngressService(d).handle(baseReq);
    expect(res.status).toBe(202);
    expect(d.enqueue).toHaveBeenCalled();
  });

  // While the boot restore is still bringing a plugin up there is no worker to run its deliveries. A route that
  // declares a response contract asked for an answer now (an OTP that arrives after the restore is useless), so it
  // is refused with a retryable 503. Any other route is accepted and persisted like every delivery: the queue holds
  // its job (IngressProcessor), or with the queue off the reconciler dispatches the row once the plugin is up.
  describe('a plugin that is still being restored after boot', () => {
    // A response contract that is an ack alone, so a 503 can only come from the restore.
    const answeringRoute = () =>
      jest.fn().mockReturnValue({
        route: 'send-sms',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: 1024,
        signature: { scheme: 'none' },
        dedupHeader: 'x-delivery',
        response: { ack: { status: 204 } },
      });

    it('refuses a route that declares a response contract, BEFORE dedup or enqueue, so the retry is not swallowed', async () => {
      const restorePending = jest.fn().mockReturnValue(true);
      const d = depsWith({ restorePending, manifestRoute: answeringRoute() });

      const res = await new IngressService(d).handle(baseReq);

      expect(res).toEqual({ status: 503, body: 'plugin restoring', headers: { 'Retry-After': '5' } });
      expect(restorePending).toHaveBeenCalledWith('p');
      expect(d.events.recordOrSkip).not.toHaveBeenCalled();
      expect(d.enqueue).not.toHaveBeenCalled();
      expect(d.log).toHaveBeenCalledWith(
        'ingress_preflight_rejected',
        expect.objectContaining({ status: 503, reason: 'plugin restoring', route: 'send-sms' }),
      );
    });

    it('accepts, persists and enqueues a delivery of a route without a response contract', async () => {
      const d = depsWith({ restorePending: jest.fn().mockReturnValue(true) });

      const res = await new IngressService(d).handle(baseReq);

      expect(res.status).toBe(202);
      expect(d.events.recordOrSkip).toHaveBeenCalledTimes(1);
      expect(d.enqueue).toHaveBeenCalledTimes(1);
      expect(d.log).not.toHaveBeenCalled();
    });

    it('persists and acks a delivery but does not dispatch it while dispatch has to wait', async () => {
      const deferDispatch = jest.fn().mockReturnValue(true);
      const d = depsWith({ restorePending: jest.fn().mockReturnValue(true), deferDispatch });

      const res = await new IngressService(d).handle(baseReq);

      expect(res.status).toBe(202);
      expect(deferDispatch).toHaveBeenCalledWith('p');
      expect(d.events.recordOrSkip).toHaveBeenCalledTimes(1);
      expect(d.enqueue).not.toHaveBeenCalled();
    });

    it('dispatches as usual when dispatch need not wait', async () => {
      const d = depsWith({ deferDispatch: jest.fn().mockReturnValue(false) });

      await new IngressService(d).handle(baseReq);

      expect(d.enqueue).toHaveBeenCalledTimes(1);
    });

    it('accepts a route that declares a response contract once the restore is done with the plugin', async () => {
      const d = depsWith({ restorePending: jest.fn().mockReturnValue(false), manifestRoute: answeringRoute() });

      const res = await new IngressService(d).handle(baseReq);

      expect(res.status).toBe(204);
      expect(d.events.recordOrSkip).toHaveBeenCalledTimes(1);
      expect(d.enqueue).toHaveBeenCalledTimes(1);
    });

    it('still answers a failed signature with 401, so an unauthenticated caller learns nothing', async () => {
      const d = depsWith({
        restorePending: jest.fn().mockReturnValue(true),
        manifestRoute: jest.fn().mockReturnValue({
          route: 'send-sms',
          maxBodyBytes: 1024,
          signature: { scheme: 'hmac-sha256', header: 'x-sig' },
          response: { ack: { status: 204 } },
        }),
      });

      const res = await new IngressService(d).handle({ ...baseReq, headers: { 'x-sig': 'sha256=bad' } });

      expect(res.status).toBe(401);
    });

    it('charges the bucket before it refuses, so a signed provider that keeps retrying is still bounded', async () => {
      const admitInstance = jest.fn().mockResolvedValue({ ok: false, headers: { 'Retry-After': '7' } });
      const d = depsWith({
        restorePending: jest.fn().mockReturnValue(true),
        manifestRoute: answeringRoute(),
        admitInstance,
      });

      const res = await new IngressService(d).handle(baseReq);

      expect(res.status).toBe(429);
      expect(admitInstance).toHaveBeenCalledTimes(1);
    });
  });

  it('renders a declared ack status/body/headers', async () => {
    const d = depsWith({
      manifestRoute: jest.fn().mockReturnValue({
        route: 'send-sms',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: 1024,
        signature: { scheme: 'none' },
        dedupHeader: 'x-delivery',
        response: { ack: { status: 200, body: '{"ok":true}', headers: { 'content-type': 'application/json' } } },
      }),
    });
    const res = await new IngressService(d).handle(baseReq);
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    expect(res.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('returns the ack for a response route WITHOUT awaiting a slow enqueue', async () => {
    let resolveEnqueue: () => void;
    const enqueuePromise = new Promise<unknown>(resolve => {
      // Promise resolve requires an argument; wrap it so resolveEnqueue stays a 0-arg () => void.
      resolveEnqueue = () => resolve(undefined);
    });
    const d = depsWith({
      enqueue: jest.fn().mockReturnValue(enqueuePromise),
      manifestRoute: jest.fn().mockReturnValue({
        route: 'send-sms',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: 1024,
        signature: { scheme: 'none' },
        dedupHeader: 'x-delivery',
        response: { ack: { status: 200 } },
      }),
    });
    const res = await new IngressService(d).handle(baseReq);
    expect(res.status).toBe(200); // ack returned before enqueue resolved
    expect(d.enqueue).toHaveBeenCalled();
    resolveEnqueue!();
  });

  it('survives a rejecting enqueue on a response route (defensive .catch, no unhandled rejection)', async () => {
    const d = depsWith({
      log: jest.fn(),
      enqueue: jest.fn().mockRejectedValue(new Error('boom')),
      manifestRoute: jest.fn().mockReturnValue({
        route: 'send-sms',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: 1024,
        signature: { scheme: 'none' },
        dedupHeader: 'x-delivery',
        response: { ack: { status: 200 } },
      }),
    });
    const res = await new IngressService(d).handle(baseReq);
    expect(res.status).toBe(200); // ack returned despite the rejected enqueue
    // The rejected enqueue is caught + logged, not thrown. Flush microtasks so the .catch handler runs.
    await new Promise(resolve => setImmediate(resolve));
    expect(d.log).toHaveBeenCalledWith(
      'ingress_enqueue_unhandled',
      expect.objectContaining({ deliveryId: 'd1', error: 'boom' }),
    );
  });

  it('answers a re-delivery with the same ack as the first delivery', async () => {
    // The whole point of dedup is that a retry is indistinguishable. A route declaring a 204 used to
    // answer a bare 204 first and a 200 text/plain 'duplicate' on the retry, which a provider that
    // validates the ack rejects on the exact path dedup exists for.
    const route = {
      route: 'send-sms',
      mode: 'async',
      verify: 'core',
      maxBodyBytes: 1024,
      signature: { scheme: 'none' },
      dedupHeader: 'x-delivery',
      response: { ack: { status: 204, headers: { 'content-type': 'application/json' } } },
    };
    const first = await new IngressService(depsWith({ manifestRoute: jest.fn().mockReturnValue(route) })).handle(
      baseReq,
    );
    const dup = depsWith({
      events: { recordOrSkip: jest.fn().mockResolvedValue(false) },
      manifestRoute: jest.fn().mockReturnValue(route),
    });
    const retry = await new IngressService(dup).handle(baseReq);

    expect(first).toEqual({ status: 204, headers: { 'content-type': 'application/json' } });
    expect(retry).toEqual(first);
    expect(dup.enqueue).not.toHaveBeenCalled();
  });
});

describe('IngressService per-instance rate bucket', () => {
  const post = (overrides: Record<string, unknown> = {}) => ({
    pluginId: 'chatwoot',
    instanceId: 'acct1',
    route: 'chatwoot',
    method: 'POST',
    headers: { 'x-delivery': 'd1' } as Record<string, string>,
    query: {} as Record<string, string>,
    rawBody: '{}',
    ...overrides,
  });
  const admitted = {
    ok: true,
    headers: { 'X-RateLimit-Limit-instance': '120', 'X-RateLimit-Remaining-instance': '119' },
  };
  const blocked = { ok: false, headers: { 'Retry-After-instance': '7', 'Retry-After': '7' } };

  it.each([
    ['an unknown instance', { instances: { resolve: jest.fn().mockResolvedValue(null) } }, post(), 404],
    ['an unknown route', { manifestRoute: jest.fn().mockReturnValue(undefined) }, post(), 404],
    ['an oversized body', {}, post({ rawBody: 'x'.repeat(2048) }), 413],
    [
      'a failed signature',
      {
        manifestRoute: jest.fn().mockReturnValue({
          route: 'chatwoot',
          maxBodyBytes: 1024,
          signature: { scheme: 'hmac-sha256', header: 'x-sig' },
        }),
      },
      post({ headers: { 'x-sig': 'sha256=bad' } }),
      401,
    ],
    [
      'a GET challenge',
      {
        manifestRoute: jest.fn().mockReturnValue({
          route: 'chatwoot',
          maxBodyBytes: 1024,
          signature: { scheme: 'none' },
          challenge: { tokenParam: 'hub.verify_token', echoParam: 'hub.challenge' },
        }),
      },
      post({ method: 'GET', query: { 'hub.verify_token': 'wrong' } }),
      403,
    ],
  ])('does not charge the bucket for %s', async (_label, overrides, req, status) => {
    const admitInstance = jest.fn().mockResolvedValue(blocked);
    const svc = new IngressService(deps({ ...overrides, admitInstance }));
    const res = await svc.handle(req);
    expect(res.status).toBe(status);
    expect(admitInstance).not.toHaveBeenCalled();
  });

  it('charges a verified delivery once and sheds it with the throttler 429 when the bucket is full', async () => {
    const admitInstance = jest.fn().mockResolvedValue(blocked);
    const d = deps({ admitInstance });
    const res = await new IngressService(d).handle(post());
    expect(admitInstance).toHaveBeenCalledTimes(1);
    expect(admitInstance).toHaveBeenCalledWith('chatwoot', 'acct1');
    expect(res).toEqual({
      status: 429,
      body: JSON.stringify({ statusCode: 429, message: 'ThrottlerException: Too Many Requests' }),
      headers: { 'content-type': 'application/json', 'Retry-After-instance': '7', 'Retry-After': '7' },
    });
    expect(d.events.recordOrSkip).not.toHaveBeenCalled();
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it('charges before the session-alive preflight, so a full bucket answers 429 rather than 503', async () => {
    const admitInstance = jest.fn().mockResolvedValue(blocked);
    const svc = new IngressService(
      deps({
        admitInstance,
        sessionStatus: () => undefined,
        manifestRoute: jest.fn().mockReturnValue({
          route: 'chatwoot',
          maxBodyBytes: 1024,
          signature: { scheme: 'none' },
          response: { preflight: [{ type: 'session-alive' }], ack: { status: 200 } },
        }),
      }),
    );
    await expect(svc.handle(post())).resolves.toMatchObject({ status: 429 });
  });

  it.each([
    ['a new delivery', true],
    ['a re-delivery', false],
  ])('adds the rate headers to the ack of %s', async (_label, isNew) => {
    const d = deps({ admitInstance: jest.fn().mockResolvedValue(admitted) });
    d.events.recordOrSkip = jest.fn().mockResolvedValue(isNew);
    const res = await new IngressService(d).handle(post());
    expect(res.status).toBe(202);
    expect(res.headers).toEqual(admitted.headers);
  });
});
