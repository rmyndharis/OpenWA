import { randomUUID } from 'node:crypto';
import { verifyIngressSignature } from './ingress-signature';
import { PluginIngressRoute } from '../../core/plugins/plugin.interfaces';
import { IngressJobData } from '../queue/processors/ingress.processor';

export interface IngressRequest {
  pluginId: string;
  instanceId: string;
  route: string;
  method: string;
  headers: Record<string, string>; // lower-cased keys
  query: Record<string, string>;
  rawBody: string;
}

export interface ResolvedInstance {
  id: string;
  pluginId: string;
  instanceId: string;
  secret: string;
  enabled: boolean;
  sessionScope: string | null;
  verifyToken: string | null;
}

// The manifest route, possibly with the dedup header surfaced at the top level. On the real manifest
// dedupHeader lives under `signature`; the resolver may lift it, so read both (top level wins).
export type IngressRouteDescriptor = PluginIngressRoute & { dedupHeader?: string };

export interface IngressDeps {
  instances: { resolve(pluginId: string, instanceId: string): Promise<ResolvedInstance | null> };
  manifestRoute: (pluginId: string, route: string) => IngressRouteDescriptor | undefined;
  events: {
    recordOrSkip(input: {
      instanceId: string;
      pluginId: string;
      providerDeliveryId: string;
      route: string;
      payload: { headers: Record<string, string>; query: Record<string, string>; body: string; rawBody: string };
      sessionId: string | null;
    }): Promise<boolean>;
  };
  enqueue: (data: IngressJobData, jobId: string) => Promise<void>;
  now: () => number;
}

/**
 * The fast-ack ingress pipeline. Pure orchestration over injected deps so it is unit-testable without
 * Nest DI: resolve the instance → answer a GET challenge host-side → size cap → verify over the RAW
 * body → dedup (persist-before-ack) → best-effort conversation id → enqueue (or inline) → 202.
 */
export class IngressService {
  constructor(private readonly deps: IngressDeps) {}

  async handle(req: IngressRequest): Promise<{ status: number; body?: string }> {
    const instance = await this.deps.instances.resolve(req.pluginId, req.instanceId);
    if (!instance || !instance.enabled) return { status: 404, body: 'unknown instance' };

    const route = this.deps.manifestRoute(req.pluginId, req.route);
    if (!route) return { status: 404, body: 'unknown route' };

    // GET challenge handshake (e.g. Meta hub.challenge), answered host-side without the worker. The
    // token is compared against the instance's minted verifyToken.
    if (req.method === 'GET' && route.challenge) {
      const token = req.query[route.challenge.tokenParam];
      const echo = req.query[route.challenge.echoParam];
      if (token && instance.verifyToken && token === instance.verifyToken) return { status: 200, body: echo ?? '' };
      return { status: 403, body: 'challenge failed' };
    }

    if (Buffer.byteLength(req.rawBody, 'utf8') > route.maxBodyBytes) return { status: 413, body: 'payload too large' };

    const verdict = verifyIngressSignature(route.signature, {
      rawBody: req.rawBody,
      headers: req.headers,
      secret: instance.secret,
      now: this.deps.now(),
    });
    if (!verdict.ok) return { status: 401, body: verdict.reason ?? 'signature verification failed' };

    const dedupHeader = (route.dedupHeader ?? route.signature.dedupHeader ?? 'x-delivery').toLowerCase();
    const deliveryId = req.headers[dedupHeader] ?? randomUUID();
    const payload = { headers: req.headers, query: req.query, body: req.rawBody, rawBody: req.rawBody };
    const isNew = await this.deps.events.recordOrSkip({
      instanceId: req.instanceId,
      pluginId: req.pluginId,
      providerDeliveryId: deliveryId,
      route: req.route,
      payload,
      sessionId: instance.sessionScope,
    });
    if (!isNew) return { status: 200, body: 'duplicate' }; // already persisted/acked

    // Best-effort conversation id for P1 ordering. Never throws — a malformed body just yields undefined.
    const providerConversationId = extractConversationId(route.conversationId, req.headers, req.rawBody);

    await this.deps.enqueue(
      {
        pluginId: req.pluginId,
        instanceId: req.instanceId,
        route: req.route,
        deliveryId,
        sessionId: instance.sessionScope ?? undefined,
        providerConversationId,
        payload,
      },
      deliveryId,
    );
    return { status: 202, body: 'accepted' };
  }
}

/**
 * Extracts the provider conversation id from a declared header or a JSON pointer into the body.
 * Returns undefined when no pointer is declared or extraction fails — the P1 lock then keys per
 * instance. Pure and total: never throws on a malformed body.
 */
export function extractConversationId(
  spec: { header?: string; jsonPointer?: string } | undefined,
  headers: Record<string, string>,
  rawBody: string,
): string | undefined {
  if (!spec) return undefined;
  if (spec.header) {
    const v = headers[spec.header.toLowerCase()];
    if (v) return v;
  }
  if (spec.jsonPointer) {
    try {
      let node: unknown = JSON.parse(rawBody);
      for (const seg of spec.jsonPointer.split('/').filter(Boolean)) {
        node = (node as Record<string, unknown>)?.[seg];
      }
      // Only a scalar is a usable conversation key — an object/array would stringify to junk.
      if (typeof node === 'string') return node;
      if (typeof node === 'number' || typeof node === 'boolean') return String(node);
    } catch {
      return undefined; // malformed body → no key, per-instance ordering
    }
  }
  return undefined;
}
