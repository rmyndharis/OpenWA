import { Injectable, Optional, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { setTimeout } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Webhook } from './entities/webhook.entity';
import { WebhookOutboxService, type ReplayableDelivery } from './webhook-outbox.service';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { clearDeliveryFailureRows, recordWebhookDeliveryFailure } from './utils/record-delivery-failure';
import {
  buildDeliveryHeaders,
  isDeliverableWebhook,
  postWebhookPayload,
  recordTerminalFailure,
} from './utils/deliver-once';
import { createLogger } from '../../common/services/logger.service';
import { DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS } from '../../common/services/shutdown-budget';
import { DEFAULT_WEBHOOK_MEDIA_INLINE_MAX_BYTES, shedInlineMedia } from '../../common/utils/inline-media';
import { incrementWebhookDeliveryFailures } from '../../common/metrics/webhook-delivery-metrics';
import { QUEUE_NAMES } from '../queue/queue-names';
import { producerReady } from '../queue/redis-connection';
import { generateIdempotencyKey, generateDeliveryId } from './utils/idempotency.util';
import { evaluateFilters, prepareFilterLidResolver } from './filters/filter-evaluator';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { redactSsrfError } from '../../common/security/ssrf-guard';
import { HookManager } from '../../core/hooks';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { isWebhookBeforeResult } from '../../core/hooks/hook-results';
import { WILDCARD_EXCLUDED_EVENTS, subscriptionCoversEvent } from '../../common/utils/wildcard-events';

export interface WebhookPayload {
  event: string;
  timestamp: string;
  sessionId: string;
  idempotencyKey: string;
  deliveryId: string;
  data: Record<string, unknown>;
}

export interface WebhookJobData {
  webhookId: string;
  url: string;
  event: string;
  payload: WebhookPayload;
  attempt: number;
  maxRetries: number;
  /**
   * The pre-`webhook:before` event data, carried only while WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS
   * > 0 so the processor's terminal failure row can keep it for a redrive. `payload.data` is the
   * post-hook body and must not be replayed: the redrive runs the hooks again. Bounded like `payload`
   * (inline media over WEBHOOK_MEDIA_INLINE_MAX_BYTES was shed before it was captured).
   */
  replayData?: Record<string, unknown>;
}

/**
 * Upper bound on the serialized webhook body after webhook:before hooks ran. Hook results are
 * untrusted — an unbounded mutation (or a genuinely huge media event) would POST a giant body and,
 * on failure, bloat the durable failure path. Oversize payloads are recorded as undelivered instead.
 * Default 1 MiB; override with WEBHOOK_MAX_PAYLOAD_BYTES.
 */
const DEFAULT_WEBHOOK_MAX_PAYLOAD_BYTES = 1024 * 1024;

// Decoded-byte cap for inline base64 media and the shed helper live in common/utils/inline-media:
// the WebSocket gateway sheds message-event payloads with the SAME cap and marker, so the two
// outbound sinks stay one contract.

/**
 * How long shutdown waits for in-flight direct deliveries (and their dead-letter bookkeeping) to
 * finish before abandoning them, and for an outbox replay in flight. Default 5s; override with
 * WEBHOOK_SHUTDOWN_DRAIN_MS. Defined in shutdown-budget.ts, which sizes the kill deadline from it.
 */
export { DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS };

/**
 * How long a session's answer to "which opt-in events does an active webhook name" is reused. Writes
 * through WebhookService drop the answer at once on this node; a write on another instance (Redis
 * deployment), or one that bypasses WebhookService, is picked up when it expires.
 */
const OPT_IN_SUBSCRIPTIONS_TTL_MS = 5000;

/**
 * The result of one delivery attempt. Reported, not thrown: every delivery failure below is already
 * handled in place, so a try/catch cannot tell a delivered event from a dead-lettered one. Two
 * exceptions escape, both from shutdown, and both keep the outbox row pending: 'ConcurrencyLimiter
 * closed' from a retry backoff woken after it, which only runLimited sees and records, and the
 * AbortError of a replay whose signal stopped its retries or its queue fallback, which reaches
 * WebhookReconcilerService through redeliver.
 * 'cancelled' is terminal like 'delivered' and must never be replayed: either a plugin suppressed the
 * dispatch (nothing left the process), or a direct retry found the webhook removed, disabled or
 * unsubscribed (an earlier attempt may already have been POSTed).
 */
export type WebhookDeliveryOutcome = 'delivered' | 'enqueued' | 'cancelled' | 'failed' | 'unrecorded';

/** Per-event-occurrence context threaded through the dispatch pipeline stages (was closure state). */
interface DispatchEventContext {
  sessionId: string;
  event: string;
  baseData: Record<string, unknown>;
  /** Gives the dispatch slot up while `fn` runs (a retry backoff). Absent outside the limiter. */
  yieldSlot?: <R>(fn: () => Promise<R>) => Promise<R>;
  /**
   * Direct delivery makes one attempt instead of `webhook.retryCount`. Set by an operator redrive,
   * which runs inside an HTTP request: the in-process backoff schedule would hold it for minutes.
   */
  singleAttempt?: boolean;
  /**
   * Like `singleAttempt` for the direct path (the queue off, or the fallback for a failed enqueue), but
   * an enabled queue is still used. Set by the reconciler, which replays its backlog one row after
   * another: a retry schedule per row would hold every row behind an unreachable receiver for
   * minutes, and the next sweep is the retry.
   */
  oneDirectAttempt?: boolean;
  /**
   * Ends a replay's retry backoff early and gives no further attempt. A replay holds no dispatch
   * slot, so the shutdown drain's limiter close cannot stop it; its owner aborts this instead.
   */
  signal?: AbortSignal;
}

/** Per-delivery options of the direct path (deliverWebhook), derived from the dispatch context. */
interface DirectDeliveryOptions {
  yieldSlot?: <R>(fn: () => Promise<R>) => Promise<R>;
  /** Kept on the terminal failure row for a redrive; set only while payload retention is on. */
  replayData?: Record<string, unknown>;
  singleAttempt?: boolean;
  signal?: AbortSignal;
}

class UnrecordedWebhookFailure extends Error {}

/** The limiter refused or dropped the task because shutdown closed it. */
const isLimiterClosed = (error: unknown): boolean =>
  error instanceof Error && error.message === 'ConcurrencyLimiter closed';

/** The limiter refused the task because it already runs and queues as many as it admits. */
const isLimiterFull = (error: unknown): boolean =>
  error instanceof Error && error.message === 'ConcurrencyLimiter queue full';

/**
 * The stage one webhook's opt-in events pass (`webhookId` is null when the webhooks that name the event could
 * not be listed, and one stage then serves the whole session); `dropped` counts the events it turned away.
 */
interface OptInStage {
  stage: ConcurrencyLimiter;
  dropped: number;
  sessionId: string;
  webhookId: string | null;
}

const describeOptInStage = ({ sessionId, webhookId }: OptInStage): string =>
  webhookId === null ? `session ${sessionId}` : `webhook ${webhookId} of session ${sessionId}`;

/**
 * The replay's retries were stopped by its aborted signal, in a backoff or just before a retry POST.
 * A POST that fails after the abort is not this: on the last attempt it is a terminal failure and is
 * reported as one.
 */
export const isAbortedBackoff = (error: unknown, signal: AbortSignal | undefined): boolean =>
  // Matched by name: the AbortError comes from node:timers, so instanceof Error is realm-dependent.
  signal?.aborted === true && (error as Error | undefined)?.name === 'AbortError';

