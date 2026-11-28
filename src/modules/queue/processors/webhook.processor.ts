import { InjectQueue, Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { DelayedError, Job, Queue } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { createLogger } from '../../../common/services/logger.service';
import { QUEUE_NAMES } from '../queue-names';
import { workerConnectionOptions, webhookWorkerConcurrency } from '../redis-connection';
import { closeWorkerIfStarted } from './close-worker';
import { WebhookJobData, WebhookPayload } from '../../webhook/webhook.service';
import { Webhook } from '../../webhook/entities/webhook.entity';
import {
  LOST_COPY_ERROR,
  MESSAGE_CHANGE_EVENTS,
  WebhookOutboxService,
  editedMessagePayload,
} from '../../webhook/webhook-outbox.service';
import { Message } from '../../message/entities/message.entity';
import { LidMappingStoreService } from '../../../engine/identity/lid-mapping-store.service';
import { judgeStoredRow } from '../../session/message-row-judgement';
import { jobHoldKey } from '../../webhook/utils/job-hold';
import { WebhookDeliveryFailure } from '../../webhook/entities/webhook-delivery-failure.entity';
import {
  clearDeliveryFailureRows,
  recordWebhookDeliveryFailure,
  statusCodeFromError,
} from '../../webhook/utils/record-delivery-failure';
import {
  buildDeliveryHeaders,
  changedData,
  isDeliverableWebhook,
  postWebhookPayload,
} from '../../webhook/utils/deliver-once';
import { DeliveryPreflight } from '../../webhook/utils/delivery-preflight';
import { HookManager } from '../../../core/hooks';
import { redactSsrfError } from '../../../common/security/ssrf-guard';
import { incrementWebhookDeliveryFailures } from '../../../common/metrics/webhook-delivery-metrics';

export interface WebhookJobResult {
  statusCode: number;
  success: boolean;
  error?: string;
  responseTime: number;
}

/**
 * The exact `failedReason` BullMQ 6.x sets when a job stalls more than `maxStalledCount` (worker
 * default 1, so the SECOND genuine stall): the stalled checker (moveStalledJobsToWait Lua script)
 * stores it as the job's deferred failure, and the worker then fails the job itself — emitting
 * 'failed' WITHOUT ever calling process(). Lock renewal means a slow-but-alive processor never
 * stalls, so reaching this sentinel implies the job genuinely died twice mid-processing.
 */
const STALL_EXHAUSTION_MESSAGE = 'job stalled more than allowable limit';

/** Upper bound on in-memory degraded-receiver tracking so churned webhook ids cannot grow memory without bound. */
export const FAILING_WEBHOOKS_MAX = 10_000;

/** Per-attempt delivery context threaded through the process() pipeline stages (was closure state). */
interface WebhookDeliveryContext {
  job: Job<WebhookJobData>;
  webhookId: string;
  url: string;
  event: string;
  payload: WebhookPayload;
  maxRetries: number;
  sessionId: string;
  startTime: number;
}

// Override the Worker's connection so it does NOT inherit the producer's `enableOfflineQueue: false`
// from the shared BullModule connection — the Worker must tolerate a brief Redis reconnect. Set an
// explicit concurrency: BullMQ defaults a Worker to 1, which serializes every session's webhook
// deliveries behind one slow/timing-out receiver.
@Processor(QUEUE_NAMES.WEBHOOK, { connection: workerConnectionOptions(), concurrency: webhookWorkerConcurrency() })
export class WebhookProcessor extends WorkerHost {
  private readonly logger = createLogger('WebhookProcessor');
  /**
   * Webhooks whose last attempt on this worker failed, until one succeeds. A job for one of them
   * takes a per-session slot first, at most `degradedSessionConcurrency` per session; over that it
   * goes back to the delayed set without spending an attempt. One session's failing receivers then
   * cannot fill the shared pool, while healthy receivers are never held back.
   */
  private readonly failingWebhooks = new Set<string>();
  private readonly degradedInFlight = new Map<string, number>();
  private readonly degradedSessionConcurrency: number;
  private readonly preflight: DeliveryPreflight;

  constructor(
    @InjectRepository(Webhook, 'data')
    private readonly webhookRepository: Repository<Webhook>,
    @InjectRepository(WebhookDeliveryFailure, 'data')
    private readonly failureRepository: Repository<WebhookDeliveryFailure>,
    private readonly hookManager: HookManager,
    private readonly configService: ConfigService,
    private readonly outbox: WebhookOutboxService,
    // The stored messages, read for a job whose outbox row could not be written when this node has no copy of it.
    @Optional()
    @InjectRepository(Message, 'data')
    private readonly messages?: Repository<Message>,
    // Tells a contact's lid and phone for the same entity, so an edit stored under either is judged the message's.
    @Optional()
    private readonly lidMappingStore?: LidMappingStoreService,
    @Optional()
    @InjectQueue(QUEUE_NAMES.WEBHOOK)
    private readonly webhookQueue?: Queue<WebhookJobData>,
  ) {
    super();
    // WEBHOOK_DEGRADED_SESSION_CONCURRENCY, else a quarter of the worker pool.
    this.degradedSessionConcurrency =
      this.configService.get<number | undefined>('webhook.degradedSessionConcurrency') ??
      Math.max(1, Math.floor(webhookWorkerConcurrency() / 4));
    this.preflight = new DeliveryPreflight(failureRepository, configService, hookManager, this.logger);
  }

  // Stop taking jobs before the plugins are torn down, so a final attempt's webhook:error hook still
  // reaches them; see IngressProcessor.onModuleDestroy. The wait is min(WEBHOOK_TIMEOUT + 5 s, 10 s), so it
  // covers one POST plus its bookkeeping only while WEBHOOK_TIMEOUT is 5 s or less; a job still active at the
  // cap is re-run after the next start.
  async onModuleDestroy(): Promise<void> {
    await closeWorkerIfStarted(this, this.configService.get<number>('webhook.timeout', 10000) + 5000);
  }

  async process(job: Job<WebhookJobData>, token?: string): Promise<WebhookJobResult> {
    const { webhookId, payload } = job.data;
    const sessionId = payload.sessionId;
    const gated = this.failingWebhooks.has(webhookId);
    if (gated) {
      const inFlight = this.degradedInFlight.get(sessionId) ?? 0;
      if (inFlight >= this.degradedSessionConcurrency) {
        // Before the try below on purpose: this is not an attempt, so it must never be logged as a
        // failure or file a dead-letter row.
        return this.delayWithoutAttempt(job, token);
      }
      this.degradedInFlight.set(sessionId, inFlight + 1);
    }
    try {
      return await this.deliver(job, token);
    } finally {
      if (gated) {
        const left = (this.degradedInFlight.get(sessionId) ?? 1) - 1;
        if (left > 0) this.degradedInFlight.set(sessionId, left);
        else this.degradedInFlight.delete(sessionId);
      }
    }
  }

  /**
   * Send the job back to the delayed set without spending one of its attempts. At least a second: a job delayed to
   * "now" is promoted straight back and would spin. Each bounce doubles the job's wait, up to 64x, so a backlog is not
   * promoted and bounced again every few seconds, a churn that would grow with it. attemptsStarted counts every
   * activation and attemptsMade only real attempts, so the gap, less this activation, is how many times this job was
   * already bounced.
   */
  private async delayWithoutAttempt(job: Job<WebhookJobData>, token: string | undefined): Promise<never> {
    const base = Math.max(1000, this.configService.get<number>('webhook.retryDelay', 5000));
    const bounces = Math.max(0, job.attemptsStarted - job.attemptsMade - 1);
    const delay = base * 2 ** Math.min(bounces, 6);
    await job.moveToDelayed(Date.now() + delay + Math.floor(Math.random() * delay), token);
    throw new DelayedError();
  }

  private async deliver(job: Job<WebhookJobData>, token: string | undefined): Promise<WebhookJobResult> {
    const { webhookId, event, payload, maxRetries } = job.data;
    const startTime = Date.now();
    const sessionId = payload.sessionId;

    this.logger.log(`Processing webhook job ${job.id}`, {
      webhookId,
      event,
      deliveryId: payload.deliveryId,
      idempotencyKey: payload.idempotencyKey,
      attempt: job.attemptsMade + 1,
      action: 'webhook_process_start',
    });

    const ctx: WebhookDeliveryContext = {
      job,
      webhookId,
      url: job.data.url,
      event,
      payload,
      maxRetries,
      sessionId,
      startTime,
    };

    try {
      // The job carries a snapshot taken at enqueue time. Re-read the row before every attempt: a
      // webhook that was deleted, disabled or unsubscribed from this event since then must not
      // receive it (the reconciler applies the same test; neither re-applies the webhook's filters,
      // which need the event data). Completing the job instead of throwing
      // stops the retries and files no dead-letter row. Otherwise deliver with the CURRENT url,
      // headers and secret, as the reconciler's replay does, so a receiver move or a rotated
      // secret or auth header applies to jobs already waiting in the queue.
      // A message delivery reads its outbox row too: the message may have been revoked, deleted
      // through the API or edited since the job was queued.
      let current: Webhook | null;
      let held: Record<string, unknown> | null | undefined | 'lost';
      let heldElsewhere = false;
      try {
        current = await this.loadDeliverableWebhook(webhookId, event, sessionId);
        held = current ? await this.outbox.currentMessagePayload(webhookId, payload.idempotencyKey, event) : undefined;
        // Queued while its outbox row could not be written, and no copy of it here: what the node that queued it wrote
        // into the job says instead, as its own copy and hold would there (a withdrawn copy ends the job, a change it
        // keeps holds it, a copy a bound dropped stops it, and the copy as a change left it is sent), else the message's
        // row.
        if (current && held === undefined && job.data.unwritten) {
          if (job.data.unwrittenChange === null) held = null;
          else if (await this.heldByQueuingNode(payload.deliveryId)) heldElsewhere = true;
          else if (job.data.unwrittenLost) held = 'lost';
          else if (job.data.unwrittenChange !== undefined) held = job.data.unwrittenChange;
          else held = await this.storedChange(sessionId, event, job.data.unwritten);
        }
      } catch (readError) {
        // A database that cannot answer now spends no attempt: the job waits as a bounced one does, and an outage
        // does not use up its retries. A stored row that does not parse never will, and counts as a failed attempt.
        if (readError instanceof Error && readError.name === 'SyntaxError') throw readError;
        return await this.delayWithoutAttempt(job, token);
      }
      if (!current) {
        this.logger.warn('Skipping queued webhook delivery: webhook removed, disabled or unsubscribed', {
          webhookId,
          event,
          deliveryId: payload.deliveryId,
          idempotencyKey: payload.idempotencyKey,
          action: 'webhook_skipped_stale',
        });
        this.failingWebhooks.delete(webhookId);
        await this.outbox.close(webhookId, payload.idempotencyKey, 'dispatched');
        return { statusCode: 0, success: false, error: 'webhook removed, disabled or unsubscribed', responseTime: 0 };
      }
      if (heldElsewhere) return await this.delayWithoutAttempt(job, token);
      if (held === null) {
        this.logger.warn(
          'Skipping queued webhook delivery: its outbox row was closed (message taken back or delivered)',
          {
            webhookId,
            event,
            deliveryId: payload.deliveryId,
            idempotencyKey: payload.idempotencyKey,
            action: 'webhook_skipped_retracted',
          },
        );
        // The job ends here: a copy kept for it in memory has nothing left to answer.
        this.outbox.forgetUnwritten(webhookId, payload.idempotencyKey);
        return { statusCode: 0, success: false, error: 'outbox row closed', responseTime: 0 };
      }
      // A change of the message kept on this node may still withdraw or rewrite this copy: the job waits for it. The
      // message is the one the server named, never what a hook made of the body.
      const lost = held === 'lost';
      const copy = held === 'lost' ? job.data.unwritten : held;
      const named =
        job.data.messageId !== undefined ? { messageId: job.data.messageId } : (copy ?? job.data.replayData);
      if (this.outbox.isMessageHeld(payload.idempotencyKey, webhookId, { sessionId, event, data: named }))
        return await this.delayWithoutAttempt(job, token);
      if (lost) return await this.stopLostCopy(ctx, current, token);
      ctx.url = current.url;
      let body = JSON.stringify(payload);
      const changed = changedData(copy, job.data.baseHash);
      if (changed) {
        // Rewritten since the job was queued (an edit, or a delete through the API): built again from the row,
        // through the same hooks and checks as a dispatch, under the job's own key and delivery id.
        const rebuilt = await this.preflight.preflightDelivery(current, payload.deliveryId, payload.idempotencyKey, {
          sessionId,
          event,
          baseData: changed,
        });
        if (rebuilt === 'unrecorded') return await this.delayWithoutAttempt(job, token);
        if (!rebuilt || rebuilt === 'cancelled') {
          // Cancelled by a plugin, or refused and recorded as undelivered: nothing more to send, as on dispatch.
          await this.outbox.close(webhookId, payload.idempotencyKey, 'dispatched');
          return { statusCode: 0, success: false, error: 'not dispatched', responseTime: 0 };
        }
        ctx.payload = rebuilt.finalPayload;
        body = rebuilt.body;
      }
      const requestHeaders = buildDeliveryHeaders(
        current,
        event,
        payload.idempotencyKey,
        payload.deliveryId,
        body,
        job.attemptsMade,
      );

      const { status, responseTime } = await this.postToReceiver(ctx, body, requestHeaders);
      this.failingWebhooks.delete(webhookId);
      await this.outbox.close(webhookId, payload.idempotencyKey, 'dispatched');
      await this.recordSuccessfulDelivery(ctx, status, responseTime);
      return {
        statusCode: status,
        success: true,
        responseTime,
      };
    } catch (error) {
      if (error instanceof DelayedError) throw error;
      this.markFailingWebhook(webhookId);
      await this.recordDeliveryFailure(ctx, error);
      // Re-throw to trigger BullMQ retry
      throw error;
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

  /** The webhook row as it is now, or null when it was deleted, disabled or no longer takes `event`. */
  private async loadDeliverableWebhook(webhookId: string, event: string, sessionId: string): Promise<Webhook | null> {
    const row = await this.webhookRepository.findOne({ where: { id: webhookId } });
    return isDeliverableWebhook(row, event, sessionId) ? row : null;
  }

  /**
   * POST the payload to the receiver through the SSRF-guarded fetch and classify the response:
   * a non-ok status throws into the failure path. Returns the status and measured response time.
   */
  private async postToReceiver(
    ctx: WebhookDeliveryContext,
    body: string,
    requestHeaders: Record<string, string>,
  ): Promise<{ status: number; responseTime: number }> {
    const { url, startTime } = ctx;
    const { status } = await postWebhookPayload(
      url,
      body,
      requestHeaders,
      // Honor WEBHOOK_TIMEOUT on the queued path too, as the direct path does.
      this.configService.get<number>('webhook.timeout', 10000),
    );

    const responseTime = Date.now() - startTime;
    return { status, responseTime };
  }

  /**
   * Post-delivery bookkeeping for a 2xx answer: guarded lastTriggeredAt update, the
   * webhook:delivered hook, and the success log.
   */
  private async recordSuccessfulDelivery(
    ctx: WebhookDeliveryContext,
    status: number,
    responseTime: number,
  ): Promise<void> {
    const { job, webhookId, event, payload, sessionId } = ctx;
    // The receiver already answered 2xx — the delivery SUCCEEDED. Everything up to the return is
    // bookkeeping and must never throw back into the failure path: a rethrow would make BullMQ
    // retry (a duplicate POST for an already-delivered event) and, on the final attempt, file a
    // false dead-letter row. Log a bookkeeping failure and keep the success outcome.
    try {
      await this.webhookRepository.update(webhookId, {
        lastTriggeredAt: new Date(),
      });
    } catch (bookkeepingError) {
      this.logger.error(
        'Webhook delivered but lastTriggeredAt update failed',
        bookkeepingError instanceof Error ? bookkeepingError.message : String(bookkeepingError),
        { webhookId, deliveryId: payload.deliveryId, action: 'webhook_bookkeeping_failed' },
      );
    }

    // A delivered event must not stay listed as lost. A failure row exists for it only when an
    // earlier dispatch of the same delivery was shed, refused or failed before this job ran. An
    // indexed delete that usually matches nothing.
    await clearDeliveryFailureRows(this.failureRepository, this.logger, webhookId, payload.idempotencyKey);

    // Execute hook after successful delivery
    await this.hookManager.execute(
      'webhook:delivered',
      {
        sessionId,
        event,
        webhookId,
        deliveryId: payload.deliveryId,
        statusCode: status,
        responseTime,
        attempt: job.attemptsMade + 1,
      },
      { sessionId, source: 'WebhookProcessor' },
    );

    this.logger.log(`Webhook delivered successfully`, {
      webhookId,
      event,
      deliveryId: payload.deliveryId,
      idempotencyKey: payload.idempotencyKey,
      statusCode: status,
      responseTime,
      attempt: job.attemptsMade + 1,
      action: 'webhook_delivered',
    });
  }

  /**
   * Failure-path bookkeeping: log the delivery failure and, on the final attempt, fire the
   * webhook:error hook, persist the durable dead-letter row, and bump the failures metric.
   */
  private async recordDeliveryFailure(ctx: WebhookDeliveryContext, error: unknown): Promise<void> {
    const { job, webhookId, url, event, payload, maxRetries, sessionId, startTime } = ctx;
    const responseTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isFinalAttempt = job.attemptsMade + 1 >= maxRetries;

    this.logger.error(`Webhook delivery failed`, errorMessage, {
      webhookId,
      event,
      deliveryId: payload.deliveryId,
      idempotencyKey: payload.idempotencyKey,
      responseTime,
      attempt: job.attemptsMade + 1,
      maxRetries,
      isFinalAttempt,
      action: 'webhook_failed',
    });

    // On final failure (all retries exhausted): fire the error hook AND persist a durable record so
    // the lost event is visible after the BullMQ failed-set / logs roll off.
    if (isFinalAttempt) {
      // The hook payload and the durable row are surfaced to operators/plugins — redact SSRF detail
      // (resolved internal IP) from the client-facing message. The full `errorMessage` is already
      // logged server-side above; statusCodeFromError never matches an SSRF block (matches ^HTTP \d{3}).
      const clientError = redactSsrfError(error);
      await this.hookManager.execute(
        'webhook:error',
        {
          sessionId,
          event,
          webhookId,
          deliveryId: payload.deliveryId,
          error: clientError,
          attempt: job.attemptsMade + 1,
        },
        { sessionId, source: 'WebhookProcessor' },
      );
      const recorded = await recordWebhookDeliveryFailure(this.failureRepository, this.logger, {
        webhookId,
        sessionId,
        event,
        url,
        idempotencyKey: payload.idempotencyKey,
        deliveryId: payload.deliveryId,
        attempts: job.attemptsMade + 1,
        lastStatusCode: statusCodeFromError(errorMessage),
        lastError: clientError,
        // The producer attaches the pre-hook event data only while payload retention is on.
        ...this.failurePayload(await this.replayCopy(job)),
      });
      if (recorded !== false) incrementWebhookDeliveryFailures();
      if (recorded !== null) await this.outbox.close(webhookId, payload.idempotencyKey, 'dispatched');
    }
  }

  /**
   * A job whose kept copy a bound dropped, on this node or on the one that queued it, is not sent, as a change of its
   * message can no longer reach it: it is recorded as a terminal failure, with its pre-hook data for a redrive unless a
   * change of the message came after the drop. While that record cannot be written the job waits, spending no attempt.
   */
  private async stopLostCopy(
    ctx: WebhookDeliveryContext,
    current: Webhook,
    token: string | undefined,
  ): Promise<WebhookJobResult> {
    const { job, webhookId, event, payload, sessionId } = ctx;
    const recorded = await recordWebhookDeliveryFailure(this.failureRepository, this.logger, {
      webhookId,
      sessionId,
      event,
      url: current.url,
      idempotencyKey: payload.idempotencyKey,
      deliveryId: payload.deliveryId,
      attempts: job.attemptsMade + 1,
      lastStatusCode: null,
      lastError: LOST_COPY_ERROR,
      ...(this.lostCopyTaken(job) ? {} : this.failurePayload(job.data.replayData)),
    });
    if (recorded === null) return await this.delayWithoutAttempt(job, token);
    if (recorded) incrementWebhookDeliveryFailures();
    this.logger.error('Webhook delivery stopped', LOST_COPY_ERROR, {
      webhookId,
      event,
      deliveryId: payload.deliveryId,
      idempotencyKey: payload.idempotencyKey,
      action: 'webhook_failed',
    });
    await this.hookManager.execute(
      'webhook:error',
      {
        sessionId,
        event,
        webhookId,
        deliveryId: payload.deliveryId,
        error: LOST_COPY_ERROR,
        attempt: job.attemptsMade + 1,
      },
      { sessionId, source: 'WebhookProcessor' },
    );
    await this.outbox.close(webhookId, payload.idempotencyKey, 'dispatched');
    return { statusCode: 0, success: false, error: LOST_COPY_ERROR, responseTime: 0 };
  }

  /** A change of the message came after the bound dropped the job's copy: its failure row keeps none of its data. */
  private lostCopyTaken(job: Job<WebhookJobData>): boolean {
    const { webhookId, payload, unwrittenLost } = job.data;
    return unwrittenLost === 'taken' || this.outbox.unwrittenCopy(webhookId, payload.idempotencyKey) === null;
  }

  /**
   * Whether the node that queued a job keeps a change of its message: its lease, a key Redis expires itself, so no
   * node's clock is read. Throws when Redis cannot answer: the job waits rather than send on a guess.
   */
  private async heldByQueuingNode(deliveryId: string): Promise<boolean> {
    if (!this.webhookQueue) return false;
    const redis = await this.webhookQueue.getBackend().client;
    return (await redis.get(jobHoldKey(this.webhookQueue, deliveryId))) !== null;
  }

  /**
   * What the stored rows of a job's message say of its delivery, for a job queued while its outbox row could not be
   * written and run where no copy of it is kept: null once any row under the id was taken back (a revoke, or a delete
   * through the API, which a row does not tell apart: nothing is sent; withholding is the safe side, so another chat's
   * message under the same id withholds it too), the copy with the stored text once an edit marked a row judged the
   * delivery's own message (as a change of it would be judged, lid and phone of one contact included), and undefined
   * otherwise. Throws when the rows cannot be read: the job waits rather than send on a guess.
   */
  private async storedChange(
    sessionId: string,
    event: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null | undefined> {
    const edit = MESSAGE_CHANGE_EVENTS.includes(event);
    const waMessageId = edit ? data.messageId : data.id;
    if (!this.messages || typeof waMessageId !== 'string' || !waMessageId) return undefined;
    const rows = await this.messages.find({
      where: { sessionId, waMessageId },
      select: {
        id: true,
        chatId: true,
        from: true,
        to: true,
        direction: true,
        author: true,
        type: true,
        body: true,
        metadata: true,
        engineRef: true,
      },
    });
    if (rows.some(row => row.type === 'revoked')) return null;
    if (edit || typeof data.chatId !== 'string' || typeof data.fromMe !== 'boolean') return undefined;
    const author =
      typeof data.author === 'string' ? data.author : typeof data.sender === 'string' ? data.sender : undefined;
    const source = { kind: 'edit' as const, chatId: data.chatId, fromMe: data.fromMe, author };
    const resolveLid = this.lidMappingStore ? (jid: string) => this.lidMappingStore!.findPhoneForLid(jid) : undefined;
    for (const row of rows) {
      if (row.metadata?.edited !== true || typeof row.body !== 'string' || row.body === data.body) continue;
      if ((await judgeStoredRow(row, waMessageId, source, resolveLid)).reason === null) {
        return editedMessagePayload(data, row.body);
      }
    }
    return undefined;
  }

  /**
   * The pre-hook event data a terminal row keeps for a redrive: a message delivery's as a change rewrote its outbox row,
   * none once the message was taken back, and the job's own copy otherwise (or when the row cannot be read).
   */
  private async replayCopy(job: Job<WebhookJobData>): Promise<WebhookJobData['replayData']> {
    const { replayData, webhookId, event, payload, baseHash } = job.data;
    if (!replayData) return undefined;
    const held = await this.outbox
      .currentMessagePayload(webhookId, payload.idempotencyKey, event)
      .catch(() => undefined);
    if (held === 'lost') return this.lostCopyTaken(job) ? undefined : replayData;
    const changed = changedData(held, baseHash);
    return changed === undefined ? replayData : (changed ?? undefined);
  }

  /** The event data a terminal failure row keeps for a redrive, with the window it is kept for. */
  private failurePayload(replayData: WebhookJobData['replayData']): {
    payload?: Record<string, unknown>;
    payloadRetentionHours?: number;
  } {
    const hours = this.configService.get<number>('webhook.failurePayloadRetentionHours', 0);
    return hours > 0 && replayData ? { payload: replayData, payloadRetentionHours: hours } : {};
  }

  /**
   * A job failed by stall exhaustion never enters process(): the worker fails it internally after
   * the second stall and only emits 'failed'. Without this handler such a job bypasses every product
   * failure channel — no dead-letter row, no metric, no webhook:error hook. Normal delivery failures
   * are already recorded by process() on the final attempt (and non-final ones are retried), so this
   * handler MUST ignore anything but the stall-exhaustion sentinel, or every failure is recorded
   * twice. `job` can be undefined when the queue's bounded `removeOnFail` window (see QueueModule's
   * WEBHOOK_QUEUE_JOB_OPTIONS) pruned it before this event fired — that window keeps failed-job
   * retention bounded, and each retained payload was size-gated before enqueue.
   */
  @OnWorkerEvent('failed')
  async onWorkerFailed(job: Job<WebhookJobData> | undefined, error: Error): Promise<void> {
    // The sentinel text alone is not proof: a failed attempt whose error reads the same is retried and is not
    // this. BullMQ marks a job it fails for stalling by storing the reason as its deferred failure.
    if (!job || job.deferredFailure !== STALL_EXHAUSTION_MESSAGE || error.message !== STALL_EXHAUSTION_MESSAGE) {
      return;
    }

    const { webhookId, event, payload } = job.data;
    const sessionId = payload.sessionId;

    // Same rule as process(): no dead-letter row or webhook:error for a webhook that is gone, disabled
    // or unsubscribed, and the row records the URL a retry would have used. If the read itself fails,
    // record against the enqueue-time snapshot rather than lose the failure.
    let url = job.data.url;
    try {
      const current = await this.loadDeliverableWebhook(webhookId, event, sessionId);
      if (!current) {
        this.failingWebhooks.delete(webhookId);
        await this.outbox.close(webhookId, payload.idempotencyKey, 'dispatched');
        return;
      }
      url = current.url;
    } catch (readError) {
      this.logger.warn('Could not re-read webhook for a stalled job; recording the enqueue-time URL', {
        webhookId,
        error: readError instanceof Error ? readError.message : String(readError),
      });
    }

    this.logger.error('Webhook job failed after stalling beyond the recovery limit', error.message, {
      webhookId,
      event,
      deliveryId: payload.deliveryId,
      idempotencyKey: payload.idempotencyKey,
      attemptsMade: job.attemptsMade,
      action: 'webhook_stall_exhausted',
    });

    await this.hookManager.execute(
      'webhook:error',
      {
        sessionId,
        event,
        webhookId,
        deliveryId: payload.deliveryId,
        error: error.message,
        attempt: job.attemptsMade,
      },
      { sessionId, source: 'WebhookProcessor' },
    );

    const recorded = await recordWebhookDeliveryFailure(this.failureRepository, this.logger, {
      webhookId,
      sessionId,
      event,
      url,
      idempotencyKey: payload.idempotencyKey,
      deliveryId: payload.deliveryId,
      attempts: Math.max(1, job.attemptsMade),
      lastStatusCode: null, // no HTTP exchange completed on the stalled attempts
      lastError: error.message,
      ...this.failurePayload(await this.replayCopy(job)),
    });
    if (recorded !== false) incrementWebhookDeliveryFailures();
    if (recorded !== null) await this.outbox.close(webhookId, payload.idempotencyKey, 'dispatched');
  }
}
