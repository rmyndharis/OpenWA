import { Injectable, Optional, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, MoreThan, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { setTimeout } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Webhook } from './entities/webhook.entity';
import {
  MESSAGE_CHANGE_EVENTS,
  MESSAGE_DELIVERY_EVENTS,
  WebhookOutboxService,
  changedMessagePayload,
  messageDeliveryKeys,
  messageEditKeys,
  type MessageCopyChange,
  type MessageCopyFilter,
  type MessageHold,
  type MessageCopyPredicate,
  type OutboxOpenRow,
  type ReplayableDelivery,
} from './webhook-outbox.service';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import type { MessageEngineRef } from '../message/entities/message.entity';
import { clearDeliveryFailureRows, recordWebhookDeliveryFailure } from './utils/record-delivery-failure';
import {
  buildDeliveryHeaders,
  changedData,
  dataHash,
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
import { DeliveryPreflight } from './utils/delivery-preflight';
import { evaluateFilters, prepareFilterLidResolver } from './filters/filter-evaluator';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { redactSsrfError } from '../../common/security/ssrf-guard';
import { HookManager } from '../../core/hooks';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { WILDCARD_EXCLUDED_EVENTS, subscriptionCoversEvent } from '../../common/utils/wildcard-events';
import { RecoveryQueue, recoveryQueueOptions, type RecoveryLoss } from '../../common/utils/recovery-queue';
import { resolveNonNegativeIntEnv } from '../../config/configuration';
import { ParkedDispatch, type ParkedDispatchSteps } from './parked-dispatch';

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
  /**
   * {@link dataHash} of the pre-hook data the delivery's outbox row held when the job was queued. A message delivery
   * whose row holds other data by the time the worker runs was changed since (an edit or a delete through the API
   * rewrote it), and the worker rebuilds the body from the row. Absent on a job queued before it existed, or when
   * what the row held was not known: such a job posts its own body unless the row was closed.
   */
  baseHash?: string;
  /**
   * The message an edit event names in its pre-hook data, which a kept revoke's hold on the worker is matched by: a
   * `webhook:before` hook may have given the body's `messageId` another value. Absent on a job queued before it existed.
   */
  messageId?: string;
}

/**
 * One resolved webhook delivery ready to be persisted into the outbox inside a caller's database
 * transaction and dispatched asynchronously after commit.
 */
export interface PreparedWebhookDelivery {
  webhook: Webhook;
  sessionId: string;
  event: string;
  baseData: Record<string, unknown>;
  deliveryId: string;
  idempotencyKey: string;
  outboxRow: OutboxOpenRow;
  /**
   * What the outbox row holds when it is not `baseData`: the {@link dataHash} of the older data a rewrite of the row
   * failed to replace, or null when this dispatch did not write the row (another dispatch opened it under the same
   * key). Undefined: the row holds `baseData`.
   */
  storedHash?: string | null;
  /** Run when the delivery leaves no durable record (no outbox row, and its failure could not be written either). */
  onUnrecorded?: () => void;
}

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

/** Upper bound on in-memory degraded-receiver tracking so churned webhook ids cannot grow memory without bound. */
export const FAILING_WEBHOOKS_MAX = 10_000;

/**
 * Events not kept while the database refuses their dispatch: a presence that no longer holds once replayed, a linking
 * code that expires within seconds (the next one goes out live), and the per-recipient receipts documented as bounded
 * and never replayed.
 */
export const UNKEPT_EVENTS: readonly string[] = ['presence.update', 'session.qr', 'message.receipt'];

/** Events that describe this node's engine of a session: once another node owns the session, its own go out instead. */
const SESSION_STATE_EVENTS: readonly string[] = [
  'session.status',
  'session.authenticated',
  'session.disconnected',
  'session.reconnect_loop',
  'session.restriction',
];

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
  /** See {@link PreparedWebhookDelivery.onUnrecorded}. */
  onUnrecorded?: () => void;
  /** What the delivery's outbox row holds, as on {@link PreparedWebhookDelivery}. */
  storedHash?: string | null;
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
   * The delivery starts from the copy a failed delivery kept (an operator redrive), not from an open outbox row: its
   * row was closed when the failure was recorded, which says nothing of a change, and the copy is kept current by
   * every change, so the row is not consulted.
   */
  fromKeptCopy?: boolean;
  /**
   * Ends a replay's retry backoff early and gives no further attempt. A replay holds no dispatch
   * slot, so the shutdown drain's limiter close cannot stop it; its owner aborts this instead.
   */
  signal?: AbortSignal;
}