const isPlainObject = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The webhook delivery engine: given an event occurrence, fan it out to the session's matching
 * webhooks — bounded by the dispatch limiter — through the BullMQ queue when enabled (with a
 * direct-delivery fallback when enqueue fails) or through direct inline delivery when not.
 * Records failed and unsent deliveries in webhook_delivery_failures. Webhook registration/CRUD
 * lives on WebhookService, which delegates dispatch here.
 */
@Injectable()
export class WebhookDeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('WebhookDelivery');
  private readonly queueEnabled: boolean;
  private readonly dispatchLimiter: ConcurrencyLimiter;
  private readonly dispatchMaxQueued: number;
  /**
   * Webhooks whose last delivery attempt on this node failed, until one succeeds. In direct mode a
   * delivery to one of them first passes its session's gate in `degradedSessionGates`, which admits
   * at most `degradedSessionConcurrency` at a time, so one session's failing receivers cannot keep
   * filling the dispatch pool while healthy receivers keep all of it. The gate is consulted once, at
   * admission: a delivery admitted before its webhook's first failure runs its retries ungated.
   */
  private readonly failingWebhooks = new Set<string>();
  private readonly degradedSessionGates = new Map<string, ConcurrencyLimiter>();
  private readonly degradedSessionConcurrency: number;
  /**
   * Context of every delivery admitted to the dispatch limiter and not yet settled (queued-path
   * enqueue, or a direct delivery with its retry loop, including a backoff spent without a slot).
   * Counted against the dispatch budget in runLimited.
   * Used at shutdown to log, per delivery, what the bounded drain had to abandon: those deliveries
   * were neither completed nor safely recorded.
   */
  private readonly inFlightDeliveries = new Map<
    string,
    { webhookId: string; sessionId: string; event: string; idempotencyKey: string; url: string }
  >();
  /** Late bookkeeping (dead-letter rows) written by tasks the limiter already released — awaited on shutdown. */
  private readonly pendingBookkeeping = new Set<Promise<unknown>>();
  /**
   * Outbox rows this node still owns, by idempotency key and counted (the same key can be dispatched
   * twice), from the moment the row is opened until its dispatch settles: parked in the limiter,
   * holding a slot, or inside a direct retry loop. The reconciler skips these so a slow delivery is
   * not replayed alongside itself.
   */
  private readonly locallyPending = new Map<string, number>();
  /**
   * Per session, the opt-in events (WILDCARD_EXCLUDED_EVENTS) that active webhooks name, with the ids of the
   * webhooks that name each. The promise is cached, not its result, so a burst of receipts on a cold entry
   * shares one lookup.
   */
  private readonly optInSubscriptions = new Map<
    string,
    { named: Promise<ReadonlyMap<string, readonly string[]>>; expiresAt: number }
  >();
  /**
   * Per webhook, the stage its opt-in events (WILDCARD_EXCLUDED_EVENTS) pass before the shared dispatch
   * pool. One flush of buffered receipts is thousands of dispatches in a tick: a quarter of the dispatch
   * concurrency runs at once, shared by the session's webhooks that name the event, up to three quarters of
   * WEBHOOK_DISPATCH_MAX_QUEUED events wait their turn (holding only the event), and the rest are dropped
   * before they open an outbox row, a failure row or a hook call. A stage holds one webhook's deliveries and
   * is sized once, when it is created, from the webhooks then naming the event. It keeps at least one place,
   * so the session's webhooks together could take more than a quarter: the session gate in
   * `optInSessionStages` caps what they run at once to that quarter however many webhooks name the event or
   * change while earlier stages are active. The pool therefore never sees more than a quarter from one session,
   * so a flood, or a receiver that never answers, cannot shed or hold back what another session sends until
   * several sessions have such receivers at once. That cap is the guarantee. Isolation between the session's
   * own webhooks holds only while their stages fit in the gate, one place each at least: with more webhooks
   * naming the event than the gate has places, or one added while a larger stage is still live, a receiver
   * that never answers can hold places its siblings would have used, up to the cap. An entry lives while its
   * webhook has events in the stage; `dropped` counts those turned away since it was created.
   */
  private readonly optInStages = new Map<string, OptInStage>();
  private readonly optInSessionStages = new Map<string, { gate: ConcurrencyLimiter; stages: number }>();

  constructor(
    @InjectRepository(Webhook, 'data')
    private readonly webhookRepository: Repository<Webhook>,
    @InjectRepository(WebhookDeliveryFailure, 'data')
    private readonly failureRepository: Repository<WebhookDeliveryFailure>,
    private readonly configService: ConfigService,
    private readonly hookManager: HookManager,
    private readonly outbox: WebhookOutboxService,
    @Optional()
    private readonly lidMappingStore?: LidMappingStoreService,
    @Optional()
    @InjectQueue(QUEUE_NAMES.WEBHOOK)
    private readonly webhookQueue?: Queue<WebhookJobData>,
  ) {
    this.queueEnabled = configService.get<boolean>('queue.enabled', false);
    // Bound fan-out: cap how many webhook deliveries run CONCURRENTLY in this process. Every event and
    // session shares this one pool, so an event matching N webhooks cannot open N outbound sockets at
    // once. Default 16 (WEBHOOK_DISPATCH_CONCURRENCY).
    const dispatchConcurrency = this.configService.get<number>('webhook.dispatchConcurrency', 16);
    this.dispatchMaxQueued = this.configService.get<number>('webhook.dispatchMaxQueued', 1000);
    this.dispatchLimiter = new ConcurrencyLimiter(dispatchConcurrency, this.dispatchMaxQueued);
    // WEBHOOK_DEGRADED_SESSION_CONCURRENCY, else a quarter of the pool.
    this.degradedSessionConcurrency =
      this.configService.get<number | undefined>('webhook.degradedSessionConcurrency') ??
      Math.max(1, Math.floor(dispatchConcurrency / 4));
  }

  onModuleInit(): void {
    // Warn on the default-derived misconfiguration that silently truncates in-flight deliveries at
    // shutdown: WEBHOOK_SHUTDOWN_DRAIN_MS (default 5s) bounds how long onModuleDestroy waits for a
    // delivery in flight, while WEBHOOK_TIMEOUT (default 10s) bounds the delivery itself. When the
    // drain is shorter than the timeout, a delivery that takes nearly the full timeout is abandoned
    // (logged, not dead-lettered — the receiver may already have it). The defaults already cross, so
    // surface the cross so an operator who raised the timeout without raising the drain notices.
    const drainMs = this.configService.get<number>('webhook.shutdownDrainMs', DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS);
    const deliveryTimeoutMs = this.configService.get<number>('webhook.timeout', 10_000);
    if (Number.isFinite(drainMs) && Number.isFinite(deliveryTimeoutMs) && drainMs < deliveryTimeoutMs) {
      this.logger.warn(
        `WEBHOOK_SHUTDOWN_DRAIN_MS (${drainMs}ms) is shorter than WEBHOOK_TIMEOUT (${deliveryTimeoutMs}ms) — ` +
          `an in-flight delivery that takes nearly the full timeout will be abandoned at shutdown. ` +
          `Raise WEBHOOK_SHUTDOWN_DRAIN_MS to at least WEBHOOK_TIMEOUT if you want shutdown to wait for deliveries to complete.`,
      );
    }
  }

  /**
   * Bounded drain of the direct-delivery path (queued BullMQ jobs are durable in Redis and need no
   * drain). In direct mode, closing the limiter rejects every PARKED delivery; the dispatch catch
   * records each one in webhook_delivery_failures like any other undispatched delivery. Queued mode
   * skips the close: a parked dispatch's whole job is webhookQueue.add() — durable in Redis the
   * moment it resolves — so rejecting it would dead-letter work Redis could have kept. A parked
   * waiter holds an activeCount slot via handoff, so the drain loop below covers it either way.
   * A delivery waiting out a retry backoff holds no slot; if it wakes within the drain window, taking
   * one back fails on the closed limiter and it is recorded the same way. One still asleep when the
   * window ends is only logged below. Either way its outbox row stays pending for the next start.
   * In-flight deliveries (a direct delivery can outlive WEBHOOK_TIMEOUT via its backoff sleeps) get
   * up to WEBHOOK_SHUTDOWN_DRAIN_MS to finish; anything still running after that is about to be
   * dropped by process exit, so it is logged per delivery — a dead-letter row would be wrong there,
   * since the receiver may already have gotten the event. Nest awaits this hook during app.close(),
   * so the bound limits this hook only; the whole teardown is the sum in shutdown-budget.ts.
   */
  async onModuleDestroy(): Promise<void> {
    // Opt-in events still waiting for their stage hold nothing durable (no outbox row yet) and are best effort,
    // so they are let go in both modes; the ones already running finish with the rest.
    for (const { stage } of this.optInStages.values()) stage.close();
    for (const { gate } of this.optInSessionStages.values()) gate.close();
    if (!this.queueEnabled) {
      this.dispatchLimiter.close();
      for (const gate of this.degradedSessionGates.values()) gate.close();
    }
    const drainMs = Math.max(
      0,
      this.configService.get<number>('webhook.shutdownDrainMs', DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS),
    );
    const deadline = Date.now() + drainMs;
    while (
      this.dispatchLimiter.activeCount > 0 ||
      this.inFlightDeliveries.size > 0 ||
      this.pendingBookkeeping.size > 0
    ) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await setTimeout(Math.min(50, remaining));
    }
    for (const lost of this.inFlightDeliveries.values()) {
      this.logger.error('Webhook delivery abandoned during shutdown', undefined, {
        ...lost,
        action: 'webhook_delivery_abandoned_shutdown',
      });
    }
    this.inFlightDeliveries.clear();
  }

  async dispatch(sessionId: string, event: string, data: Record<string, unknown>): Promise<void> {
    if (!WILDCARD_EXCLUDED_EVENTS.includes(event)) return this.fanOut(sessionId, event, data, null);
    // An opt-in event fires per recipient (about 2,000 per message to a 1,000-member group): skip it
    // before the per-dispatch webhook read when no active webhook of the session names it.
    const webhookIds = await this.webhooksNamingOptInEvent(sessionId, event);
    // One event is a delivery to each of them; each delivery waits in the stage of its own webhook. A single
    // webhook is the common case and passes straight through: what waits in a stage is held for a flush.
    if (webhookIds.length === 1) return this.dispatchThroughOptInStage(sessionId, event, data, webhookIds[0], 1);
    const settled = await Promise.allSettled(
      webhookIds.map(webhookId => this.dispatchThroughOptInStage(sessionId, event, data, webhookId, webhookIds.length)),
    );
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  private async dispatchThroughOptInStage(
    sessionId: string,
    event: string,
    data: Record<string, unknown>,
    webhookId: string | null,
    named: number,
  ): Promise<void> {
    const key = JSON.stringify([sessionId, webhookId]);
    let sessionStage = this.optInSessionStages.get(sessionId);
    if (!sessionStage) {
      sessionStage = { gate: new ConcurrencyLimiter(Math.floor(this.dispatchLimiter.maxCount / 4)), stages: 0 };
      this.optInSessionStages.set(sessionId, sessionStage);
    }
    let entry = this.optInStages.get(key);
    if (!entry) {
      // A quarter of the pool runs at once, divided among the webhooks that name the event (the limiter keeps at
      // least one event running), and three quarters of the park bound wait, at least one place.
      entry = {
        stage: new ConcurrencyLimiter(
          Math.floor(this.dispatchLimiter.maxCount / 4 / named),
          Math.max(1, Math.floor((this.dispatchMaxQueued * 3) / 4)),
        ),
        dropped: 0,
        sessionId,
        webhookId,
      };
      this.optInStages.set(key, entry);
      sessionStage.stages++;
    }
    const sessionGate = sessionStage.gate;
    try {
      await entry.stage.run(() => sessionGate.run(() => this.fanOut(sessionId, event, data, webhookId)));
    } catch (error) {
      // Over the stage's bound, or still waiting when shutdown closed it; anything else is not ours to hide.
      if (isLimiterFull(error)) this.noteOptInDrop(event, entry);
      else if (!isLimiterClosed(error)) throw error;
    } finally {
      this.releaseOptInStage(key, entry);
    }
  }

  /**
   * An opt-in event past its webhook's bound: counted with the other deliveries that were never sent, and
   * announced once per burst, when the webhook starts dropping. It leaves no row to replay, by design.
   */
  private noteOptInDrop(event: string, entry: OptInStage): void {
    incrementWebhookDeliveryFailures();
    if (entry.dropped++ > 0) return;
    const { sessionId, webhookId } = entry;
    this.logger.warn(`Dropping ${event} events of ${describeOptInStage(entry)}: its queue of opt-in events is full`, {
      sessionId,
      webhookId: webhookId ?? undefined,
      event,
      action: 'webhook_opt_in_dropping',
    });
  }

  /** Forget a webhook's stage once it is idle, reporting how many events it turned away. */
  private releaseOptInStage(key: string, entry: OptInStage): void {
    if (entry.stage.activeCount > 0 || entry.stage.queuedCount > 0 || this.optInStages.get(key) !== entry) return;
    this.optInStages.delete(key);
    const sessionStage = this.optInSessionStages.get(entry.sessionId);
    if (sessionStage && --sessionStage.stages === 0) this.optInSessionStages.delete(entry.sessionId);
    if (entry.dropped === 0) return;
    const { sessionId, webhookId } = entry;
    this.logger.warn(
      `Dropped ${entry.dropped} opt-in events of ${describeOptInStage(entry)} while its queue was full`,
      {
        sessionId,
        webhookId: webhookId ?? undefined,
        dropped: entry.dropped,
        action: 'webhook_opt_in_dropped',
      },
    );
  }

  /**
   * Deliver an event to the session's matching webhooks, or only to the webhook `only` names. `only` has no
   * default value: a parameter list with one keeps the caller's `data` reachable past the reassignment below.
   */
  private async fanOut(
    sessionId: string,
    event: string,
    data: Record<string, unknown>,
    only: string | null,
  ): Promise<void> {
    const webhooks = await this.loadActiveWebhooks(sessionId, event);
    const matchingWebhooks = await this.filterMatchingWebhooks(
      only === null ? webhooks : webhooks.filter(webhook => webhook.id === only),
      event,
      data,
    );

    // Base idempotency key for this event occurrence. The occurrence id is minted once here and reused for
    // every retry of this dispatch, so recurring lifecycle events get a distinct-per-occurrence key (even two
    // within one clock millisecond) while retries of the same event stay stable. It is salted PER WEBHOOK below.
    const baseIdempotencyKey = generateIdempotencyKey(event, { ...data, sessionId }, randomUUID());

    // Fan-out amplification bound: shed an over-cap inline media blob ONCE here, before the
    // per-webhook structuredClone below, so N matching webhooks (and the queued jobs retained in
    // Redis) never copy the blob. The per-webhook clone stays — a webhook:before hook may mutate
    // payload.data in place and must not bleed into siblings — but after shedding it is small.
    const baseData =
      matchingWebhooks.length > 0
        ? shedInlineMedia(
            data,
            this.configService.get<number>('webhook.mediaInlineMaxBytes', DEFAULT_WEBHOOK_MEDIA_INLINE_MAX_BYTES),
          )
        : data;
    // The await below holds this frame, parameters included, until every delivery settles: point
    // `data` at the shed copy so parked deliveries pin only that, not the caller's full blob.
    // eslint-disable-next-line no-useless-assignment
    data = baseData;

    const ctx: DispatchEventContext = { sessionId, event, baseData };
    // allSettled preserves the per-webhook isolation: one failing delivery never rejects the others.
    await Promise.allSettled(matchingWebhooks.map(webhook => this.dispatchWithLimit(webhook, baseIdempotencyKey, ctx)));
  }

  /**
   * Drop the session's cached opt-in subscriptions. WebhookService calls this after every webhook
   * create, update and delete, so a change made on this node applies to the next event.
   */
  invalidateOptInSubscriptions(sessionId: string): void {
    this.optInSubscriptions.delete(sessionId);
  }

  /**
   * The ids of the session's active webhooks that name `event`, read at most once per
   * OPT_IN_SUBSCRIPTIONS_TTL_MS. A failed lookup is not cached and answers `[null]`, one delivery to every
   * webhook, which lets the event through so dispatch's own lookup reports the failure as before.
   */
  private async webhooksNamingOptInEvent(sessionId: string, event: string): Promise<Array<string | null>> {
    const now = Date.now();
    let entry = this.optInSubscriptions.get(sessionId);
    if (!entry || entry.expiresAt <= now) {
      const created = {
        named: this.webhookRepository
          .find({ select: { id: true, events: true }, where: { sessionId, active: true } })
          .then(rows => {
            const named = new Map<string, string[]>();
            for (const row of rows) {
              if (!Array.isArray(row.events)) continue;
              for (const e of new Set(row.events)) {
                if (!WILDCARD_EXCLUDED_EVENTS.includes(e)) continue;
                const ids = named.get(e);
                if (ids) ids.push(row.id);
                else named.set(e, [row.id]);
              }
            }
            return named;
          }),
        expiresAt: now + OPT_IN_SUBSCRIPTIONS_TTL_MS,
      };
      // Identity check: an invalidation (or a newer entry) since this lookup started must not be undone.
      created.named.catch(() => {
        if (this.optInSubscriptions.get(sessionId) === created) this.optInSubscriptions.delete(sessionId);
      });
      this.optInSubscriptions.set(sessionId, created);
      entry = created;
    }
    try {
      return [...((await entry.named).get(event) ?? [])];
    } catch {
      return [null];
    }
  }

  /**
   * Callers fire-and-forget this (`void dispatch(...)`), so a failure looking up webhooks must be
   * logged and swallowed here — otherwise it surfaces as an unhandled promise rejection.
   */
  private async loadActiveWebhooks(sessionId: string, event: string): Promise<Webhook[]> {
    try {
      return await this.webhookRepository.find({
        where: { sessionId, active: true },
      });
    } catch (error) {
      this.logger.error(`Webhook dispatch lookup failed for ${event}`, String(error), {
        sessionId,
        action: 'webhook_dispatch_lookup_failed',
      });
      return [];
    }
  }

  private async filterMatchingWebhooks(
    webhooks: Webhook[],
    event: string,
    data: Record<string, unknown>,
  ): Promise<Webhook[]> {
    // A row is judged on its own: one whose stored events or filters are malformed (e.g. restored from
    // a hand-edited backup) is skipped, instead of throwing here and dropping the event for every
    // other webhook of the session. A `filters` that is not a plain object, or a non-array `conditions`,
    // is refused explicitly: evaluateFilters reads either as "no filter", which would deliver every
    // subscribed event unfiltered.
    const subscribed = webhooks.filter(w => Array.isArray(w.events) && subscriptionCoversEvent(w.events, event));
    const resolveLid = await prepareFilterLidResolver(
      subscribed.map(w => w.filters),
      event,
      data,
      this.lidMappingStore ? lids => this.lidMappingStore!.phonesForLidsPersisted(lids) : undefined,
    );
    const matching = subscribed.filter(w => {
      try {
        const filters: unknown = w.filters;
        if (
          filters != null &&
          (typeof filters !== 'object' ||
            Array.isArray(filters) ||
            (w.filters?.conditions != null && !Array.isArray(w.filters.conditions)))
        ) {
          throw new TypeError('filters must be an object with a conditions array');
        }
        return evaluateFilters(w.filters, event, data, resolveLid);
      } catch (error) {
        this.logger.warn('Skipping webhook with malformed filters', {
          webhookId: w.id,
          event,
          error: String(error),
          action: 'webhook_filters_invalid',
        });
        return false;
      }
    });
    // A subscribed webhook that a filter drops leaves no trace otherwise: dispatch() awaits an empty
    // array and returns, and the delivery-failure table only records deliveries that were ATTEMPTED.
    // That is fine when the filter is doing its job, and indistinguishable from it when it is not —
    // an `is`/`contains`/`equals` condition on a field the event's payload does not carry resolves to
    // undefined and fails, which is how a `sender is` filter silently swallows every message.ack
    // (an `isNot` condition, or a boolean compared with false, passes instead). Debug rather than warn:
    // suppression is the normal outcome of a working filter, so this is a trace to switch on while
    // investigating, not an alarm.
    if (matching.length < subscribed.length) {
      this.logger.debug('Webhook filters suppressed a delivery', {
        action: 'webhook_filter_suppressed',
        event,
        subscribed: subscribed.length,
        suppressed: subscribed.length - matching.length,
        payloadFields: Object.keys(data).sort().join(','),
      });
    }
    return matching;
  }

  private async recordUndelivered(
    webhook: Webhook,
    deliveryId: string,
    idempotencyKey: string,
    error: unknown,
    action: string,
    ctx: DispatchEventContext,
  ): Promise<boolean> {
    const { sessionId, event } = ctx;
    const lastError = redactSsrfError(error, this.logger, 'webhook dispatch');
    const recorded = await recordWebhookDeliveryFailure(this.failureRepository, this.logger, {
      webhookId: webhook.id,
      sessionId,
      event,
      url: webhook.url,
      idempotencyKey,
      deliveryId,
      attempts: 0,
      lastStatusCode: null,
      lastError,
    });
    if (recorded !== false) incrementWebhookDeliveryFailures();
    try {
      await this.hookManager.execute(
        'webhook:error',
        { sessionId, event, webhookId: webhook.id, deliveryId, error: lastError },
        { sessionId, source: 'WebhookService' },
      );
    } catch (hookError) {
      this.logger.error('webhook:error hook failed while reporting an undelivered webhook', String(hookError), {
        webhookId: webhook.id,
        deliveryId,
        action: 'webhook_error_hook_failed',
      });
    }
    this.logger.error(`Webhook ${webhook.id} was not dispatched`, lastError, {
      webhookId: webhook.id,
      deliveryId,
      action,
    });
    return recorded !== null;
  }

  /**
   * Build one webhook delivery: payload + webhook:before hooks + identity re-assertion + size gate.
   * Returns null when the delivery must not proceed: either cancelled by a plugin (a debug
   * log, not a failure) or after a failure already recorded via recordUndelivered.
   */
  private async preflightDelivery(
    webhook: Webhook,
    deliveryId: string,
    idempotencyKey: string,
    ctx: DispatchEventContext,
  ): Promise<{ finalPayload: WebhookPayload; body: string } | 'cancelled' | 'unrecorded' | null> {
    const { sessionId, event, baseData } = ctx;
    try {
      const payload: WebhookPayload = {
        event,
        timestamp: new Date().toISOString(),
        sessionId,
        idempotencyKey,
        deliveryId,
        // Give each webhook its own copy of the event data: a webhook:before hook that mutates
        // payload.data in place would otherwise bleed that change into sibling webhooks.
        data: structuredClone(baseData),
      };
      // Captured BEFORE the hook chain: a hook may return the same payload object mutated in
      // place, so reading the canonical timestamp off the hook result afterwards is not safe.
      const payloadTimestamp = payload.timestamp;

      // A handler result without a plain-object payload is skipped, so the chain keeps the last usable
      // payload (an earlier hook's redaction included) rather than the one it started from.
      const { continue: shouldContinue, data: hookResult } = await this.hookManager.execute(
        'webhook:before',
        { sessionId, event, payload },
        {
          sessionId,
          source: 'WebhookService',
          accept: isWebhookBeforeResult,
        },
      );

      if (!shouldContinue) {
        this.logger.debug(`Webhook dispatch cancelled by plugin for ${event}`, {
          webhookId: webhook.id,
          action: 'webhook_cancelled_by_plugin',
        });
        return 'cancelled';
      }

      // Null/undefined hook results mean "no override", matching an object without payload. A
      // payload that is not a plain object (a primitive, which throws on the writes below, or an
      // array, which drops them from the JSON) is not one either: send the original and say so.
      const hookPayload = (hookResult as { payload?: unknown } | null | undefined)?.payload ?? payload;
      const usable = isPlainObject(hookPayload);
      if (!usable) {
        this.logger.warn('A webhook:before hook returned a payload that is not an object; sending the original', {
          webhookId: webhook.id,
          event,
          received: Array.isArray(hookPayload) ? 'array' : typeof hookPayload,
          action: 'hook_payload_discarded',
        });
      }
      const finalPayload = usable ? (hookPayload as WebhookPayload) : payload;
      // Re-assert EVERY identity field after the (untrusted) hook chain. A hook may rewrite data,
      // but event/sessionId/timestamp and the dedupe ids must remain the server's values: the
      // receiver verifies the signature over this body and compares it against the X-OpenWA-*
      // headers, and failure records are filed by these fields — a rewritten sessionId/event
      // misfiles them across sessions.
      finalPayload.event = event;
      finalPayload.sessionId = sessionId;
      finalPayload.timestamp = payloadTimestamp;
      finalPayload.idempotencyKey = idempotencyKey;
      finalPayload.deliveryId = deliveryId;

      // Bound what a hook mutation can make us send. Serializing here also catches a poisoned
      // (BigInt/circular) hook result as a preflight failure, on BOTH the queued and direct paths.
      // The bytes are serialized ONCE and reused for the size gate, the HMAC signature, and the
      // direct-delivery body (BullMQ re-serializes jobData itself — unavoidable).
      const maxPayloadBytes = this.configService.get<number>(
        'webhook.maxPayloadBytes',
        DEFAULT_WEBHOOK_MAX_PAYLOAD_BYTES,
      );
      let body = JSON.stringify(finalPayload);
      let payloadBytes = Buffer.byteLength(body, 'utf8');
      if (payloadBytes > maxPayloadBytes) {
        // Size-gated body shedding: over budget, strip ANY remaining inline media blob (threshold
        // 0 — the marker form keeps the event deliverable) and re-check, instead of dropping the
        // event or queueing a giant payload.
        const shedData = shedInlineMedia(finalPayload.data, 0);
        if (shedData !== finalPayload.data) {
          finalPayload.data = shedData;
          body = JSON.stringify(finalPayload);
          payloadBytes = Buffer.byteLength(body, 'utf8');
        }
      }
      if (payloadBytes > maxPayloadBytes) {
        const recorded = await this.recordUndelivered(
          webhook,
          deliveryId,
          idempotencyKey,
          new Error(
            `Webhook payload is ${payloadBytes} bytes after webhook:before hooks, exceeding the ${maxPayloadBytes}-byte cap`,
          ),
          'webhook_payload_oversize',
          ctx,
        );
        return recorded ? null : 'unrecorded';
      }

      return { finalPayload, body };
    } catch (error) {
      const recorded = await this.recordUndelivered(
        webhook,
        deliveryId,
        idempotencyKey,
        error,
        'webhook_dispatch_preflight_failed',
        ctx,
      );
      return recorded ? null : 'unrecorded';
    }
  }

  /**
   * What became of one delivery attempt, reported rather than thrown.
   *
   * Every failure path here is already handled in place (a dead-letter row, a hook, a log), so none
   * of them reach the caller as an exception, except 'ConcurrencyLimiter closed' from a retry backoff
   * woken after shutdown, which runLimited handles (redeliver passes no yieldSlot and never sees it),
   * and the AbortError of a replay whose signal stopped its retries or its queue fallback, which
   * reaches its caller.
   * The reconciler has to tell a delivered event from a
   * dead-lettered one to know whether the outbox row may be retired, and a caught throw cannot tell
   * it: there is none. This mirrors the inbound twin, where `ingressEnqueue.enqueue` returns an
   * outcome and the caller retires the payload only when it is not 'failed'.
   */
  private async deliverOne(
    webhook: Webhook,
    deliveryId: string,
    idempotencyKey: string,
    ctx: DispatchEventContext,
  ): Promise<WebhookDeliveryOutcome> {
    const preflight = await this.preflightDelivery(webhook, deliveryId, idempotencyKey, ctx);
    if (preflight === 'unrecorded') return 'unrecorded';
    if (preflight === 'cancelled') {
      // A plugin suppressed this dispatch deliberately. There is no failure to record and nothing
      // to retry: reporting it as failed made the reconciler replay a deliberately dropped event
      // until the budget ran out, then mark it lost against a failure row that never existed.
      return 'cancelled';
    }
    if (!preflight) {
      // The remaining bail-outs record their own undelivered row before returning null.
      return 'failed';
    }
    const { finalPayload, body } = preflight;
    // Use queue if available, otherwise fallback to direct delivery
    if (!ctx.singleAttempt && this.queueEnabled && this.webhookQueue) {
      // A replay's attempts-0 row is not cleared here. It stays until the delivery resolves: a
      // successful POST (the processor's, or the fallback's when the add fails) clears it, and a
      // terminal failure replaces it right after filing its own row. A restart or a lost job at
      // any point before that still leaves the event on record.
      return this.enqueueWithFallback(webhook, finalPayload, body, deliveryId, idempotencyKey, ctx);
    }
    return this.deliverDirect(webhook, finalPayload, body, deliveryId, ctx);
  }

  private async enqueueWithFallback(
    webhook: Webhook,
    finalPayload: WebhookPayload,
    body: string,
    deliveryId: string,
    idempotencyKey: string,
    ctx: DispatchEventContext,
  ): Promise<WebhookDeliveryOutcome> {
    const { sessionId, event } = ctx;
    try {
      // No headers are stored: the processor builds them and the signature from the current row on
      // every attempt, so custom headers (which may carry receiver credentials) never reach Redis.
      const jobData: WebhookJobData = {
        webhookId: webhook.id,
        url: webhook.url,
        event,
        payload: finalPayload,
        attempt: 1,
        maxRetries: webhook.retryCount,
        ...(this.keepsFailurePayload() ? { replayData: ctx.baseData } : {}),
      };

      await producerReady(this.webhookQueue!);
      await this.webhookQueue!.add(`webhook-${webhook.id}`, jobData, {
        // jobId = deliveryId makes this add() idempotent within BullMQ (same precedent as the ingress
        // producer). It does not dedup a crash replay: if the process dies before the outbox row is
        // closed, the reconciler re-enqueues the event under a new deliveryId as a second job, with
        // the same idempotency key, which is what receivers dedup on. Safe for fan-out: deliveryId is
        // minted per webhook per dispatch in dispatchWithLimit, so sibling subscriptions to one event
        // never share a job id.
        jobId: deliveryId,
        attempts: webhook.retryCount,
        backoff: {
          type: 'exponential',
          delay: this.configService.get<number>('webhook.retryDelay', 5000),
        },
      });

      await this.outbox.markQueued(webhook.id, idempotencyKey, deliveryId);

      // Execute hook after successful queue (NOT delivery - that happens in processor)
      await this.hookManager.execute(
        'webhook:queued',
        { sessionId, event, webhookId: webhook.id, deliveryId },
        { sessionId, source: 'WebhookService' },
      );

      this.logger.debug(`Webhook job queued for ${webhook.id}`, {
        webhookId: webhook.id,
        event,
        idempotencyKey,
        deliveryId,
        action: 'webhook_queued',
      });
    } catch (error) {
      // A replay whose owner stopped while the add was out (it can wait for a first connect, or on a
      // stalled Redis) must not POST or run hooks after the drain: the reconciler reads the abort as
      // interrupted.
      ctx.signal?.throwIfAborted();
      // Execute hook on queue error (not delivery error - that happens in processor)
      await this.hookManager.execute(
        'webhook:error',
        { sessionId, event, webhookId: webhook.id, error: `Queue failed: ${String(error)}` },
        { sessionId, source: 'WebhookService' },
      );

      this.logger.error(`Failed to queue webhook ${webhook.id}`, String(error), {
        webhookId: webhook.id,
        action: 'webhook_queue_failed',
      });

      // Fallback: deliver directly when the queue add failed (Redis not connected yet, or down with the
      // producer's enableOfflineQueue:false). This is at-least-once — if add() actually reached
      // Redis before rejecting, the queued job AND this fallback may both POST. Both paths carry the
      // same X-OpenWA-Idempotency-Key / X-OpenWA-Delivery-Id, so a conformant receiver dedupes.
      try {
        // Removed, disabled or unsubscribed before a retry: nothing to report, as on the queued path.
        if (!(await this.deliverWebhook(webhook, finalPayload, body, this.directOptions(ctx)))) return 'cancelled';

        await this.hookManager.execute(
          'webhook:delivered',
          { sessionId, event, webhookId: webhook.id, deliveryId, fallback: 'queue_failed' },
          { sessionId, source: 'WebhookService' },
        );

        await this.hookManager.execute(
          'webhook:after',
          { sessionId, event, webhookId: webhook.id, success: true, fallback: 'queue_failed' },
          { sessionId, source: 'WebhookService' },
        );
      } catch (fallbackError) {
        // Shutdown closed the limiter or aborted the replay during a retry backoff: not a delivery
        // failure. runLimited or the replay's caller keeps the outbox row pending for the next start.
        if (isLimiterClosed(fallbackError) || isAbortedBackoff(fallbackError, ctx.signal)) throw fallbackError;
        await this.hookManager.execute(
          'webhook:error',
          {
            sessionId,
            event,
            webhookId: webhook.id,
            error: `Queue fallback delivery failed: ${redactSsrfError(fallbackError, this.logger, 'webhook fallback delivery')}`,
          },
          { sessionId, source: 'WebhookService' },
        );

        this.logger.error(`Queue fallback delivery failed for webhook ${webhook.id}`, String(fallbackError), {
          webhookId: webhook.id,
          action: 'webhook_queue_fallback_failed',
        });
        return fallbackError instanceof UnrecordedWebhookFailure ? 'unrecorded' : 'failed';
      }
      // The queue never took it, but the fallback POST did.
      return 'delivered';
    }
    // Handed to BullMQ, which owns the retries and the dead-letter row from here.
    return 'enqueued';
  }

  /** Direct delivery when the queue is disabled. */
  private async deliverDirect(
    webhook: Webhook,
    finalPayload: WebhookPayload,
    body: string,
    deliveryId: string,
    ctx: DispatchEventContext,
  ): Promise<WebhookDeliveryOutcome> {
    const { sessionId, event } = ctx;
    try {
      // Removed, disabled or unsubscribed before a retry: nothing to report, as on the queued path.
      if (!(await this.deliverWebhook(webhook, finalPayload, body, this.directOptions(ctx)))) return 'cancelled';

      // Execute hook after successful delivery
      await this.hookManager.execute(
        'webhook:delivered',
        { sessionId, event, webhookId: webhook.id, deliveryId },
        { sessionId, source: 'WebhookService' },
      );

      // Legacy hook for backward compatibility
      await this.hookManager.execute(
        'webhook:after',
        { sessionId, event, webhookId: webhook.id, success: true },
        { sessionId, source: 'WebhookService' },
      );
    } catch (error) {
      // Shutdown closed the limiter or aborted the replay during a retry backoff: not a delivery
      // failure. runLimited or the replay's caller keeps the outbox row pending for the next start.
      if (isLimiterClosed(error) || isAbortedBackoff(error, ctx.signal)) throw error;
      // Execute hook on error
      await this.hookManager.execute(
        'webhook:error',
        { sessionId, event, webhookId: webhook.id, error: redactSsrfError(error, this.logger, 'webhook delivery') },
        { sessionId, source: 'WebhookService' },
      );

      this.logger.error(`Failed to deliver webhook ${webhook.id}`, String(error), {
        webhookId: webhook.id,
        action: 'webhook_delivery_failed',
      });
      return error instanceof UnrecordedWebhookFailure ? 'unrecorded' : 'failed';
    }
    return 'delivered';
  }

  /**
   * Bound fan-out: deliver to all matching webhooks concurrently, but cap in-flight deliveries at
   * WEBHOOK_DISPATCH_CONCURRENCY so an event matching many webhooks (or slow receivers) can't open an
   * unbounded number of outbound sockets at once.
   */
  private async dispatchWithLimit(
    webhook: Webhook,
    baseIdempotencyKey: string,
    ctx: DispatchEventContext,
  ): Promise<void> {
    const { sessionId, event } = ctx;
    const deliveryId = generateDeliveryId();
    // Salt per webhook so sibling subscriptions cannot collide at the receiver's dedup boundary.
    const idempotencyKey = `${baseIdempotencyKey}_${webhook.id}`;
    // Durable record BEFORE anything is attempted. A hard crash from here until the delivery
    // reaches a durable owner leaves this row 'pending', which is what the reconciler replays.
    await this.outbox.open({
      webhookId: webhook.id,
      sessionId,
      event,
      idempotencyKey,
      deliveryId,
      payload: ctx.baseData,
    });
    this.locallyPending.set(idempotencyKey, (this.locallyPending.get(idempotencyKey) ?? 0) + 1);
    try {
      await this.runLimited(webhook, deliveryId, idempotencyKey, ctx);
    } finally {
      const left = (this.locallyPending.get(idempotencyKey) ?? 1) - 1;
      if (left > 0) this.locallyPending.set(idempotencyKey, left);
      else this.locallyPending.delete(idempotencyKey);
    }
  }

  /** True while a dispatch on this node still owns the outbox row for this key. */
  isLocallyPending(idempotencyKey: string): boolean {
    return this.locallyPending.has(idempotencyKey);
  }

  /**
   * Direct mode: pass a delivery to a failing webhook through its session's gate before `run`, so
   * the deliveries that session admits after a failure hold at most `degradedSessionConcurrency`
   * dispatch slots however many of its receivers fail. Each gate parks at most a quarter of
   * WEBHOOK_DISPATCH_MAX_QUEUED, so a failing session sheds its own excess before it can spend the
   * park budget every session shares. Parking there also counts against WEBHOOK_DISPATCH_MAX_QUEUED
   * like parking in the dispatch limiter, and a delivery over it is shed the same way. Queued mode
   * holds a slot only for the enqueue, and the worker applies its own gate; the direct fallback for
   * a rejected enqueue is not gated.
   */
  private gateFailingReceiver(
    webhook: Webhook,
    sessionId: string,
    run: (gated: boolean) => Promise<void>,
  ): Promise<void> {
    if (this.queueEnabled || !this.failingWebhooks.has(webhook.id)) return run(false);
    let gate = this.degradedSessionGates.get(sessionId);
    if (!gate) {
      gate = new ConcurrencyLimiter(
        this.degradedSessionConcurrency,
        Math.max(1, Math.floor(this.dispatchMaxQueued / 4)),
      );
      this.degradedSessionGates.set(sessionId, gate);
    }
    if (gate.activeCount >= this.degradedSessionConcurrency && this.parkedDeliveries() >= this.dispatchMaxQueued) {
      return Promise.reject(new Error('ConcurrencyLimiter queue full'));
    }
    const current = gate;
    return current
      .run(() => run(true))
      .finally(() => {
        if (
          current.activeCount === 0 &&
          current.queuedCount === 0 &&
          this.degradedSessionGates.get(sessionId) === current
        ) {
          this.degradedSessionGates.delete(sessionId);
        }
      });
  }

  /**
   * Deliveries parked for a slot they were never given. One taking back the slot it gave up for a
   * retry backoff is left out: it is already counted in inFlightDeliveries.
   */
  private parkedDeliveries(): number {
    let parked = this.dispatchLimiter.queuedCount - this.dispatchLimiter.reacquiringCount;
    for (const gate of this.degradedSessionGates.values()) parked += gate.queuedCount;
    return parked;
  }

  private async runLimited(
    webhook: Webhook,
    deliveryId: string,
    idempotencyKey: string,
    ctx: DispatchEventContext,
  ): Promise<void> {
    const { sessionId, event } = ctx;
    // One budget for every admitted, unsettled delivery: running, parked in either limiter, or
    // asleep in a retry backoff that gave its slot up. The limiter's own maxQueued sees none of the
    // session gates or the sleepers, so on its own it no longer bounds what sits in heap.
    const overBudget =
      this.inFlightDeliveries.size + this.parkedDeliveries() >= this.dispatchLimiter.maxCount + this.dispatchMaxQueued;
    const admitted = overBudget
      ? Promise.reject(new Error('ConcurrencyLimiter queue full'))
      : this.gateFailingReceiver(webhook, sessionId, gated =>
          this.dispatchLimiter.run(async yieldSlot => {
            let target = webhook;
            if (gated) {
              // A delivery can sit behind the session gate far longer than the dispatch took, and the
              // gated webhooks are the ones an operator disables or re-points. Re-read the row before
              // the first attempt, as every retry does; healthy receivers never pay this read. If the
              // read fails, deliver with the dispatch-time row rather than drop the delivery silently:
              // every retry re-reads again, and a failed attempt is recorded as usual.
              let row: Webhook | null = webhook;
              try {
                row = await this.webhookRepository.findOne({ where: { id: webhook.id } });
              } catch (error) {
                this.logger.warn('Could not re-read parked webhook; delivering with the dispatch-time row', {
                  webhookId: webhook.id,
                  event,
                  deliveryId,
                  idempotencyKey,
                  error: error instanceof Error ? error.message : String(error),
                  action: 'webhook_stale_check_failed',
                });
              }
              if (!isDeliverableWebhook(row, event)) {
                this.logger.warn('Skipping parked webhook delivery: webhook removed, disabled or unsubscribed', {
                  webhookId: webhook.id,
                  event,
                  deliveryId,
                  idempotencyKey,
                  action: 'webhook_skipped_stale',
                });
                this.failingWebhooks.delete(webhook.id);
                await this.outbox.close(webhook.id, idempotencyKey, 'dispatched');
                return;
              }
              target = row;
            }
            this.inFlightDeliveries.set(deliveryId, {
              webhookId: webhook.id,
              sessionId,
              event,
              idempotencyKey,
              url: target.url,
            });
            try {
              const outcome = await this.deliverOne(target, deliveryId, idempotencyKey, { ...ctx, yieldSlot });
              // Retire only after queue ownership, success, cancellation or a durable terminal row.
              if (outcome !== 'unrecorded' && outcome !== 'enqueued')
                await this.outbox.close(webhook.id, idempotencyKey, 'dispatched');
            } finally {
              this.inFlightDeliveries.delete(deliveryId);
            }
          }),
        );
    await admitted.catch(async error => {
      if (error instanceof Error && error.message === 'ConcurrencyLimiter queue full') {
        // Shed before the task ran, so nothing was POSTed. The failure row reports the shed, but
        // the outbox row stays 'pending' on purpose: retiring it would drop the only copy of an
        // event the receiver provably never got. The sweep replays it once the backlog clears.
        await this.recordUndelivered(
          webhook,
          deliveryId,
          idempotencyKey,
          error,
          'webhook_dispatch_capacity_exceeded',
          ctx,
        );
        return;
      }
      if (error instanceof Error && error.message === 'ConcurrencyLimiter closed') {
        // Rejected by the shutdown drain before dispatching, or woken from a retry backoff after
        // it: record it like any other undelivered delivery, and track the write so
        // onModuleDestroy can await it (the limiter slot bookkeeping no longer covers this task).
        // Its outbox row stays 'pending': no POST was accepted, so the next start's sweep is what
        // finally delivers the event.
        const record = this.recordUndelivered(
          webhook,
          deliveryId,
          idempotencyKey,
          error,
          'webhook_dispatch_shutdown',
          ctx,
        );
        this.pendingBookkeeping.add(record);
        try {
          await record;
        } finally {
          this.pendingBookkeeping.delete(record);
        }
        return;
      }
      throw error;
    });
  }

  /**
   * Replay one recorded delivery, reusing its STORED idempotency key.
   *
   * Deriving a fresh key would defeat the point: the receiver dedups on that value, so a replay
   * carrying a new one reads as a second event rather than a retry of the first. A new deliveryId
   * IS issued, because that identifies the attempt rather than the event.
   */
  async redeliver(
    webhook: Webhook,
    sessionId: string,
    event: string,
    idempotencyKey: string,
    data: Record<string, unknown>,
    options: { singleAttempt?: boolean; oneDirectAttempt?: boolean; signal?: AbortSignal } = {},
  ): Promise<WebhookDeliveryOutcome> {
    const deliveryId = generateDeliveryId();
    const outcome = await this.deliverOne(webhook, deliveryId, idempotencyKey, {
      sessionId,
      event,
      baseData: data,
      singleAttempt: options.singleAttempt,
      oneDirectAttempt: options.oneDirectAttempt,
      signal: options.signal,
    });
    // The receiver has the event. An operator redrive of a failure row can find the same delivery
    // still pending in the outbox, which the next sweep would otherwise POST again.
    if (outcome === 'delivered') await this.outbox.close(webhook.id, idempotencyKey, 'dispatched');
    return outcome;
  }

  /** A live or unreadable job still owns its queued delivery; never replay alongside it. */
  async isQueueJobPending(deliveryId: string): Promise<boolean> {
    if (!this.webhookQueue) return false;
    try {
      await producerReady(this.webhookQueue);
      const job = await this.webhookQueue.getJob(deliveryId);
      if (!job) return false;
      return !['completed', 'failed', 'unknown'].includes(await job.getState());
    } catch (error) {
      this.logger.warn('Could not inspect queued webhook delivery', { deliveryId, error: String(error) });
      return true;
    }
  }

  /**
   * A finished job: its worker settled the delivery, so an outbox row still queued for it is a leftover and
   * not a stranded send. Anything unreadable answers false here; isQueueJobPending already holds the
   * conservative answer for that case.
   */
  async hasQueueJobCompleted(deliveryId: string): Promise<boolean> {
    if (!this.webhookQueue) return false;
    try {
      await producerReady(this.webhookQueue);
      const job = await this.webhookQueue.getJob(deliveryId);
      return job ? (await job.getState()) === 'completed' : false;
    } catch (error) {
      this.logger.warn('Could not inspect queued webhook delivery', { deliveryId, error: String(error) });
      return false;
    }
  }

  /** Finish a spent outbox replay budget only after its failure record is durable. */
  async recordReplayExhaustion(row: ReplayableDelivery, url: string): Promise<boolean> {
    const existing = await this.failureRepository.count({
      where: { webhookId: row.webhookId, idempotencyKey: row.idempotencyKey, attempts: MoreThan(0) },
    });
    if (existing > 0) return true;
    // A delivery that was shed or refused before sending was recorded with its reason as an attempts-0 row,
    // which the terminal row below replaces; keep that reason on it.
    const unsent = await this.failureRepository.findOne({
      where: { webhookId: row.webhookId, idempotencyKey: row.idempotencyKey, attempts: 0 },
      select: { id: true, lastError: true },
    });
    const recorded = await recordWebhookDeliveryFailure(this.failureRepository, this.logger, {
      webhookId: row.webhookId,
      sessionId: row.sessionId,
      event: row.event,
      url,
      idempotencyKey: row.idempotencyKey,
      attempts: Math.max(1, row.attempts),
      lastError: unsent?.lastError
        ? `Webhook replay budget exhausted; last error: ${unsent.lastError}`
        : 'Webhook replay budget exhausted',
      ...(this.keepsFailurePayload() ? { payload: row.payload } : {}),
    });
    if (recorded === true) incrementWebhookDeliveryFailures();
    return recorded !== null;
  }

  /**
   * WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS > 0: a terminal failure row keeps the event data it was
   * built from, so an operator can redrive it. Off (0) by default, which stores nothing new.
   */
  private keepsFailurePayload(): boolean {
    return this.configService.get<number>('webhook.failurePayloadRetentionHours', 0) > 0;
  }

  /** What the direct path needs from the dispatch context: the slot, the replay copy, the attempt cap. */
  private directOptions(ctx: DispatchEventContext): DirectDeliveryOptions {
    return {
      yieldSlot: ctx.yieldSlot,
      replayData: this.keepsFailurePayload() ? ctx.baseData : undefined,
      singleAttempt: ctx.singleAttempt || ctx.oneDirectAttempt,
      signal: ctx.signal,
    };
  }

  /**
   * Direct delivery with in-process retries, up to `webhook.retryCount` attempts: the path every
   * delivery takes when the queue is disabled (the default), and the fallback when an enqueue fails.
   * `body` is the pre-serialized payload from preflight, the exact bytes the size gate checked, so it
   * is never re-serialized here.
   *
   * Like a queued job, every attempt re-reads the webhook row: a webhook removed, disabled or
   * unsubscribed since the dispatch gets nothing more and no failure row (resolves false), and a
   * changed url, secret or header map applies immediately. Retries back off exponentially
   * (retryDelay, then twice that, and so on), the schedule BullMQ applies to a queued job.
   */
  private async deliverWebhook(
    webhook: Webhook,
    payload: WebhookPayload,
    body: string,
    options: DirectDeliveryOptions = {},
  ): Promise<boolean> {
    const yieldSlot = options.yieldSlot ?? (<R>(fn: () => Promise<R>): Promise<R> => fn());
    const delay = this.configService.get<number>('webhook.retryDelay', 5000);
    let current = webhook;
    for (let attempt = 1; ; attempt++) {
      try {
        // Inside the try: a read error counts as a failed attempt, as it does for a queued job.
        const row = await this.webhookRepository.findOne({ where: { id: webhook.id } });
        if (!isDeliverableWebhook(row, payload.event, payload.sessionId)) {
          this.logger.warn('Skipping webhook delivery: webhook removed, disabled, unsubscribed or reassigned', {
            webhookId: webhook.id,
            event: payload.event,
            deliveryId: payload.deliveryId,
            idempotencyKey: payload.idempotencyKey,
            action: 'webhook_skipped_stale',
          });
          this.failingWebhooks.delete(webhook.id);
          return false;
        }
        current = row;
        const headers = buildDeliveryHeaders(
          current,
          payload.event,
          payload.idempotencyKey,
          payload.deliveryId,
          body,
          attempt - 1,
        );
        // A retry gives way once its replay's owner has stopped, even when the backoff ended first.
        if (attempt > 1) options.signal?.throwIfAborted();
        await postWebhookPayload(current.url, body, headers, this.configService.get<number>('webhook.timeout', 10000));
        this.failingWebhooks.delete(webhook.id);

        // The receiver already answered 2xx — the delivery SUCCEEDED. A bookkeeping failure here (e.g.
        // the lastTriggeredAt update on a flaky DB) must not reach the catch below: it would retry an
        // already-delivered webhook (duplicate POST) and, on the last attempt, file a false dead-letter
        // row. Log it and keep the success outcome.
        try {
          await this.webhookRepository.update(webhook.id, {
            lastTriggeredAt: new Date(),
          });
        } catch (bookkeepingError) {
          this.logger.error(
            `Webhook delivered to ${webhook.id} but lastTriggeredAt update failed`,
            bookkeepingError instanceof Error ? bookkeepingError.message : String(bookkeepingError),
            { webhookId: webhook.id, deliveryId: payload.deliveryId, action: 'webhook_bookkeeping_failed' },
          );
        }
        // A delivered event must not stay listed as lost: a replay of a shed, refused or failed
        // dispatch, or a re-emitted event, reuses the key an earlier failure row was filed under.
        await clearDeliveryFailureRows(this.failureRepository, this.logger, webhook.id, payload.idempotencyKey);

        this.logger.debug(`Webhook delivered to ${webhook.id}`, {
          webhookId: webhook.id,
          deliveryId: payload.deliveryId,
          action: 'webhook_delivered',
        });
        return true;
      } catch (error) {
        if (isAbortedBackoff(error, options.signal)) throw error;
        this.failingWebhooks.add(webhook.id);
        this.logger.error(`Webhook delivery failed for ${webhook.id}`, String(error), {
          webhookId: webhook.id,
          attempt,
          deliveryId: payload.deliveryId,
          action: 'webhook_delivery_failed',
        });

        if (attempt < (options.singleAttempt ? 1 : current.retryCount)) {
          // Without the dispatch slot: a backoff sends nothing, and holding the slot through it let
          // a few failing receivers stall every other delivery. Taking it back throws once shutdown
          // closed the limiter, which skips the terminal record below: the event was not given up.
          // An aborted replay signal ends the backoff the same way.
          await yieldSlot(() => setTimeout(delay * 2 ** (attempt - 1), undefined, { signal: options.signal }));
          continue;
        }
        // All direct-path retries exhausted — persist a durable failure record before giving up, mirroring
        // the queued processor's final-attempt path so the queue-disabled path isn't a blind spot.
        // The recorder writes this row first and only then removes an attempts-0 row of the same
        // delivery (a shed or refused dispatch), so a restart at any point keeps a record.
        const recorded = await recordTerminalFailure(this.failureRepository, this.logger, {
          webhookId: webhook.id,
          sessionId: payload.sessionId,
          event: payload.event,
          url: current.url,
          idempotencyKey: payload.idempotencyKey,
          deliveryId: payload.deliveryId,
          attempts: attempt,
          error,
          ...(options.replayData ? { payload: options.replayData } : {}),
        });
        if (recorded !== false) incrementWebhookDeliveryFailures();
        if (recorded === null) throw new UnrecordedWebhookFailure(redactSsrfError(error));
        throw error;
      }
    }
  }
}
