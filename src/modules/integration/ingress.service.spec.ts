import { IngressService, extractConversationId } from './ingress.service';
import { EngineStatus } from '../../engine/interfaces/whatsapp-engine.interface';

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
    expect(d.enqueue).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'd1' }), 'd1');
    expect(res.status).toBe(202);
  });

  it('short-circuits a duplicate delivery with 200 and no enqueue', async () => {
    const d = deps({ events: { recordOrSkip: jest.fn().mockResolvedValue(false) } });
    const svc = new IngressService(d);
    const res = await svc.handle(req);
    expect(d.enqueue).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
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

  it('keeps the duplicate path as 200 "duplicate" regardless of a declared ack', async () => {
    const d = depsWith({
      events: { recordOrSkip: jest.fn().mockResolvedValue(false) },
      manifestRoute: jest.fn().mockReturnValue({
        route: 'send-sms',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: 1024,
        signature: { scheme: 'none' },
        dedupHeader: 'x-delivery',
        response: { ack: { status: 200, body: '{"ok":true}' } },
      }),
    });
    const res = await new IngressService(d).handle(baseReq);
    expect(res.status).toBe(200);
    expect(res.body).toBe('duplicate');
    expect(d.enqueue).not.toHaveBeenCalled();
  });
});