/** Per-delivery options of the direct path (deliverWebhook), derived from the dispatch context. */
interface DirectDeliveryOptions {
  yieldSlot?: <R>(fn: () => Promise<R>) => Promise<R>;
  /**
   * The pre-hook data the delivery was built from, and what its outbox row holds: a retry, and the terminal copy,
   * check the row against it. Absent for a delivery that started from a kept copy, whose row is not consulted.
   */
  baseData?: Record<string, unknown>;
  storedHash?: string | null;
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
  /** Aborted at the start of onModuleDestroy so retry backoff sleeps wake immediately. */
  private readonly shutdownAbort = new AbortController();
  private readonly preflight: DeliveryPreflight;
  /**
   * What the database refused, kept until it answers: this service keeps its dispatches in it, and the message projector
   * its changes, so one pass withdraws or rewrites what a change touches before the events it touches are dispatched.
   */
  private readonly recovery: RecoveryQueue;
  // Per session, the dispatches kept: its new events go after them while there are any, in order.
  private readonly parkedDispatches = new Map<string, Set<ParkedDispatch>>();
  private parkSeq = 0;
  // Whether this node still owns a session (set by the session module); a state event of one it no longer owns is
  // dropped when it is dispatched at last.
  private ownsSession?: (sessionId: string) => boolean;
  private readonly parkSteps: ParkedDispatchSteps = {
    dispatch: parked => this.dispatchKept(parked),
    released: (parked, reason) => this.releaseKept(parked, reason),
  };

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
    this.preflight = new DeliveryPreflight(failureRepository, configService, hookManager, this.logger);
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
    this.recovery = new RecoveryQueue(
      recoveryQueueOptions(
        webhookRepository.manager?.connection?.options?.type === 'postgres',
        // The sweep's grace (WebhookReconcilerService), which the waits on PostgreSQL stay under.
        resolveNonNegativeIntEnv(process.env.WEBHOOK_RECONCILE_GRACE_MS, 60_000),
      ),
    );
  }

  /** The queue of what the database refused, shared with the message projector (see `recovery`). */
  recoveryQueue(): RecoveryQueue {
    return this.recovery;
  }

  /** Tell kept state events of a session this node no longer owns from the rest (see SESSION_STATE_EVENTS). */
  setSessionOwnership(owns: (sessionId: string) => boolean): void {
    this.ownsSession = owns;
  }

  onModuleInit(): void {
    // WEBHOOK_SHUTDOWN_DRAIN_MS (default 5s) bounds how long onModuleDestroy waits for a delivery in
    // flight, while WEBHOOK_TIMEOUT (default 10s) bounds the delivery itself. When the drain is shorter
    // than the timeout, a delivery that takes nearly the full timeout is abandoned at shutdown (logged,
    // not dead-lettered: the receiver may already have it). The defaults cross, the drain being sized to
    // the shutdown budget, so only a changed value is warned about: an operator who raised the timeout
    // without raising the drain notices, and a default install does not warn at every boot.
    const drainMs = this.configService.get<number>('webhook.shutdownDrainMs', DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS);
    const deliveryTimeoutMs = this.configService.get<number>('webhook.timeout', 10_000);
    const atDefaults = drainMs === DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS && deliveryTimeoutMs === 10_000;
    if (!atDefaults && Number.isFinite(drainMs) && Number.isFinite(deliveryTimeoutMs) && drainMs < deliveryTimeoutMs) {
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
    const drainBudgetMs = Math.max(
      0,
      this.configService.get<number>('webhook.shutdownDrainMs', DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS),
    );
    // One pass over the dispatches the database refused, before the limiter closes: an event the database takes now
    // gets its outbox row (the next start replays one this drain cannot deliver), and the loss of the rest is logged.
    const drainStarted = Date.now();
    await this.recovery.drain(drainBudgetMs, ['dispatch']);
    this.shutdownAbort.abort();
    // Opt-in events still waiting for their stage hold nothing durable (no outbox row yet) and are best effort,
    // so they are let go in both modes; the ones already running finish with the rest.
    for (const { stage } of this.optInStages.values()) stage.close();
    for (const { gate } of this.optInSessionStages.values()) gate.close();
    for (const gate of this.degradedSessionGates.values()) gate.close();
    if (!this.queueEnabled) {
      this.dispatchLimiter.close();
    }
    const deadline = drainStarted + drainBudgetMs;
    while (
      this.dispatchLimiter.activeCount > 0 ||
      this.inFlightDeliveries.size > 0 ||
      this.pendingBookkeeping.size > 0
    ) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await setTimeout(Math.min(50, remaining));
    }
    this.dispatchLimiter.close();
    for (const lost of this.inFlightDeliveries.values()) {
      this.logger.error('Webhook delivery abandoned during shutdown', undefined, {
        ...lost,
        action: 'webhook_delivery_abandoned_shutdown',
      });
    }
    this.inFlightDeliveries.clear();
  }

  /** `engineRef`: what the engine reported of the message the event carries, when a handler filed it elsewhere. */
  async dispatch(
    sessionId: string,
    event: string,
    data: Record<string, unknown>,
    options?: { engineRef?: MessageEngineRef | null },
  ): Promise<void> {
    if (!WILDCARD_EXCLUDED_EVENTS.includes(event)) return this.fanOut(sessionId, event, data, null, options?.engineRef);
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
   * Read-only pre-transaction phase of fan-out: load active webhooks for `sessionId`, evaluate
   * subscriptions, filters, and LID lookups, compute the occurrence idempotency key, shed oversized
   * inline media once, and build the per-webhook outbox rows. Performs no database writes and runs
   * no `webhook:before` hooks, so callers can execute it before opening a database transaction.
   *
   * Set `options.throwOnLookupError: true` when preparing for a transactional domain+outbox commit
   * so a webhook lookup DB failure surfaces instead of silently looking like "0 matching webhooks".
   */
  async prepareDeliveries(
    sessionId: string,
    event: string,
    data: Record<string, unknown>,
    only: string | null = null,
    options?: {
      throwOnLookupError?: boolean;
      /** Told when the webhooks could not be read, which otherwise reads as none. */
      onLookupError?: () => void;
      engineRef?: MessageEngineRef | null;
      occurrenceId?: string;
    },
  ): Promise<PreparedWebhookDelivery[]> {
    const webhooks = await this.loadActiveWebhooks(
      sessionId,
      event,
      options?.throwOnLookupError === true,
      options?.onLookupError,
    );
    const matchingWebhooks = await this.filterMatchingWebhooks(
      only === null ? webhooks : webhooks.filter(webhook => webhook.id === only),
      event,
      data,
    );
    if (matchingWebhooks.length === 0) return [];

    // Base idempotency key for this event occurrence. The occurrence id is minted once here and reused for
    // every retry of this dispatch, so recurring lifecycle events get a distinct-per-occurrence key (even two
    // within one clock millisecond) while retries of the same event stay stable. It is salted PER WEBHOOK below.
    const baseIdempotencyKey = generateIdempotencyKey(
      event,
      { ...data, sessionId },
      options?.occurrenceId ?? randomUUID(),
    );

    // Fan-out amplification bound: shed an over-cap inline media blob ONCE here, before the
    // per-webhook structuredClone in preflightDelivery, so N matching webhooks (and queued jobs retained
    // in Redis) never copy the blob. The per-webhook clone stays so a webhook:before hook mutating
    // payload.data in place cannot bleed into siblings.
    const baseData = shedInlineMedia(
      data,
      this.configService.get<number>('webhook.mediaInlineMaxBytes', DEFAULT_WEBHOOK_MEDIA_INLINE_MAX_BYTES),
    );

    return matchingWebhooks.map(webhook => {
      const deliveryId = generateDeliveryId();
      // Salt per webhook so sibling subscriptions cannot collide at the receiver's dedup boundary.
      const idempotencyKey = `${baseIdempotencyKey}_${webhook.id}`;
      const outboxRow: OutboxOpenRow = {
        webhookId: webhook.id,
        sessionId,
        event,
        idempotencyKey,
        deliveryId,
        payload: baseData,
        engineRef: options?.engineRef ?? null,
      };
      return {
        webhook,
        sessionId,
        event,
        baseData,
        deliveryId,
        idempotencyKey,
        outboxRow,
      };
    });
  }

  /**
   * Persist prepared outbox rows via conflict-ignoring batch insert. Passing `manager` binds the
   * outbox write to the caller's database transaction so the domain row and its outbox intent commit
   * or roll back atomically.
   *
   * Returns only the subset of `prepared` items whose `(webhookId, idempotencyKey)` rows were newly
   * inserted (so callers know which outbox rows this attempt owns when cancelling), or `null` when
   * a standalone (non-transactional) DB error was swallowed so callers can preserve fail-open flow.
   */
  async openPrepared(
    prepared: readonly PreparedWebhookDelivery[],
    manager?: EntityManager,
  ): Promise<PreparedWebhookDelivery[] | null> {
    if (prepared.length === 0) return [];
    const rows = prepared.map(item => item.outboxRow);
    if (typeof this.outbox.openBatch === 'function') {
      const inserted = await this.outbox.openBatch(rows, manager);
      const insertedKeys = new Set((inserted ?? []).map(row => `${row.webhookId}\u0000${row.idempotencyKey}`));
      const opened = prepared.filter(item => {
        const key = `${item.webhook.id}\u0000${item.idempotencyKey}`;
        if (!insertedKeys.has(key)) return false;
        insertedKeys.delete(key);
        return true;
      });
      // A row this dispatch did not write holds whatever its writer put there: a check before a send cannot read a
      // change from it, only that it was closed.
      for (const item of prepared) if (!opened.includes(item)) item.storedHash = null;
      // No row could be written: the deliveries keep their copy in memory, which a change of the message still reaches.
      if (inserted === null) {
        this.outbox.holdUnwritten(rows);
        for (const item of prepared) item.storedHash = undefined;
        return null;
      }
      return opened;
    }
    if (manager) {
      throw new Error('WebhookOutboxService.openBatch is required for transactional outbox writes');
    }
    await Promise.all(rows.map(row => this.outbox.open(row)));
    return [...prepared];
  }

  /**
   * Reconcile already-committed pending outbox rows after a mid-flight mutation (REST revoke or
   * message edit) changed the message between transaction commit and dispatch. Re-evaluates webhook
   * filters against `finalData`, closes owned outbox rows for webhooks that no longer match, updates
   * pending outbox payloads in place for webhooks that still match, and opens rows for any newly
   * matching webhooks, unless `openNew` is false. On a transient webhook lookup error, committed outbox
   * rows are never closed: their stored payloads are updated in place to `finalData` and returned for live
   * dispatch.
   */
  async reconcilePrepared(
    committed: readonly PreparedWebhookDelivery[],
    sessionId: string,
    event: string,
    finalData: Record<string, unknown>,
    owned?: readonly PreparedWebhookDelivery[],
    openNew = true,
    engineRef?: MessageEngineRef | null,
  ): Promise<PreparedWebhookDelivery[]> {
    const keyOf = (item: Pick<PreparedWebhookDelivery, 'webhook' | 'idempotencyKey'>): string =>
      `${item.webhook.id}\u0000${item.idempotencyKey}`;
    const ownedKeys = owned ? new Set(owned.map(keyOf)) : null;
    const isOwned = (item: PreparedWebhookDelivery): boolean => ownedKeys === null || ownedKeys.has(keyOf(item));

    let fresh: PreparedWebhookDelivery[];
    try {
      fresh = await this.prepareDeliveries(sessionId, event, finalData, null, { throwOnLookupError: true, engineRef });
    } catch (error) {
      this.logger.warn(
        `Could not reload webhooks while reconciling ${event} for session ${sessionId}; preserving committed outbox rows`,
        { sessionId, event, error: String(error) },
      );
      if (committed.length === 0) return [];
      const baseData = shedInlineMedia(
        finalData,
        this.configService.get<number>('webhook.mediaInlineMaxBytes', DEFAULT_WEBHOOK_MEDIA_INLINE_MAX_BYTES),
      );
      const preserved = committed.map(prev => ({
        ...prev,
        baseData,
        outboxRow: { ...prev.outboxRow, payload: baseData },
      }));
      if (typeof this.outbox.updatePendingPayload === 'function') {
        await Promise.all(preserved.map((item, i) => this.rewriteCommitted(item, committed[i], isOwned(committed[i]))));
      }
      return preserved;
    }

    const committedByKey = new Map(committed.map(item => [keyOf(item), item]));
    const freshByKey = new Map(fresh.map(item => [keyOf(item), item]));

    const removed: PreparedWebhookDelivery[] = [];
    for (const [key, prev] of committedByKey) {
      if (!freshByKey.has(key) && isOwned(prev)) removed.push(prev);
    }
    const updated: PreparedWebhookDelivery[] = [];
    const added: PreparedWebhookDelivery[] = [];
    for (const [key, next] of freshByKey) {
      const prev = committedByKey.get(key);
      if (prev) {
        // Keep the committed deliveryId so the pending outbox row and dispatched attempt stay aligned.
        updated.push({
          ...next,
          deliveryId: prev.deliveryId,
          outboxRow: { ...next.outboxRow, deliveryId: prev.deliveryId },
        });
      } else {
        added.push(next);
      }
    }

    if (removed.length > 0) {
      await Promise.all(removed.map(item => this.outbox.close(item.webhook.id, item.idempotencyKey, 'dispatched')));
    }
    if (updated.length > 0 && typeof this.outbox.updatePendingPayload === 'function') {
      await Promise.all(
        updated.map(item => {
          const prev = committedByKey.get(keyOf(item))!;
          return this.rewriteCommitted(item, prev, isOwned(prev));
        }),
      );
    }
    if (!openNew) return updated;
    if (added.length > 0) {
      await this.openPrepared(added);
    }
    return [...updated, ...added];
  }

  /**
   * Rewrite a committed row this commit owns to `item`'s data, and record on `item` what the row holds after: its
   * data, the older data when the rewrite did not land, or nothing known for a row the commit does not own (left as
   * it was).
   */
  private async rewriteCommitted(
    item: PreparedWebhookDelivery,
    prev: PreparedWebhookDelivery,
    owned: boolean,
  ): Promise<void> {
    if (!owned) {
      item.storedHash = null;
      return;
    }
    const rewritten = await this.outbox.updatePendingPayload(item.webhook.id, item.idempotencyKey, item.baseData);
    item.storedHash = rewritten ? undefined : prev.storedHash === undefined ? dataHash(prev.baseData) : prev.storedHash;
  }

  /**
   * Post-commit async dispatch phase for prepared deliveries: runs `webhook:before` preflight hooks
   * (strictly outside any DB transaction), enqueues into BullMQ or delivers directly within the
   * concurrency limiter, and retires settled outbox rows.
   */
  async dispatchPrepared(prepared: readonly PreparedWebhookDelivery[]): Promise<void> {
    if (prepared.length === 0) return;
    // allSettled preserves per-webhook isolation: one failing delivery never rejects the others.
    await Promise.allSettled(
      prepared.map(async item => {
        const { webhook, deliveryId, idempotencyKey, sessionId, event, baseData, storedHash, onUnrecorded } = item;
        const ctx: DispatchEventContext = { sessionId, event, baseData, storedHash, onUnrecorded };
        this.locallyPending.set(idempotencyKey, (this.locallyPending.get(idempotencyKey) ?? 0) + 1);
        try {
          await this.runLimited(webhook, deliveryId, idempotencyKey, ctx);
        } finally {
          const left = (this.locallyPending.get(idempotencyKey) ?? 1) - 1;
          if (left > 0) this.locallyPending.set(idempotencyKey, left);
          else this.locallyPending.delete(idempotencyKey);
        }
      }),
    );
  }

  /**
   * Retire prepared outbox rows whose delivery was suppressed before dispatch (for example, a message
   * revoked mid-flight between commit and announcement), so the reconciler never replays them.
   */
  async cancelPrepared(prepared: readonly PreparedWebhookDelivery[]): Promise<void> {
    if (prepared.length === 0) return;
    await Promise.all(prepared.map(item => this.outbox.close(item.webhook.id, item.idempotencyKey, 'dispatched')));
  }

  /**
   * Close any still-open message outbox rows when an engine revoke arrives for a message, and drop the event data
   * its failed deliveries keep for a redrive.
   */
  closePendingForMessage(sessionId: string, waMessageId: string, shouldApply?: MessageCopyPredicate): Promise<void> {
    return this.changeCopiesQuietly(sessionId, waMessageId, { kind: 'close' }, shouldApply);
  }

  /**
   * Redact payloads on any still-open message outbox rows when a REST delete clears a message, and the event data
   * its failed deliveries keep for a redrive.
   */
  redactPendingForMessage(sessionId: string, waMessageId: string, shouldApply?: MessageCopyPredicate): Promise<void> {
    return this.changeCopiesQuietly(sessionId, waMessageId, { kind: 'redact' }, shouldApply);
  }

  /** Write an edit of a stored message into its open outbox rows and the event data its failed deliveries keep. */
  rewritePendingForMessage(
    sessionId: string,
    waMessageId: string,
    body: string,
    shouldApply?: MessageCopyPredicate,
  ): Promise<void> {
    return this.changeCopiesQuietly(sessionId, waMessageId, { kind: 'rewrite', body }, shouldApply);
  }

  /**
   * Apply a change of a message to every copy its deliveries hold: its open outbox rows, and the event data its failed
   * deliveries keep for a redrive (dropped on a close), each judged by `shouldApply` on its payload, so neither the
   * sweep, a queued job nor a redrive sends what the sender took back. Throws when the database fails, for a caller that
   * keeps the change to try again.
   */
  async changeMessageCopies(
    sessionId: string,
    waMessageId: string,
    change: MessageCopyChange,
    shouldApply?: MessageCopyPredicate,
  ): Promise<void> {
    if (!waMessageId) return;
    // A rewrite (an edit) can change what a webhook's filters read: a copy they no longer take is closed or dropped.
    const passes = change.kind === 'rewrite' ? this.webhookStillTakes() : undefined;
    // First what is held in memory: the events kept from a database that refused them, and the copies of deliveries
    // whose outbox rows could not be written. Neither needs the database to change.
    await this.changeKeptDispatches(sessionId, waMessageId, change, shouldApply);
    await this.outbox.changeUnwrittenForMessage(sessionId, waMessageId, change, shouldApply, passes);
    await this.outbox.changeOpenForMessage(sessionId, waMessageId, change, shouldApply, passes);
    const { pattern, keyFor } = messageDeliveryKeys(sessionId, waMessageId);
    const rows = await this.failureRepository
      .createQueryBuilder('f')
      .select(['f.id', 'f.webhookId', 'f.idempotencyKey', 'f.event'])
      .addSelect('f.payload')
      .where('f.sessionId = :sessionId', { sessionId })
      .andWhere('f.event IN (:...events)', { events: MESSAGE_DELIVERY_EVENTS })
      .andWhere('f.payload IS NOT NULL')
      .andWhere("f.idempotencyKey LIKE :pattern ESCAPE '\\'", { pattern })
      .getMany();
    const kept = rows.filter(row => row.payload && row.idempotencyKey === keyFor(row.webhookId));
    const engineRefs =
      shouldApply && kept.length ? await this.outbox.engineRefsFor(kept) : new Map<string, MessageEngineRef>();
    for (const row of kept) {
      if (!row.payload) continue;
      const engineRef = engineRefs.get(`${row.webhookId}\u0000${row.idempotencyKey}`);
      if (shouldApply && !(await shouldApply(row.payload, engineRef))) continue;
      const payload = changedMessagePayload(row.payload, change);
      await this.failureRepository.update({ id: row.id }, {
        payload: payload && passes && !(await passes(row, payload)) ? null : payload,
      } as QueryDeepPartialEntity<WebhookDeliveryFailure>);
    }
    if (change.kind !== 'rewrite') await this.dropKeptEditCopies(sessionId, waMessageId, shouldApply);
  }

  /**
   * A message taken back takes the copies its failed message.edited deliveries keep with it (see the outbox's
   * closeOpenEditsForMessage): a redrive sends none of them.
   */
  private async dropKeptEditCopies(
    sessionId: string,
    waMessageId: string,
    shouldApply?: MessageCopyPredicate,
  ): Promise<void> {
    const rows = await this.failureRepository
      .createQueryBuilder('f')
      .select(['f.id', 'f.webhookId', 'f.idempotencyKey'])
      .addSelect('f.payload')
      .where('f.sessionId = :sessionId', { sessionId })
      .andWhere('f.event IN (:...events)', { events: MESSAGE_CHANGE_EVENTS })
      .andWhere('f.payload IS NOT NULL')
      .andWhere("f.idempotencyKey LIKE :pattern ESCAPE '\\'", { pattern: messageEditKeys(sessionId, waMessageId) })
      .getMany();
    const kept = rows.filter(row => row.payload?.messageId === waMessageId);
    const engineRefs =
      shouldApply && kept.length ? await this.outbox.engineRefsFor(kept) : new Map<string, MessageEngineRef>();
    for (const row of kept) {
      const engineRef = engineRefs.get(`${row.webhookId}\u0000${row.idempotencyKey}`);
      if (shouldApply && !(await shouldApply(row.payload!, engineRef))) continue;
      await this.failureRepository.update(
        { id: row.id },
        {
          payload: null,
        },
      );
    }
  }

  /** Whether a delivery's webhook, read once per change, still takes a rewritten copy: its subscription and filters. */
  private webhookStillTakes(): MessageCopyFilter {
    const webhooks = new Map<string, Promise<Webhook | null>>();
    return async ({ webhookId, event }, payload) => {
      if (!webhooks.has(webhookId))
        webhooks.set(webhookId, this.webhookRepository.findOne({ where: { id: webhookId } }));
      const webhook = await webhooks.get(webhookId)!;
      // A webhook removed since takes nothing more anyway: its deliveries are skipped when they are tried.
      return !webhook || (await this.filterMatchingWebhooks([webhook], event, payload)).length > 0;
    };
  }

  /** {@link changeMessageCopies}, best-effort: a failure is logged. */
  private changeCopiesQuietly(
    sessionId: string,
    waMessageId: string,
    change: MessageCopyChange,
    shouldApply?: MessageCopyPredicate,
  ): Promise<void> {
    return this.changeMessageCopies(sessionId, waMessageId, change, shouldApply).catch((error: unknown) =>
      this.logger.warn(`Could not change the delivery copies of message ${waMessageId}: ${String(error)}`),
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
    engineRef?: MessageEngineRef | null,
  ): Promise<void> {
    const kept = !UNKEPT_EVENTS.includes(event);
    // While the session has events kept from a database that refused them, a new one goes after them, in order.
    if (kept && this.parkedDispatches.get(sessionId)?.size) {
      this.keepDispatch(sessionId, event, data, only, engineRef ?? null, randomUUID());
      return;
    }
    // Minted once, so a dispatch tried again once the database answers sends the same key.
    const occurrenceId = randomUUID();
    let lookupFailed = false;
    const prepared = await this.prepareDeliveries(sessionId, event, data, only, {
      engineRef,
      occurrenceId,
      onLookupError: () => (lookupFailed = true),
    });
    // The webhooks could not be read (logged by the lookup): nothing is sent and nothing durable exists yet.
    if (lookupFailed) {
      if (kept) this.keepDispatch(sessionId, event, data, only, engineRef ?? null, occurrenceId);
      else this.noteUnkept(sessionId, event);
      return;
    }
    // The awaits below hold this frame, parameters included, until every delivery settles: point
    // `data` at the shed copy so parked deliveries pin only that, not the caller's full blob.
    // eslint-disable-next-line no-useless-assignment
    data = prepared[0]?.baseData ?? data;
    if (prepared.length === 0) return;
    // Record best-effort replay rows without filtering dispatch on outbox conflicts: webhook_outbox_events
    // retains settled rows for 7 days, Note-to-Self message.received/message.sent share one key, and
    // recurring events (session.qr, message.ack, call.*, poll.vote) legitimately repeat within that window.
    const opened = await this.openPrepared(prepared);
    // No outbox row could be written: the delivery still goes out now, and one that then leaves no durable record of
    // its failure either is kept for its webhook, under the same key, until the database answers.
    if (opened === null && kept) {
      for (const item of prepared) {
        item.onUnrecorded = () => {
          // As a change of the message left it; nothing once it was taken back.
          const copy = this.outbox.unwrittenCopy(item.webhook.id, item.idempotencyKey);
          this.outbox.forgetUnwritten(item.webhook.id, item.idempotencyKey);
          if (copy === null) return;
          this.keepDispatch(sessionId, event, copy ?? item.baseData, item.webhook.id, engineRef ?? null, occurrenceId);
        };
      }
    }
    await this.dispatchPrepared(prepared);
  }

  /** Keep an event whose dispatch the database refused, with its inline media shed (see ParkedDispatch). */
  private keepDispatch(
    sessionId: string,
    event: string,
    data: Record<string, unknown>,
    only: string | null,
    engineRef: MessageEngineRef | null,
    occurrenceId: string,
  ): void {
    const parked = new ParkedDispatch(
      `${sessionId}#${++this.parkSeq}`,
      sessionId,
      event,
      shedInlineMedia(
        data,
        this.configService.get<number>('webhook.mediaInlineMaxBytes', DEFAULT_WEBHOOK_MEDIA_INLINE_MAX_BYTES),
      ),
      occurrenceId,
      engineRef,
      only,
      Date.now(),
      this.parkSteps,
    );
    let session = this.parkedDispatches.get(sessionId);
    if (!session) {
      this.parkedDispatches.set(sessionId, (session = new Set()));
      this.logger.warn('Keeping the webhook events the database refused, to dispatch them once it answers', {
        sessionId,
        event,
        action: 'webhook_dispatch_parked',
      });
    }
    session.add(parked);
    this.recovery.park(parked.key, parked);
  }

  /** Dispatch a kept event: its webhooks read again, its outbox rows opened, then its deliveries started. */
  private async dispatchKept(parked: ParkedDispatch): Promise<void> {
    const { sessionId, event, data, only, engineRef, occurrenceId } = parked;
    if (SESSION_STATE_EVENTS.includes(event) && this.ownsSession && !this.ownsSession(sessionId)) {
      this.noteDropped(sessionId, event, 'ownership');
      return;
    }
    const prepared = await this.prepareDeliveries(sessionId, event, data, only, {
      engineRef,
      occurrenceId,
      throwOnLookupError: true,
    });
    // Written through the repository's manager so a failure throws, and the event stays kept.
    if ((await this.openPrepared(prepared, this.webhookRepository.manager)) === null) {
      throw new Error('The outbox rows of a kept webhook event could not be written');
    }
    void this.dispatchPrepared(prepared);
  }

  /** A kept event left the queue: a loss is logged and counted as a delivery that failed. */
  private releaseKept(parked: ParkedDispatch, reason?: RecoveryLoss): void {
    const session = this.parkedDispatches.get(parked.sessionId);
    session?.delete(parked);
    if (session?.size === 0) this.parkedDispatches.delete(parked.sessionId);
    if (reason) this.noteDropped(parked.sessionId, parked.event, reason);
  }

  private noteUnkept(sessionId: string, event: string): void {
    this.noteDropped(sessionId, event, 'not kept');
  }

  private noteDropped(sessionId: string, event: string, reason: RecoveryLoss | 'not kept' | 'ownership'): void {
    const meta = { sessionId, event, reason, action: 'webhook_dispatch_dropped' };
    // Another node announces its own engine's state: nothing a receiver needed is lost.
    if (reason === 'ownership') {
      this.logger.warn('Dropping a kept state event of a session this node no longer owns', meta);
      return;
    }
    incrementWebhookDeliveryFailures();
    this.logger.error('A webhook event the database refused was dropped', undefined, meta);
  }

  /**
   * The copies a kept event of the message holds take a change as an outbox copy does: judged by the engine's chat
   * when a handler filed the message elsewhere, else by the payload; a close withdraws the event. Its webhooks' filters
   * are read when it is dispatched.
   */
  private async changeKeptDispatches(
    sessionId: string,
    waMessageId: string,
    change: MessageCopyChange,
    shouldApply?: MessageCopyPredicate,
  ): Promise<void> {
    for (const parked of [...(this.parkedDispatches.get(sessionId) ?? [])]) {
      // A message taken back takes its kept edit events with it; an edit leaves them, each its own occurrence.
      const edit = MESSAGE_CHANGE_EVENTS.includes(parked.event) && parked.data.messageId === waMessageId;
      if (!(edit && change.kind !== 'rewrite')) {
        if (!MESSAGE_DELIVERY_EVENTS.includes(parked.event) || parked.data.id !== waMessageId) continue;
      }
      if (shouldApply && !(await shouldApply(parked.data, parked.engineRef))) continue;
      const data = edit ? null : changedMessagePayload(parked.data, change);
      if (!data) {
        this.recovery.settle('dispatch', parked.key);
        continue;
      }
      parked.data = data;
      parked.measure();
      this.recovery.remeasure('dispatch', parked.key);
    }
  }

  /**
   * Drop the session's cached opt-in subscriptions. WebhookService calls this after every webhook
   * create, update and delete, so a change made on this node applies to the next event.
   */
  invalidateOptInSubscriptions(sessionId: string): void {
    this.optInSubscriptions.delete(sessionId);
  }

  /**
   * Drop degraded-receiver tracking for a deleted webhook so its id is not retained in memory.
   */
  forgetWebhook(webhookId: string): void {
    this.failingWebhooks.delete(webhookId);
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
   * Callers fire-and-forget `dispatch(...)`, so a failure looking up webhooks is logged and
   * swallowed by default to avoid unhandled rejections. Transactional callers pass
   * `throwOnError = true` so a transient DB lookup fault is never mistaken for "0 matching webhooks".
   */
  private async loadActiveWebhooks(
    sessionId: string,
    event: string,
    throwOnError = false,
    onError?: () => void,
  ): Promise<Webhook[]> {
    try {
      return await this.webhookRepository.find({
        where: { sessionId, active: true },
      });
    } catch (error) {
      this.logger.error(`Webhook dispatch lookup failed for ${event}`, String(error), {
        sessionId,
        action: 'webhook_dispatch_lookup_failed',
      });
      if (throwOnError) throw error;
      onError?.();
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
    const preflight = await this.preflight.preflightDelivery(webhook, deliveryId, idempotencyKey, ctx);
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
    let markedQueued = false;
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
        ...this.heldHash(ctx),
        ...(MESSAGE_CHANGE_EVENTS.includes(event) && typeof ctx.baseData.messageId === 'string'
          ? { messageId: ctx.baseData.messageId }
          : {}),
      };

      await producerReady(this.webhookQueue!);
      await this.outbox.markQueued(webhook.id, idempotencyKey, deliveryId);
      markedQueued = true;
      await this.webhookQueue!.add(`webhook-${webhook.id}`, jobData, {
        // jobId = deliveryId makes this add() idempotent within BullMQ (same precedent as the ingress
        // producer). It does not dedup a crash replay: if the process dies before the outbox row is
        // closed, the reconciler re-enqueues the event under a new deliveryId as a second job, with
        // the same idempotency key, which is what receivers dedup on. Safe for fan-out: deliveryId is
        // minted per webhook per dispatch in prepareDeliveries, so sibling subscriptions to one event
        // never share a job id.
        jobId: deliveryId,
        attempts: webhook.retryCount,
        backoff: {
          type: 'exponential',
          delay: this.configService.get<number>('webhook.retryDelay', 5000),
        },
      });

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
      if (markedQueued) await this.outbox.markPending(webhook.id, idempotencyKey, deliveryId);
      // A replay or dispatch whose owner stopped while the add was out (it can wait for a first
      // connect, or on a stalled Redis) must not POST or run hooks after the drain: the caller
      // keeps the outbox row pending for the next start.
      ctx.signal?.throwIfAborted();
      this.shutdownAbort.signal.throwIfAborted();
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
      ctx.signal?.throwIfAborted();
      this.shutdownAbort.signal.throwIfAborted();
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
        // Shutdown closed the limiter or aborted the delivery/replay during a retry backoff: not a delivery
        // failure. runLimited or the replay's caller keeps the outbox row pending for the next start.
        if (
          isLimiterClosed(fallbackError) ||
          isAbortedBackoff(fallbackError, ctx.signal) ||
          isAbortedBackoff(fallbackError, this.shutdownAbort.signal)
        ) {
          throw fallbackError;
        }
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

  /** The hash of what the delivery's outbox row holds, for the worker's check; none when it is not known. */
  private heldHash(ctx: DispatchEventContext): { baseHash?: string } {
    const baseHash = ctx.storedHash === undefined ? dataHash(ctx.baseData) : ctx.storedHash;
    return baseHash ? { baseHash } : {};
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
      // Shutdown closed the limiter or aborted the delivery/replay during a retry backoff: not a delivery
      // failure. runLimited or the replay's caller keeps the outbox row pending for the next start.
      if (
        isLimiterClosed(error) ||
        isAbortedBackoff(error, ctx.signal) ||
        isAbortedBackoff(error, this.shutdownAbort.signal)
      ) {
        throw error;
      }
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

  /** True while a dispatch on this node still owns the outbox row for this key. */
  isLocallyPending(idempotencyKey: string): boolean {
    return this.locallyPending.has(idempotencyKey);
  }

  /** See WebhookOutboxService.holdMessage. */
  holdMessage(sessionId: string, waMessageId: string, held: MessageHold | false): void {
    this.outbox.holdMessage(sessionId, waMessageId, held);
  }

  /** See WebhookOutboxService.isMessageHeld. */
  isMessageHeld(
    idempotencyKey: string,
    webhookId: string,
    delivery?: { sessionId: string; event: string; data?: Record<string, unknown> | null },
  ): boolean {
    return this.outbox.isMessageHeld(idempotencyKey, webhookId, delivery);
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
    // A free slot starts the task in this very call; one that waited for its slot may find its message changed since.
    let parked = false;
    const admitted = overBudget
      ? Promise.reject(new Error('ConcurrencyLimiter queue full'))
      : this.gateFailingReceiver(webhook, sessionId, gated =>
          this.dispatchLimiter.run(async yieldSlot => {
            const waited = parked;
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
              let occurrence = ctx;
              if (waited) {
                let changed = await this.messageChange(webhook.id, idempotencyKey, ctx);
                // A change of the message kept on this node may withdraw or rewrite it: wait for it, without the slot.
                while (
                  changed !== null &&
                  this.isMessageHeld(idempotencyKey, webhook.id, { ...ctx, data: ctx.baseData })
                ) {
                  const delay = this.configService.get<number>('webhook.retryDelay', 5000);
                  await yieldSlot(() => setTimeout(delay, undefined, { signal: this.shutdownAbort.signal }));
                  changed = await this.messageChange(webhook.id, idempotencyKey, ctx);
                }
                if (changed === null) {
                  this.logSkippedRetracted(webhook.id, event, deliveryId, idempotencyKey);
                  return;
                }
                if (changed && changed !== 'unread') occurrence = { ...ctx, baseData: changed, storedHash: undefined };
              }
              const outcome = await this.deliverOne(target, deliveryId, idempotencyKey, { ...occurrence, yieldSlot });
              // Retire only after queue ownership, success, cancellation or a durable terminal row.
              if (outcome !== 'unrecorded' && outcome !== 'enqueued')
                await this.outbox.close(webhook.id, idempotencyKey, 'dispatched');
              if (outcome === 'unrecorded') ctx.onUnrecorded?.();
            } finally {
              this.inFlightDeliveries.delete(deliveryId);
            }
          }),
        );
    parked = true;
    await admitted.catch(async error => {
      if (error instanceof Error && error.message === 'ConcurrencyLimiter queue full') {
        // Shed before the task ran, so nothing was POSTed. The failure row reports the shed, but
        // the outbox row stays 'pending' on purpose: retiring it would drop the only copy of an
        // event the receiver provably never got. The sweep replays it once the backlog clears.
        await this.preflight.recordUndelivered(
          webhook,
          deliveryId,
          idempotencyKey,
          error,
          'webhook_dispatch_capacity_exceeded',
          ctx,
        );
        return;
      }
      if (isLimiterClosed(error) || isAbortedBackoff(error, this.shutdownAbort.signal)) {
        // Rejected by the shutdown drain before dispatching, or woken from a retry backoff after
        // it: record it like any other undelivered delivery, and track the write so
        // onModuleDestroy can await it (the limiter slot bookkeeping no longer covers this task).
        // Its outbox row stays 'pending': no POST was accepted, so the next start's sweep is what
        // finally delivers the event.
        const record = this.preflight.recordUndelivered(
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
    options: { singleAttempt?: boolean; oneDirectAttempt?: boolean; fromKeptCopy?: boolean; signal?: AbortSignal } = {},
  ): Promise<WebhookDeliveryOutcome> {
    const deliveryId = generateDeliveryId();
    try {
      const outcome = await this.deliverOne(webhook, deliveryId, idempotencyKey, {
        sessionId,
        event,
        baseData: data,
        singleAttempt: options.singleAttempt,
        oneDirectAttempt: options.oneDirectAttempt,
        fromKeptCopy: options.fromKeptCopy,
        signal: options.signal,
      });
      // The receiver has the event. An operator redrive of a failure row can find the same delivery
      // still pending in the outbox, which the next sweep would otherwise POST again.
      if (outcome === 'delivered') await this.outbox.close(webhook.id, idempotencyKey, 'dispatched');
      return outcome;
    } catch (error) {
      if (!options.signal?.aborted && isAbortedBackoff(error, this.shutdownAbort.signal)) {
        return 'unrecorded';
      }
      throw error;
    }
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
    if (existing > 0) {
      if (this.keepsFailurePayload()) {
        try {
          await this.failureRepository.update(
            {
              webhookId: row.webhookId,
              idempotencyKey: row.idempotencyKey,
              attempts: MoreThan(0),
              payload: IsNull(),
              createdAt: MoreThan(new Date(Date.now() - this.payloadRetentionHours() * 60 * 60 * 1000)),
            },
            { payload: row.payload } as QueryDeepPartialEntity<WebhookDeliveryFailure>,
          );
        } catch (error) {
          this.logger.error(
            'Failed to retain webhook replay payload',
            error instanceof Error ? error.message : String(error),
          );
          return false;
        }
      }
      return true;
    }
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
      ...(this.keepsFailurePayload()
        ? { payload: row.payload, payloadRetentionHours: this.payloadRetentionHours() }
        : {}),
    });
    if (recorded === true) incrementWebhookDeliveryFailures();
    return recorded !== null;
  }

  /**
   * WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS > 0: a terminal failure row keeps the event data it was
   * built from, so an operator can redrive it. Off (0) by default, which stores nothing new.
   */
  private keepsFailurePayload(): boolean {
    return this.payloadRetentionHours() > 0;
  }

  private payloadRetentionHours(): number {
    return this.configService.get<number>('webhook.failurePayloadRetentionHours', 0);
  }

  /** What the direct path needs from the dispatch context: the slot, the replay copy, the attempt cap. */
  private directOptions(ctx: DispatchEventContext): DirectDeliveryOptions {
    return {
      yieldSlot: ctx.yieldSlot,
      baseData: ctx.fromKeptCopy ? undefined : ctx.baseData,
      storedHash: ctx.storedHash,
      replayData: this.keepsFailurePayload() ? ctx.baseData : undefined,
      singleAttempt: ctx.singleAttempt || ctx.oneDirectAttempt,
      signal: ctx.signal,
    };
  }

  /**
   * What a message delivery takes from its outbox row before it is sent again (see changedData): null once the message
   * was taken back, the data a change rewrote the row with, else undefined. 'unread' for a row that cannot be read: the
   * delivery goes on with what it holds, unless a change of the message is held on this node (isMessageHeld).
   */
  private async messageChange(
    webhookId: string,
    idempotencyKey: string,
    held: Pick<DispatchEventContext, 'sessionId' | 'event' | 'baseData' | 'storedHash'>,
  ): Promise<Record<string, unknown> | null | undefined | 'unread'> {
    try {
      const row = await this.outbox.currentMessagePayload(webhookId, idempotencyKey, held.event);
      return changedData(row, held.storedHash === undefined ? dataHash(held.baseData) : held.storedHash);
    } catch (error) {
      if (this.isMessageHeld(idempotencyKey, webhookId, { ...held, data: held.baseData })) return 'unread';
      this.logger.warn('Could not read the outbox row of a message delivery; sending what it holds', {
        webhookId,
        idempotencyKey,
        error: error instanceof Error ? error.message : String(error),
        action: 'webhook_outbox_check_failed',
      });
      return 'unread';
    }
  }

  private logSkippedRetracted(webhookId: string, event: string, deliveryId: string, idempotencyKey: string): void {
    this.logger.warn('Skipping webhook delivery: its outbox row was closed (message taken back or delivered)', {
      webhookId,
      event,
      deliveryId,
      idempotencyKey,
      action: 'webhook_skipped_retracted',
    });
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
    const backoffSignal = options.signal
      ? AbortSignal.any([this.shutdownAbort.signal, options.signal])
      : this.shutdownAbort.signal;
    let current = webhook;
    let { baseData, storedHash, replayData } = options;
    for (let attempt = 1; ; attempt++) {
      if (attempt > 1 && baseData) {
        // The message may have been revoked, deleted through the API or edited during the backoff.
        const changed = await this.messageChange(webhook.id, payload.idempotencyKey, {
          sessionId: payload.sessionId,
          event: payload.event,
          baseData,
          storedHash,
        });
        if (changed === null) {
          this.logSkippedRetracted(webhook.id, payload.event, payload.deliveryId, payload.idempotencyKey);
          return false;
        }
        if (
          this.isMessageHeld(payload.idempotencyKey, webhook.id, {
            sessionId: payload.sessionId,
            event: payload.event,
            data: baseData,
          })
        ) {
          // A change of the message kept on this node may still withdraw or rewrite this copy. Not an attempt: the
          // backoff that came before this one again, then the same check.
          await yieldSlot(() => setTimeout(delay * 2 ** (attempt - 2), undefined, { signal: backoffSignal }));
          attempt--;
          continue;
        }
        if (changed && changed !== 'unread') {
          const rebuilt = await this.preflight.preflightDelivery(current, payload.deliveryId, payload.idempotencyKey, {
            sessionId: payload.sessionId,
            event: payload.event,
            baseData: changed,
          });
          if (rebuilt === 'unrecorded') throw new UnrecordedWebhookFailure('a rebuilt delivery could not be recorded');
          // Cancelled by a plugin, or refused and recorded as undelivered: nothing more to send.
          if (!rebuilt || rebuilt === 'cancelled') return false;
          ({ finalPayload: payload, body } = rebuilt);
          baseData = changed;
          storedHash = undefined;
          if (replayData) replayData = changed;
        }
      }
      try {
        // A read that fails spends no attempt: the delivery goes out with the row read last, as a parked one does.
        const row = await this.webhookRepository.findOne({ where: { id: webhook.id } }).catch((error: unknown) => {
          this.logger.warn('Could not re-read the webhook before a delivery attempt; using the row read last', {
            webhookId: webhook.id,
            deliveryId: payload.deliveryId,
            error: error instanceof Error ? error.message : String(error),
            action: 'webhook_stale_check_failed',
          });
          return current;
        });
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
        // A retry gives way once its replay's owner or shutdown has stopped, even when the backoff ended first.
        if (attempt > 1) backoffSignal.throwIfAborted();
        await postWebhookPayload(current.url, body, headers, this.configService.get<number>('webhook.timeout', 10000));
        this.failingWebhooks.delete(webhook.id);

        // The receiver already answered 2xx: the delivery SUCCEEDED. A bookkeeping failure here (e.g.
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
        if (isAbortedBackoff(error, backoffSignal)) throw error;
        this.markFailingWebhook(webhook.id);
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
          // An aborted shutdown or replay signal ends the backoff the same way.
          await yieldSlot(() => setTimeout(delay * 2 ** (attempt - 1), undefined, { signal: backoffSignal }));
          continue;
        }
        // All direct-path retries exhausted. Persist a durable failure record before giving up, mirroring
        // the queued processor's final-attempt path so the queue-disabled path isn't a blind spot.
        // The recorder writes this row first and only then removes an attempts-0 row of the same
        // delivery (a shed or refused dispatch), so a restart at any point keeps a record. A message's
        // copy for a redrive is the one a change left on its outbox row, none once it was taken back.
        if (replayData && baseData) {
          const changed = await this.messageChange(webhook.id, payload.idempotencyKey, {
            sessionId: payload.sessionId,
            event: payload.event,
            baseData,
            storedHash,
          });
          if (changed !== undefined && changed !== 'unread') replayData = changed ?? undefined;
        }
        const recorded = await recordTerminalFailure(this.failureRepository, this.logger, {
          webhookId: webhook.id,
          sessionId: payload.sessionId,
          event: payload.event,
          url: current.url,
          idempotencyKey: payload.idempotencyKey,
          deliveryId: payload.deliveryId,
          attempts: attempt,
          error,
          ...(replayData ? { payload: replayData, payloadRetentionHours: this.payloadRetentionHours() } : {}),
        });
        if (recorded !== false) incrementWebhookDeliveryFailures();
        if (recorded === null) throw new UnrecordedWebhookFailure(redactSsrfError(error));
        throw error;
      }
    }
  }

  private markFailingWebhook(webhookId: string): void {
    this.failingWebhooks.delete(webhookId);
    this.failingWebhooks.add(webhookId);
    while (this.failingWebhooks.size > FAILING_WEBHOOKS_MAX) {
      const oldest = this.failingWebhooks.values().next().value;
      if (oldest === undefined) break;
      this.failingWebhooks.delete(oldest);
    }
  }
}
