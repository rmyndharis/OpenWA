import { createHash } from 'node:crypto';
import { safeEqualStr, verifyIngressSignature } from './ingress-signature';
import { PluginIngressRoute } from '../../core/plugins/plugin.interfaces';
import { IngressJobData } from '../queue/processors/ingress.processor';
import type { EngineStatus } from '../../engine/interfaces/whatsapp-engine.interface';
import { evaluatePreflight } from './ingress-preflight';
import { renderAck } from './ingress-ack';
import { parseBodyLimitBytes } from '../../config/inflight-body-budget';
import { resolveBodyLimit } from '../../config/bootstrap-security';
import { createLogger } from '../../common/services/logger.service';

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
      payloadHash: string;
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
  private readonly logger = createLogger('IngressService');

  constructor(private readonly deps: IngressDeps) {}

  /**
   * The cap to apply when a manifest route declares none. Warned once per route so an incomplete
   * manifest is visible to the operator rather than silently degrading to the global limit.
   */
  private readonly warnedMissingCap = new Set<string>();

  private fallbackMaxBodyBytes(pluginId: string, route: string): number {
    const key = `${pluginId}:${route}`;
    if (!this.warnedMissingCap.has(key)) {
      this.warnedMissingCap.add(key);
      this.logger.warn(
        `Ingress route ${key} declares no usable maxBodyBytes; falling back to the process body limit. ` +
          'Set a per-route maxBodyBytes in the plugin manifest.',
      );
    }
    return parseBodyLimitBytes(resolveBodyLimit(process.env.BODY_SIZE_LIMIT));
  }

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

    // `n > undefined` is always false, so a manifest that omits maxBodyBytes — or carries a
    // non-numeric or non-positive value — left this check inert: the 413 the published contract
    // promises never fired, and every accepted delivery is persisted with the body stored twice
    // (payload.body and payload.rawBody) and carried into the queue. A third-party adapter forgetting
    // one field turned its route into a write amplifier with no load-time error and no runtime signal.
    //
    // The fallback is the process-wide body limit, which is what such a route was already bounded by
    // in practice, so no delivery that is accepted today starts failing. What changes is that the
    // check can no longer be vacuous, and the gap is now stated in the log instead of being silent.
    // A manifest is third-party JSON with no runtime validation, so the field is only a `number` by
    // declaration. The `>` this replaced COERCED, which means a quoted number ("1024") enforced a real
    // cap — rejecting it as "unusable" would swap that for the far larger process-wide fallback. And
    // 0 is a cap, not a missing value: it admits the empty body a verification callback sends and
    // nothing else. Only a value that cannot express a limit at all falls back.
    const declaredCap: unknown = route.maxBodyBytes;
    const parsedCap =
      typeof declaredCap === 'number'
        ? declaredCap
        : typeof declaredCap === 'string' && declaredCap.trim() !== ''
          ? Number(declaredCap)
          : Number.NaN;
    const effectiveCap =
      Number.isFinite(parsedCap) && parsedCap >= 0 ? parsedCap : this.fallbackMaxBodyBytes(req.pluginId, route.route);
    if (Buffer.byteLength(req.rawBody, 'utf8') > effectiveCap) return { status: 413, body: 'payload too large' };

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
      // Returned whole, so a rejection's headers reach the wire. Re-packing the two fields dropped the
      // Retry-After that decides whether the provider retries at all.
      return preflight;
    }

    // Standard Webhooks signs and requires webhook-id, so it is the stable, authenticated retry id.
    // Other schemes retain the existing x-delivery/body-hash behavior for compatibility.
    const defaultDedupHeader = route.signature.scheme === 'standard-webhooks' ? 'webhook-id' : 'x-delivery';
    const dedupHeader = (route.dedupHeader ?? route.signature.dedupHeader ?? defaultDedupHeader).toLowerCase();
    // A route that declares dedupOn: 'body' keys retries on the raw body: its provider mints a fresh
    // delivery id per attempt, so trusting the header would let every retry through as new.
    //
    // A header that is present but blank is no id at all, and it used to be taken as one: every
    // delivery then shared the empty key, so the dedup row admitted the first and dropped the rest
    // while answering each provider with the route's success ack. Nothing was enqueued, nothing was
    // dead-lettered, and the deliveries were simply gone. Fall through to the body hash, which is
    // exactly the "provider supplied no id" case it already exists for.
    const headerId = req.headers[dedupHeader]?.trim();
    const deliveryId = route.dedupOn === 'body' || !headerId ? deriveDeliveryId(req) : headerId;
    // Provider request headers persist with the event (redrive/debugging); credentials must not.
    // Signature headers are re-derivable, auth material is not — redact before the first write.
    // A shared-secret route carries the instance secret itself in its declared header.
    const payload = {
      headers: redactSensitiveHeaders(
        req.headers,
        route.signature.scheme === 'shared-secret' ? route.signature.header : undefined,
      ),
      query: req.query,
      body: req.rawBody,
      rawBody: req.rawBody,
    };
    // Rendered BEFORE the dedup check so a provider retry gets the byte-identical ack rather than a
    // second contract on the same route. The ctx is the request in hand (rawBody, deliveryId, now),
    // never stored state, which is what makes rendering it on a dedup hit sound: an ack field that had
    // to reflect the PERSISTED row would echo the retry's values as the original's. Keep it that way.
    const ack = renderAck(route.response?.ack, {
      rawBody: req.rawBody,
      timestamp: String(Math.floor(this.deps.now() / 1000)),
      id: deliveryId,
    });

    const isNew = await this.deps.events.recordOrSkip({
      instanceId: req.instanceId,
      pluginId: req.pluginId,
      providerDeliveryId: deliveryId,
      route: req.route,
      payload,
      // The slim content fingerprint kept after the payload is retired on dispatch (see the entity).
      payloadHash: createHash('sha256').update(req.rawBody).digest('hex'),
      sessionId: instance.sessionScope,
    });
    if (!isNew) return ack; // already persisted/acked; a retry gets the first delivery's ack

    // Best-effort conversation id for P1 ordering. Never throws — a malformed body just yields undefined.
    const providerConversationId = extractConversationId(route.conversationId, req.headers, req.rawBody);

    const jobData: IngressJobData = {
      pluginId: req.pluginId,
      instanceId: req.instanceId,
      route: req.route,
      method: req.method,
      deliveryId,
      sessionId: instance.sessionScope ?? undefined,
      providerConversationId,
      payload,
    };

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

/**
 * Header names whose VALUES must never reach the persisted event payload: bearer/basic
 * credentials, cookies, and the provider signature headers (recomputable from the raw body, and
 * useless for redrive — the retry re-signs). The names survive so operators can still see WHICH
 * scheme the provider used.
 */
const SENSITIVE_INGRESS_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-hub-signature',
  'x-hub-signature-256',
  'x-signature',
  'x-signature-ed25519',
  'x-webhook-signature',
]);

export function redactSensitiveHeaders(
  headers: Record<string, string>,
  credentialHeader?: string,
): Record<string, string> {
  const extra = credentialHeader?.toLowerCase();
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    out[name] = SENSITIVE_INGRESS_HEADERS.has(lower) || lower === extra ? '[redacted]' : value;
  }
  return out;
}
