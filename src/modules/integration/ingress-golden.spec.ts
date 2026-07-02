import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IngressService, IngressDeps } from './ingress.service';

// This wires the real IngressService + verifier + a fake dedup/enqueue + a fake loader to prove the
// whole SDK v1 contract: a signed Chatwoot delivery flows to a conversation.send. It is the frozen
// executable spec — a break here means the wire ABI changed. Chatwoot account-level webhooks sign
// `sha256=HMAC(secret, "{timestamp}.{rawBody}")` and send an X-Chatwoot-Timestamp header, so the golden
// exercises exactly that scheme (not a bare-body HMAC) and asserts the replay window is enforced.
describe('Integration SDK v1 golden contract — Chatwoot message_created', () => {
  const secret = randomBytes(32).toString('hex');
  // Read the RAW bytes from disk — the HMAC must be computed over exactly what a provider would sign,
  // not a re-serialized object (JSON.stringify(JSON.parse(raw)) is not guaranteed byte-identical).
  const raw = readFileSync(join(__dirname, '__fixtures__/chatwoot-message_created.json'), 'utf8');
  // Fixed epoch (seconds) so the replay-window check is deterministic; `now` is injected to match.
  const ts = 1700000000;
  const sign = (t: number) => 'sha256=' + createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  const sig = sign(ts);

  const manifestRoute = () => ({
    route: 'chatwoot',
    mode: 'async' as const,
    verify: 'core' as const,
    maxBodyBytes: 262144,
    signature: {
      scheme: 'hmac-sha256' as const,
      header: 'X-Chatwoot-Signature',
      contentTemplate: '{timestamp}.{rawBody}',
      encoding: 'hex' as const,
      prefix: 'sha256=',
      timestampHeader: 'X-Chatwoot-Timestamp',
      toleranceSec: 300,
    },
    dedupHeader: 'x-chatwoot-delivery',
  });

  const resolveInstance = () =>
    Promise.resolve({
      id: 'chatwoot:acct1',
      pluginId: 'chatwoot',
      instanceId: 'acct1',
      secret,
      enabled: true,
      sessionScope: 'sess-1',
      verifyToken: null,
    });

  interface ChatwootFixtureBody {
    message_type: string;
    private: boolean;
    content: string;
  }

  it('verifies the signature, dedups, enqueues, and the dispatched handler sends to WhatsApp', async () => {
    const dispatched: unknown[] = [];
    const enqueued: unknown[] = [];
    // Simulate the worker handler + conversation.send by resolving the mapping and calling sendText.
    const sentToWhatsApp: unknown[] = [];
    const fakeLoaderDispatch = (data: { payload: { rawBody: string } }) => {
      const body = JSON.parse(data.payload.rawBody) as ChatwootFixtureBody;
      if (body.message_type === 'outgoing' && !body.private) {
        sentToWhatsApp.push({ chatId: 'chat@c.us', text: body.content });
      }
    };

    const deps: IngressDeps = {
      instances: { resolve: resolveInstance },
      manifestRoute,
      events: {
        recordOrSkip: () => {
          enqueued.push('recorded');
          return Promise.resolve(true);
        },
      },
      enqueue: (data, jobId) => {
        enqueued.push({ data, jobId });
        fakeLoaderDispatch(data);
        dispatched.push(jobId);
        return Promise.resolve();
      },
      now: () => ts * 1000,
    };
    const svc = new IngressService(deps);

    const res = await svc.handle({
      pluginId: 'chatwoot',
      instanceId: 'acct1',
      route: 'chatwoot',
      method: 'POST',
      headers: {
        'x-chatwoot-signature': sig,
        'x-chatwoot-timestamp': String(ts),
        'x-chatwoot-delivery': 'delivery-1',
      },
      query: {},
      rawBody: raw,
    });

    expect(res.status).toBe(202);
    expect(dispatched).toEqual(['delivery-1']);
    expect(sentToWhatsApp).toEqual([{ chatId: 'chat@c.us', text: 'Hello from a human agent' }]);
  });

  it('rejects the same fixture with a wrong signature (401) and never dispatches', async () => {
    const dispatched: unknown[] = [];
    const deps: IngressDeps = {
      instances: { resolve: resolveInstance },
      manifestRoute,
      events: { recordOrSkip: () => Promise.resolve(true) },
      enqueue: (_data, jobId) => {
        dispatched.push(jobId);
        return Promise.resolve();
      },
      now: () => ts * 1000,
    };
    const svc = new IngressService(deps);

    const res = await svc.handle({
      pluginId: 'chatwoot',
      instanceId: 'acct1',
      route: 'chatwoot',
      method: 'POST',
      headers: {
        'x-chatwoot-signature': 'sha256=deadbeef',
        'x-chatwoot-timestamp': String(ts),
        'x-chatwoot-delivery': 'delivery-2',
      },
      query: {},
      rawBody: raw,
    });

    expect(res.status).toBe(401);
    expect(dispatched).toEqual([]);
  });

  it('rejects a stale (replayed) timestamp beyond tolerance (401) and never dispatches', async () => {
    const staleTs = ts - 3600; // signed correctly but an hour old — well beyond the 300s window
    const dispatched: unknown[] = [];
    const deps: IngressDeps = {
      instances: { resolve: resolveInstance },
      manifestRoute,
      events: { recordOrSkip: () => Promise.resolve(true) },
      enqueue: (_data, jobId) => {
        dispatched.push(jobId);
        return Promise.resolve();
      },
      now: () => ts * 1000,
    };
    const svc = new IngressService(deps);

    const res = await svc.handle({
      pluginId: 'chatwoot',
      instanceId: 'acct1',
      route: 'chatwoot',
      method: 'POST',
      headers: {
        'x-chatwoot-signature': sign(staleTs),
        'x-chatwoot-timestamp': String(staleTs),
        'x-chatwoot-delivery': 'delivery-3',
      },
      query: {},
      rawBody: raw,
    });

    expect(res.status).toBe(401);
    expect(dispatched).toEqual([]);
  });
});
