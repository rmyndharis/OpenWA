import { createHash } from 'node:crypto';
import { safeEqualStr, verifyIngressSignature } from './ingress-signature';
import { PluginIngressRoute } from '../../core/plugins/plugin.interfaces';
import { IngressJobData } from '../queue/processors/ingress.processor';
import type { EngineStatus } from '../../engine/interfaces/whatsapp-engine.interface';
import { evaluatePreflight } from './ingress-preflight';
import { renderAck } from './ingress-ack';

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
  // Returns an enqueue outcome (queued/dispatched/failed); handle() ignores it — only durability
  // follow-up paths like redrive act on it. Typed as unknown here to keep this pure module decoupled.
  enqueue: (data: IngressJobData, jobId: string) => Promise<unknown>;
  // Optional host-side session-liveness probe for the `session-alive` preflight: returns the in-memory
  // EngineStatus for a concrete session scope, or undefined when no engine is live. O(1) (a Map read +
  // field read); MUST NOT call engine.initialize() or any blocking call. Absent (pure unit tests) → the
  // session-alive check skips (passes) rather than false-rejecting.
  sessionStatus?: (scope: string) => EngineStatus | undefined;
  // Optional structured sink for preflight rejections, so operators can audit deliveries that were
  // rejected host-side (and therefore leave no dedup/DLQ row). Absent in pure unit tests.
  log?: (event: string, meta: Record<string, unknown>) => void;
  now: () => number;
}

/**
 * The fast-ack ingress pipeline. Pure orchestration over injected deps so it is unit-testable without
 * Nest DI: resolve the instance → answer a GET challenge host-side → size cap → verify over the RAW
 * body → dedup (persist-before-ack) → best-effort conversation id → enqueue (or inline) → 202.
 */
export class IngressService {
  constructor(private readonly deps: IngressDeps) {}

  async handle(req: IngressRequest): Promise<{ status: number; body?: string; headers?: Record<string, string> }> {
    const instance = await this.deps.instances.resolve(req.pluginId, req.instanceId);
    if (!instance || !instance.enabled) return { status: 404, body: 'unknown instance' };

    const route = this.deps.manifestRoute(req.pluginId, req.route);
    if (!route) return { status: 404, body: 'unknown route' };

    // GET challenge handshake (e.g. Meta hub.challenge), answered host-side without the worker. The
    // token is compared against the instance's minted verifyToken.
    if (req.method === 'GET' && route.challenge) {
      const token = req.query[route.challenge.tokenParam];
      const echo = req.query[route.challenge.echoParam];
      // Constant-time compare (mirrors the signature path) so the verify token can't be probed by timing.
      if (token && instance.verifyToken && safeEqualStr(token, instance.verifyToken)) {
        return { status: 200, body: echo ?? '' };
      }
      return { status: 403, body: 'challenge failed' };
    }

    if (Buffer.byteLength(req.rawBody, 'utf8') > route.maxBodyBytes) return { status: 413, body: 'payload too large' };

    const verdict = verifyIngressSignature(route.signature, {
      rawBody: req.rawBody,
      headers: req.headers,
      secret: instance.secret,
      now: this.deps.now(),
      instanceId: req.instanceId,
    });
    if (!verdict.ok) return { status: 401, body: verdict.reason ?? 'signature verification failed' };

    // Host-side preflight (e.g. session-alive). AFTER signature verify (so an unauthenticated caller
    // cannot probe liveness) and BEFORE the dedup persist (so a 5xx-rejected delivery never writes a
    // dedup row that would swallow the provider's retry as a 200 'duplicate' — the dedup trap). A
    // rejection leaves no dedup/DLQ row, so log it for operator audit.
    const preflight = evaluatePreflight(route, instance.sessionScope, this.deps.sessionStatus);
    if (preflight) {
      this.deps.log?.('ingress_preflight_rejected', {
        pluginId: req.pluginId,
        instanceId: req.instanceId,
        route: req.route,
        status: preflight.status,
        sessionScope: instance.sessionScope,
      });
      return { status: preflight.status, body: preflight.body };
    }

    const dedupHeader = (route.dedupHeader ?? route.signature.dedupHeader ?? 'x-delivery').toLowerCase();
    const deliveryId = req.headers[dedupHeader] ?? deriveDeliveryId(req);
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

    const jobData: IngressJobData = {
      pluginId: req.pluginId,
      instanceId: req.instanceId,
      route: req.route,
      deliveryId,
      sessionId: instance.sessionScope ?? undefined,
      providerConversationId,
      payload,
    };

    const ack = renderAck(route.response?.ack, {
      rawBody: req.rawBody,
      timestamp: String(Math.floor(this.deps.now() / 1000)),
      id: deliveryId,
    });

    if (route.response) {
      // Sync-response route: the ack is host-side and final; enqueue (queued or inline) must NOT block
      // it — a queue-disabled deployment otherwise holds the HTTP response for up to the inline dispatch
      // timeout. enqueue() is not awaited; the dedup row already persisted is the durability handle. The
      // .catch() is a defensive guard: enqueue() never rejects today (it swallows inline failures and the
      // factory wrapper writes a DLQ row on 'failed'), but a future regression must not become an unhandled
      // rejection that crashes the process on the ingress hot path.
      void this.deps.enqueue(jobData, deliveryId).catch(err => {
        this.deps.log?.('ingress_enqueue_unhandled', {
          pluginId: req.pluginId,
          instanceId: req.instanceId,
          deliveryId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } else {
      await this.deps.enqueue(jobData, deliveryId);
    }
    return ack;
  }
}

/**
 * Derives a DETERMINISTIC delivery id when the provider sends no dedup header, so a provider retry of
 * the same delivery dedups instead of being treated as new. A random UUID would silently disable both
 * the persist-dedup and BullMQ's jobId idempotency, causing duplicate downstream WhatsApp sends. Keyed
 * on pluginId + instanceId + route + rawBody ONLY — never a server timestamp, which would defeat dedup.
 */
function deriveDeliveryId(req: IngressRequest): string {
  return createHash('sha256').update([req.pluginId, req.instanceId, req.route, req.rawBody].join('\0')).digest('hex');
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
