import {
  Injectable,
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
  Optional,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createLogger } from '../../common/services/logger.service';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, QueryDeepPartialEntity, Repository } from 'typeorm';
import { createHash, randomUUID } from 'crypto';
import { setTimeout } from 'node:timers/promises';
import {
  MessageBatch,
  BatchStatus,
  BatchMessageStatus,
  BatchProgress,
  BatchMessageResult,
} from './entities/message-batch.entity';
import { SendBulkMessageDto } from './dto/bulk-message.dto';
import { isMediaUrl } from '../../common/media/media-url';
import { MessageStatus } from './entities/message.entity';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { MessageService, DEFAULT_TEMPLATE_RENDER_MAX_CHARS } from './message.service';
import {
  SendPacingService,
  isPacingLimitedError,
  countsTowardSendBreaker,
  sentNothing,
  SEND_PACING_LIMITED,
  type SettleAdmission,
} from './send-pacing.service';
import { SessionOwnershipService } from '../session/session-ownership.service';
import { HookManager } from '../../core/hooks';
import { assertBase64WithinMediaCap, stripBase64DataUri } from './media-cap.util';
import { SsrfBlockedError, SSRF_BLOCKED_CLIENT_MESSAGE } from '../../common/security/ssrf-guard';
import { renderTemplate } from '../../common/utils/template-render';
import { IWhatsAppEngine, MessageResult } from '../../engine/interfaces/whatsapp-engine.interface';
import { resolveNonNegativeIntEnv } from '../../config/configuration';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { isUniqueViolation } from '../../common/utils/db-errors';

// Type definitions for bulk message content
interface BulkMessageContent {
  text?: string;
  caption?: string;
  mentions?: string[];
  image?: { url?: string; base64?: string; mimetype?: string; filename?: string };
  video?: { url?: string; base64?: string; mimetype?: string; filename?: string };
  audio?: { url?: string; base64?: string; mimetype?: string; filename?: string; ptt?: boolean };
  document?: { url?: string; base64?: string; mimetype?: string; filename?: string };
}

/**
 * Resolve a batch's terminal status, in precedence order:
 *  - cancelled (cancelBatch flipped the flag) → CANCELLED. Must win over the in-memory PROCESSING
 *    status set at the start of processBatch, which would otherwise be saved back over the cancellation.
 *  - stopped on the first error (stopOnError) → FAILED, even if some messages were already sent.
 *  - otherwise → COMPLETED, or FAILED only when every attempt failed.
 */
export function resolveFinalBatchStatus(
  cancelled: boolean,
  stoppedOnError: boolean,
  progress: Pick<BatchProgress, 'sent' | 'failed'>,
): BatchStatus {
  if (cancelled) return BatchStatus.CANCELLED;
  if (stoppedOnError) return BatchStatus.FAILED;
  return progress.failed > 0 && progress.sent === 0 ? BatchStatus.FAILED : BatchStatus.COMPLETED;
}

/**
 * Build the error stored on a batch result. An SSRF block names the internal host/IP it refused, so
 * it must never be persisted/returned verbatim — it would be readable via GET batch status. Map it to
 * a generic, code-tagged message; a pacing refusal keeps its own code so batch results distinguish
 * policy 429s from engine refusals; ordinary errors keep their (non-sensitive) message.
 */
export function sanitizeBatchError(error: unknown): { code: string; message: string } {
  if (error instanceof SsrfBlockedError) {
    return { code: 'SEND_BLOCKED', message: SSRF_BLOCKED_CLIENT_MESSAGE };
  }
  if (isPacingLimitedError(error)) {
    return { code: SEND_PACING_LIMITED, message: error instanceof Error ? error.message : String(error) };
  }
  return { code: 'SEND_FAILED', message: error instanceof Error ? error.message : String(error) };
}

/**
 * Per-process cap on concurrently-processing bulk batches. Each in-flight batch holds its full message
 * set (with base64 media) in memory and is dispatched fire-and-forget, so without a ceiling a burst of
 * batches can exhaust host memory. Env-overridable; 0 disables the cap. Default is generous — it only
 * trips a genuine runaway, not normal use. Per-process (not cluster-wide).
 */
const DEFAULT_MAX_CONCURRENT_BATCHES = 50;
export function resolveMaxConcurrentBatches(): number {
  return resolveNonNegativeIntEnv(process.env.BULK_MAX_CONCURRENT_BATCHES, DEFAULT_MAX_CONCURRENT_BATCHES); // 0 = unlimited
}

/** Per-run state threaded through the executeBatch pipeline stages (was local/closure state). */
interface BatchExecutionState {
  results: BatchMessageResult[];
  stoppedOnError: boolean;
  cancelledByDb: boolean;
  /**
   * Another writer ended the row (a reap after the session was taken over): keep its status and
   * record only what this run sent.
   */
  endedElsewhere: boolean;
}

/** A terminal status only another writer can have put on a row this run still holds as PROCESSING. */
const ENDED_ELSEWHERE = new Set<BatchStatus>([BatchStatus.FAILED, BatchStatus.COMPLETED]);

@Injectable()
export class BulkMessageService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = createLogger(BulkMessageService.name);
  private readonly processingBatches = new Map<string, boolean>(); // Track active batches for cancellation
  private inFlightBatches = 0; // count of batches currently in processBatch (memory bound, see cap above)
  /** Set at the top of onModuleDestroy: no batch may start sending once the shutdown fail has run. */
  private shuttingDown = false;

  constructor(
    @InjectRepository(MessageBatch, 'data')
    private readonly batchRepository: Repository<MessageBatch>,
    private readonly engines: EngineRegistry,
    private readonly messageService: MessageService,
    private readonly hookManager: HookManager,
    private readonly pacing: SendPacingService,
    // Trailing @Optional, matching the convention used elsewhere here: the running app always
    // provides it, while direct-construction unit tests omit it and every batch then reads as this
    // node's — which is exactly a single-process deployment.
    @Optional()
    private readonly ownership?: SessionOwnershipService,
    // Same trailing-@Optional convention: supplies template.renderMaxChars for the substitution cap
    // below. Absent in direct-construction unit tests, which then fall back to the shared default.
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  /**
   * A session this process takes over from a node whose lease lapsed leaves that node's unfinished
   * batches behind, whichever path took it: an explicit start or stop as much as the takeover sweep.
   * Registered here, before any bootstrap hook can start a session.
   */
  onModuleInit(): void {
    this.ownership?.onAdoption(sessionId => this.reapProcessingBatches(sessionId, 'session taken from a lapsed node'));
  }

  /**
   * Transition orphaned batches on startup. A batch still in PENDING or PROCESSING belongs to a
   * previous (crashed/restarted) process — this fresh process is not driving it, so it would
   * otherwise be stuck there forever. Mark it FAILED. Auto-resume is intentionally NOT
   * done here: resuming risks re-sending messages already delivered before the crash.
   *
   * "A previous process" is not the same as "any process". A batch is only ever driven by whichever
   * process holds its session's engine, so a batch belongs to a peer exactly when its session does.
   * Without that distinction a booting replica declares a live peer's in-flight batches FAILED
   * while they are still sending — the caller is told the send failed, and the messages go out
   * anyway. Batch ownership follows session ownership rather than being tracked separately,
   * because the two cannot diverge: only the engine holder can send.
   */
  async onApplicationBootstrap(): Promise<void> {
    const unfinished = await this.batchRepository.find({
      where: { status: In([BatchStatus.PENDING, BatchStatus.PROCESSING]) },
    });
    const orphaned = await this.ownedByThisNode(unfinished);
    let failed = 0;
    for (const batch of orphaned) {
      if (await this.failOrphanedBatch(batch)) failed++;
    }
    if (failed > 0) {
      this.logger.warn(`Marked ${failed} orphaned unfinished batch(es) FAILED on startup (interrupted by a restart)`);
    }
    const skipped = unfinished.length - orphaned.length;
    if (skipped > 0) {
      this.logger.log(`Left ${skipped} unfinished batch(es) alone: their sessions are held by another node`);
    }
  }

  /**
   * Fail the batches this process holds on shutdown. Shutdown releases its sessions, and a node that
   * starts a released session is not adopting it from a lapsed lease, so it never reaps a batch left
   * PENDING or PROCESSING here: the row would stay unfinished until that node restarts. Runs before
   * TypeORM closes the database (onApplicationShutdown). The row is read first so the FAILED write strips
   * its stored media payloads, as every other terminal path does. The marker is cleared only once the
   * row is FAILED, so a run stops at its next item and records what it sent under that status.
   * A batch whose row is still being written here is not found; the flag makes its pickup fail it.
   */
  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    for (const id of [...this.processingBatches.keys()]) {
      try {
        const row = await this.batchRepository.findOne({ where: { id } });
        if (await this.failOrphanedBatch(row ?? { id })) this.processingBatches.set(id, false);
      } catch (error) {
        this.logger.error(`Could not mark batch ${id} FAILED on shutdown: ${String(error)}`);
      }
    }
  }

  /**
   * Guarded on the unfinished statuses in the UPDATE itself: the row was read before this write, and
   * a batch that finalized in between must keep its real status, progress and results. Returns
   * whether the row was still unfinished and is now FAILED. Without `messages` (the row could not
   * be read) the stored payloads are left as they are.
   *
   * `withRunState` is for the run's own failure path only: that run holds the progress, results and
   * currentIndex of what it sent, newer than the row. A reap must not write them back, since what it
   * read can be older than a progress write the batch's still-running node made since.
   */
  private async failOrphanedBatch(
    batch: Pick<MessageBatch, 'id'> & Partial<MessageBatch>,
    withRunState = false,
  ): Promise<boolean> {
    const set: QueryDeepPartialEntity<MessageBatch> = { status: BatchStatus.FAILED, completedAt: new Date() };
    if (batch.messages) {
      this.stripBatchMediaPayloads(batch.messages);
      set.messages = batch.messages as QueryDeepPartialEntity<MessageBatch>['messages'];
    }
    if (withRunState) {
      if (batch.progress) set.progress = batch.progress;
      if (batch.results) set.results = batch.results;
      if (batch.currentIndex !== undefined) set.currentIndex = batch.currentIndex;
    }
    const failed = await this.batchRepository.update(
      { id: batch.id, status: In([BatchStatus.PENDING, BatchStatus.PROCESSING]) },
      set,
    );
    return Boolean(failed.affected);
  }

  /**
   * Fail a session's unfinished (PENDING or PROCESSING) batches after the session was taken over from a
   * node whose lease lapsed: a batch that node saved but never picked up is as orphaned as one it was
   * running. Same policy as the boot reaper and for the same reason: the dead node's already-sent
   * messages are unknowable, so resuming risks double-sends: FAILED with the payloads stripped is the
   * honest terminal state, and the caller can re-issue the batch knowingly.
   *
   * Runs after this process claims the session from, or releases the claim of, such a node (see
   * onModuleInit). A batch this process created or is still running is not orphaned, as when it held
   * the session before or still runs a stale engine for it: createBatch registers every batch before
   * its row is written, so only the lapsed node's batches go.
   */
  async reapProcessingBatches(sessionId: string, reason: string): Promise<number> {
    const unfinished = (
      await this.batchRepository.find({
        where: { status: In([BatchStatus.PENDING, BatchStatus.PROCESSING]), sessionId },
      })
    ).filter(batch => !this.processingBatches.has(batch.id));
    let failed = 0;
    for (const batch of unfinished) {
      if (await this.failOrphanedBatch(batch)) failed++;
    }
    if (failed > 0) {
      this.logger.warn(`Marked ${failed} unfinished batch(es) FAILED for session ${sessionId} (${reason})`);
    }
    return failed;
  }

  /**
   * Narrow to the batches this process may act on. With no ownership service — a single-process
   * deployment, or a directly-constructed unit test — every batch qualifies, which is the behaviour
   * that existed before ownership was recorded at all.
   */
  private async ownedByThisNode(batches: MessageBatch[]): Promise<MessageBatch[]> {
    if (!this.ownership || batches.length === 0) return batches;
    const claimable = new Set(await this.ownership.claimable([...new Set(batches.map(b => b.sessionId))]));
    return batches.filter(batch => claimable.has(batch.sessionId));
  }

  async createBatch(sessionId: string, dto: SendBulkMessageDto): Promise<MessageBatch> {
    // Validate the session is started (guard only — the batch is sent later, by drainBatch).
    this.engines.require(sessionId, () => new BadRequestException(`Session '${sessionId}' is not active`));

    // Collapse exact duplicate entries — same chatId, type, content, and variables; first
    // occurrence wins, order preserved. A true repeat would only re-run the engine (and the
    // moderation gate) for an entry already covered, but distinct messages to the same chatId
    // (a text followed by an image, say) must all be sent.
    const seenEntries = new Set<string>();
    const messages: SendBulkMessageDto['messages'] = [];
    for (const message of dto.messages) {
      // Hashed, not retained verbatim: the raw JSON of a 100-item media batch is a second copy of
      // the whole payload (up to the body limit) held for the length of the loop.
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([message.chatId, message.type, message.content, message.variables]))
        .digest('base64');
      if (seenEntries.has(fingerprint)) continue;
      seenEntries.add(fingerprint);
      messages.push(message);
    }

    // Bound every outbound base64 blob to the media byte cap before the whole messages array (with
    // its base64 payloads) is persisted into the batch row. Mirrors the single-send cap in
    // MessageService.buildMediaInput. The same check runs again per item after variables and the
    // message:sending gate are applied (see executeBatch).
    for (const { type, content } of messages) {
      this.assertContentMediaWithinCap(content);
      this.assertItemContent(type, content, true);
    }

    const batchId = dto.batchId || `batch_${randomUUID().split('-')[0]}`;
    // '.' and '..' are dot segments: URL clients collapse them, so the statusUrl and the status and
    // cancel routes for such a batch would resolve to a different path and it could never be reached.
    if (batchId === '.' || batchId === '..') {
      throw new BadRequestException(`Batch ID '${batchId}' is not allowed`);
    }

    // Check if this batchId already exists FOR THIS SESSION. Scoping by sessionId (matching how
    // getBatchStatus/cancelBatch already query) makes (sessionId, batchId) the namespace: one session
    // can't deny another a batchId, and the 400-vs-202 difference can't probe another session's ids.
    const existing = await this.batchRepository.findOne({ where: { batchId, sessionId } });
    if (existing) {
      throw new BadRequestException(`Batch ID '${batchId}' already exists`);
    }

    // Checked in the same turn as the registration below: a create that passes here is either seen by
    // the shutdown fail or failed at its pickup in processBatch.
    if (this.shuttingDown) {
      throw new ServiceUnavailableException('The server is shutting down; retry the batch shortly');
    }

    // Reject before persisting a row when too many batches are already processing, so a burst can't
    // hold an unbounded number of full message sets (base64 media included) in memory at once.
    const maxConcurrentBatches = resolveMaxConcurrentBatches();
    if (maxConcurrentBatches > 0 && this.inFlightBatches >= maxConcurrentBatches) {
      throw new HttpException(
        `Too many bulk batches in progress (max ${maxConcurrentBatches}); retry shortly`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const options = {
      delayBetweenMessages: dto.options?.delayBetweenMessages ?? 3000,
      randomizeDelay: dto.options?.randomizeDelay ?? true,
      stopOnError: dto.options?.stopOnError ?? false,
    };

    const progress: BatchProgress = {
      total: messages.length,
      sent: 0,
      failed: 0,
      pending: messages.length,
      cancelled: 0,
    };

    const batch = this.batchRepository.create({
      // Assigned here rather than by the database, so the batch is registered below before its row
      // exists anywhere.
      id: randomUUID(),
      batchId,
      sessionId,
      status: BatchStatus.PENDING,
      messages: messages as MessageBatch['messages'],
      options,
      progress,
      results: [],
      currentIndex: 0,
    });

    // Registered before the row exists, so a reap for this session (a claim that took the session
    // from another holder) can never read this process's own batch unregistered. A cancel can only
    // find the row once it is committed, and the false it sets then stands for the pickup check.
    this.processingBatches.set(batch.id, true);
    // Reserve synchronously in the same turn as the cap check. There is deliberately no await between
    // them, so a burst cannot all observe the same stale count and overshoot the ceiling.
    this.inFlightBatches++;
    try {
      await this.batchRepository.save(batch);
    } catch (error) {
      this.inFlightBatches--;
      this.processingBatches.delete(batch.id);
      // Two concurrent creates with the same caller-supplied batchId both pass the read above; the
      // unique index decides, and the loser gets the same 400 as the sequential case.
      if (isUniqueViolation(error)) {
        throw new BadRequestException(`Batch ID '${batchId}' already exists`);
      }
      throw error;
    }
    this.logger.log(
      `Created batch ${batchId} with ${messages.length} messages` +
        (messages.length === dto.messages.length
          ? ''
          : ` (${dto.messages.length - messages.length} exact duplicate entr${dto.messages.length - messages.length === 1 ? 'y' : 'ies'} dropped)`),
    );

    // Start processing asynchronously
    this.processBatch(batch.id, true).catch(err => {
      this.logger.error(`Batch ${batchId} processing error: ${String(err)}`);
    });

    return batch;
  }

  async getBatchStatus(sessionId: string, batchId: string): Promise<MessageBatch> {
    const batch = await this.batchRepository.findOne({
      where: { batchId, sessionId },
    });

    if (!batch) {
      throw new NotFoundException(`Batch '${batchId}' not found`);
    }

    return batch;
  }

  async cancelBatch(sessionId: string, batchId: string): Promise<MessageBatch> {
    const batch = await this.batchRepository.findOne({
      where: { batchId, sessionId },
    });

    if (!batch) {
      throw new NotFoundException(`Batch '${batchId}' not found`);
    }

    // A terminal batch (COMPLETED, CANCELLED, or FAILED) cannot be cancelled — cancelling a FAILED
    // batch would overwrite the failure outcome to CANCELLED, masking the real delivery failures and
    // the `message:failed` events that already fired. Each terminal status is exclusive.
    if (
      batch.status === BatchStatus.COMPLETED ||
      batch.status === BatchStatus.CANCELLED ||
      batch.status === BatchStatus.FAILED
    ) {
      throw new BadRequestException(`Batch '${batchId}' is already ${batch.status}`);
    }

    // Signal cancellation to this process's run of the batch. Only that run removes the marker, so a
    // batch run elsewhere (or already finished here) must not get one: it would leak, and it would
    // make a later takeover reap skip the batch.
    if (this.processingBatches.has(batch.id)) this.processingBatches.set(batch.id, false);

    // Update status — guarded to the non-terminal statuses IN the UPDATE, so a batch that reached a
    // terminal state between the read above and this write is not relabelled CANCELLED after the
    // fact (same exclusivity the upfront check enforces, but race-safe).
    batch.status = BatchStatus.CANCELLED;
    batch.progress.cancelled = batch.progress.pending;
    batch.progress.pending = 0;
    batch.completedAt = new Date();
    this.stripBatchMediaPayloads(batch.messages);

    const cancelledRows = await this.batchRepository.update(
      { id: batch.id, status: In([BatchStatus.PENDING, BatchStatus.PROCESSING]) },
      {
        status: batch.status,
        progress: batch.progress,
        completedAt: batch.completedAt,
        messages: batch.messages,
      } as QueryDeepPartialEntity<MessageBatch>,
    );
    if (!cancelledRows.affected) {
      const fresh = await this.batchRepository.findOne({ where: { id: batch.id }, select: { status: true } });
      throw new BadRequestException(`Batch '${batchId}' is already ${fresh?.status ?? 'gone'}`);
    }
    this.logger.log(`Cancelled batch ${batchId}`);

    return batch;
  }

  private async processBatch(batchDbId: string, reserved = false): Promise<void> {
    let batch: MessageBatch | null = null;
    // Always release the in-flight marker on every exit path (engine-not-found early return, a thrown
    // save/send, or normal completion) — otherwise the map leaks an entry per such batch.
    try {
      batch = await this.batchRepository.findOne({ where: { id: batchDbId } });
      if (!batch) return;
      // A cancel that landed before this run picked the batch up must not be revived — neither the
      // in-memory flag nor a persisted CANCELLED may be flipped back. The guarded status UPDATE in
      // executeBatch closes the remaining race (a cancel committing after this read).
      if (this.processingBatches.get(batch.id) === false || batch.status === BatchStatus.CANCELLED) {
        this.logger.log(`Batch ${batch.batchId} was cancelled before processing started; nothing was sent`);
        return;
      }
      // Saved while the shutdown fail ran, which could not see the row yet: fail it unsent rather
      // than start a run after this process began tearing down.
      if (this.shuttingDown) {
        await this.failOrphanedBatch(batch);
        this.logger.warn(`Batch ${batch.batchId} was failed before processing started: shutting down`);
        return;
      }
      this.processingBatches.set(batch.id, true);
      await this.executeBatch(batch);
    } catch (error) {
      // A throw here (a DB error on the pickup read, the start transition or a progress write) would
      // leave the row PENDING or PROCESSING, and nothing else moves it on while this process lives:
      // the reapers run only at boot and on a session takeover. Best effort, since the database that
      // just failed may fail again. The row gets what this run sent, so delivered items are not
      // reported as pending.
      await this.failOrphanedBatch(batch ?? { id: batchDbId }, true).catch((failError: unknown) => {
        this.logger.error(`Could not mark batch ${batchDbId} FAILED after its run threw: ${String(failError)}`);
      });
      throw error;
    } finally {
      if (reserved) this.inFlightBatches--;
      this.processingBatches.delete(batchDbId);
    }
  }

  private async executeBatch(batch: MessageBatch): Promise<void> {
    if (!(await this.markBatchProcessing(batch))) return;

    if (!this.engines.get(batch.sessionId)) {
      await this.failBatchWithoutEngine(batch);
      return;
    }

    const results: BatchMessageResult[] = batch.results || [];
    const state: BatchExecutionState = { results, stoppedOnError: false, cancelledByDb: false, endedElsewhere: false };
    await this.processBatchMessages(batch, state);
    await this.finalizeBatch(batch, state);
  }

  /** Returns false when the batch left PENDING before this start UPDATE, so nothing is sent. */
  private async markBatchProcessing(batch: MessageBatch): Promise<boolean> {
    // Transition to PROCESSING with the guard IN the UPDATE: it only lands while the stored status is
    // still PENDING, the one status a run starts from. A cancel that already committed (any process)
    // or a reap that failed the batch after another node adopted its session can never be overwritten
    // back to PROCESSING. Zero affected rows means send nothing.
    batch.status = BatchStatus.PROCESSING;
    batch.startedAt = new Date();
    const started = await this.batchRepository.update(
      { id: batch.id, status: BatchStatus.PENDING },
      { status: BatchStatus.PROCESSING, startedAt: batch.startedAt },
    );
    if (!started.affected) {
      this.logger.log(`Batch ${batch.batchId} was cancelled or failed before processing started; nothing was sent`);
      return false;
    }
    return true;
  }

  private async failBatchWithoutEngine(batch: MessageBatch): Promise<void> {
    batch.status = BatchStatus.FAILED;
    batch.completedAt = new Date();
    this.stripBatchMediaPayloads(batch.messages);
    await this.batchRepository.update({ id: batch.id, status: Not(BatchStatus.CANCELLED) }, {
      status: BatchStatus.FAILED,
      completedAt: batch.completedAt,
      messages: batch.messages,
    } as QueryDeepPartialEntity<MessageBatch>);
  }

  private async processBatchMessages(batch: MessageBatch, state: BatchExecutionState): Promise<void> {
    for (let i = batch.currentIndex; i < batch.messages.length; i++) {
      if (!(await this.processBatchMessage(batch, i, state))) break;
    }
  }

  /**
   * Send one batch message through the moderation gate, record the outcome, and persist progress.
   * Returns false when the batch loop must stop (cancellation or stopOnError).
   */
  private async processBatchMessage(batch: MessageBatch, i: number, state: BatchExecutionState): Promise<boolean> {
    const { results } = state;
    // Check for cancellation
    if (!this.processingBatches.get(batch.id)) {
      this.logger.log(`Batch ${batch.batchId} cancelled at index ${i}`);
      return false;
    }

    const msg = batch.messages[i];
    const result: BatchMessageResult = {
      chatId: msg.chatId,
      status: BatchMessageStatus.PENDING,
    };

    // Hoisted so the failure hook below can report the exact (variable-applied / plugin-modified)
    // content that was attempted, even when applyVariables or the send throws.
    let content: BulkMessageContent = msg.content;
    // Set when the message:sending gate blocked this item, so the catch treats it as a moderation
    // decision (not a delivery failure) and skips message:failed — matching the single-send path,
    // where a block is a 400 with no failure hook.
    let blockedByPlugin = false;
    // The pacing admission's settle. Bulk writes an item's row only after the engine accepts it, so the
    // admission is held until the engine answers, and an item that fails first gives it back, or it
    // would refuse the next item for the hold.
    let settleAdmission: SettleAdmission | undefined;
    let engineAsked = false;
    try {
      // Apply template variables
      content = this.applyVariables(msg.content, msg.variables);

      // Pacing runs BEFORE the moderation gate, matching MessageService: a send policy forbids is not
      // offered to plugins at all. A refusal is a 429 that fails THIS item (honouring stopOnError),
      // not the batch — the allowance may free up, and a batch killed outright could not resume.
      settleAdmission = await this.pacing.assertSendAllowed(batch.sessionId, msg.chatId, { untilSettled: true });

      // Per-message moderation gate — the SAME message:sending hook single sends use, so a
      // compliance/moderation plugin sees bulk traffic too (bulk previously bypassed it entirely).
      // A block fails just THIS message (honouring stopOnError below); a plugin may also rewrite it.
      // `input` carries the recipient like a single send's DTO does, so a recipient-based plugin can
      // decide; a rewritten chatId is ignored, the item always goes to its own msg.chatId.
      const gate = await this.hookManager.execute(
        'message:sending',
        { sessionId: batch.sessionId, input: { ...content, chatId: msg.chatId }, type: msg.type },
        { sessionId: batch.sessionId, source: 'BulkMessageService' },
      );
      if (!gate.continue) {
        blockedByPlugin = true;
        throw new BadRequestException('Message sending blocked by plugin');
      }
      // Same envelope check as applySendingGate, which this is the second copy of (see its doc).
      // Reading `.input` unchecked handed `undefined` to every send below, or threw on a null — one
      // plugin authoring mistake turning a whole batch into an opaque failure. Fails CLOSED: a
      // moderation handler whose reply cannot be read may have been redacting something.
      const envelope = gate.data as { input?: unknown } | null | undefined;
      if (envelope === undefined) {
        // Nothing changed: keep the content we already had.
      } else if (
        typeof envelope !== 'object' ||
        envelope === null ||
        typeof envelope.input !== 'object' ||
        envelope.input === null
      ) {
        blockedByPlugin = true;
        throw new BadRequestException(
          'A message:sending handler returned a payload without a usable `input`; the send was refused rather than sent unmoderated',
        );
      } else {
        content = envelope.input;
      }

      // Re-validate the ACTUAL outbound payload against the media cap: template variables and a
      // gate rewrite can grow base64 media past the limit createBatch verified on the raw input.
      // A violation fails just this item (honouring stopOnError) instead of sending it.
      this.assertContentMediaWithinCap(content);
      this.assertItemContent(msg.type, content);

      // Resolved per item, not once per batch: a session restart or reconnect registers a fresh
      // adapter, and a batch still holding the retired one would fail every remaining item.
      const engine = this.engines.get(batch.sessionId);
      if (!engine) throw new EngineNotReadyError();

      // Send message based on type. The engine call is bracketed on its own so the pacing breaker
      // hears exactly what the single-send path feeds it (message.service failSend/persistSentState):
      // recordSendFailure only when the ENGINE was asked and refused — never for the pre-engine
      // pacing/plugin/media-cap throws above — and recordSendSuccess the moment it accepts. Without
      // this the breaker was blind to bulk, the highest-volume path it exists to protect.
      let messageResult;
      engineAsked = true;
      try {
        messageResult = await this.sendMessage(engine, msg.chatId, msg.type, content);
      } catch (engineError) {
        // Same filter the single-send path applies: adapters also raise client-fault and
        // engine-state errors from inside this call, and those say nothing about the account.
        if (countsTowardSendBreaker(engineError)) {
          this.pacing.recordSendFailure(batch.sessionId);
        }
        // A failure that may still have sent the message keeps its admission for a window from now, while
        // the echo row lands.
        settleAdmission?.(!sentNothing(engineError));
        throw engineError;
      }
      settleAdmission?.(true);
      this.pacing.recordSendSuccess(batch.sessionId);

      result.status = BatchMessageStatus.SENT;
      result.messageId = messageResult.id;
      result.sentAt = new Date();
      batch.progress.sent++;
      batch.progress.pending--;

      // Persist like a single send so the row carries the media payload and the batch's type
      // mapping — the engine echo (onMessageCreate) writes its own OUTGOING row, but only with what
      // the engine reported, and a Baileys API send echoes a media-less marker. The two writers
      // dedup on UNIQUE(sessionId, waMessageId).
      await this.persistSentMessage(batch.sessionId, msg.chatId, msg.type, content, messageResult);

      this.logger.debug(`Batch ${batch.batchId}: Sent message ${i + 1}/${batch.messages.length} to ${msg.chatId}`);
    } catch (error) {
      if (!engineAsked) settleAdmission?.();
      result.status = BatchMessageStatus.FAILED;
      // Sanitize: an SSRF block names an internal address — never store/return/log it verbatim.
      const sanitized = sanitizeBatchError(error);
      result.error = sanitized;
      batch.progress.failed++;
      batch.progress.pending--;

      // Fire message:failed so alerting/analytics plugins observe bulk failures too (previously
      // none) — but NOT for a plugin gate-block (a moderation decision) nor a pacing refusal (a
      // policy 429, thrown before the engine was asked): neither is a delivery failure, matching
      // single send where a block is a 400 and a pacing refusal is a 429, neither firing the hook.
      if (!blockedByPlugin && !isPacingLimitedError(error)) {
        await this.hookManager.execute(
          'message:failed',
          {
            sessionId: batch.sessionId,
            error: sanitized.message,
            input: { ...content, chatId: msg.chatId },
            type: msg.type,
          },
          { sessionId: batch.sessionId, source: 'BulkMessageService' },
        );
      }

      // The log alone carries the cause: an EnginePageError keeps the full in-page summary (stack,
      // own properties) there, and this batch runs in the background, so no other log sees it.
      const cause =
        !(error instanceof SsrfBlockedError) && error instanceof Error && error.cause instanceof Error
          ? ` (cause: ${error.cause.message})`
          : '';
      this.logger.warn(
        `Batch ${batch.batchId}: Failed message ${i + 1} to ${msg.chatId}: ${sanitized.message}${cause}`,
      );

      if (batch.options.stopOnError) {
        batch.status = BatchStatus.FAILED;
        state.stoppedOnError = true;
        results.push(result);
        return false;
      }
    }

    results.push(result);
    batch.currentIndex = i + 1;
    batch.results = results;

    // Save progress after every item: the row is what batch status, a cancel served by another
    // process and the reapers read. Honor a cancellation issued by ANY process (the in-memory Map
    // only sees same-process cancels), and a reap that failed the batch after another node took the
    // session over. The guard lives IN the UPDATE (not a read-then-write), so neither can be written
    // over: zero affected rows stops the loop, and the row says which of the two it was.
    const progressSaved = await this.batchRepository.update(
      { id: batch.id, status: BatchStatus.PROCESSING },
      { progress: batch.progress, results, currentIndex: batch.currentIndex },
    );
    if (!progressSaved.affected) {
      await this.noteRowLeftProcessing(batch, state, `at index ${i}`);
      return false;
    }

    // Delay before next message (except for last)
    if (i < batch.messages.length - 1 && this.processingBatches.get(batch.id)) {
      const delay = this.calculateDelay(batch.options);
      await setTimeout(delay);
    }
    return true;
  }

  /**
   * The row stopped being PROCESSING under this run. CANCELLED, or a row deleted with its session, is
   * a cancel, reconciled by finalizeBatch. FAILED was written by another node's reap after it took the
   * session over (COMPLETED is matched too, though only this run writes it); that status is the
   * batch's outcome now, and this run only records what it sent.
   */
  private async noteRowLeftProcessing(batch: MessageBatch, state: BatchExecutionState, where: string): Promise<void> {
    const fresh = await this.batchRepository.findOne({ where: { id: batch.id }, select: { status: true } });
    if (fresh && ENDED_ELSEWHERE.has(fresh.status)) {
      state.endedElsewhere = true;
      this.logger.warn(`Batch ${batch.batchId} was ended elsewhere (${fresh.status}) ${where}; keeping that status`);
      return;
    }
    state.cancelledByDb = true;
    this.logger.log(`Batch ${batch.batchId} cancelled (DB) ${where}`);
  }

  /**
   * Another writer set this row's status (a reap's FAILED, or a cancel that won the final write), but
   * only this run knows which items it sent: record them, so the batch status reports the delivered
   * items and a re-issue can leave them out. Guarded on that status; status, completedAt and the
   * stripped payloads stay as the other writer left them.
   */
  private async keepResultsOnEndedRow(
    batch: MessageBatch,
    results: BatchMessageResult[],
    status: BatchStatus = BatchStatus.FAILED,
    progress: BatchProgress = batch.progress,
  ): Promise<void> {
    await this.batchRepository.update(
      { id: batch.id, status },
      { progress, results, currentIndex: batch.currentIndex },
    );
  }

  private async finalizeBatch(batch: MessageBatch, state: BatchExecutionState): Promise<void> {
    const { results } = state;
    if (state.endedElsewhere) return this.keepResultsOnEndedRow(batch, results);
    // Final update. `batch` still holds the in-memory PROCESSING status from the start, so the
    // terminal status is re-derived from the cancellation signals (DB + in-memory flag) rather than
    // saved blindly. The re-read below narrows the race window so the reconciled counters stay
    // consistent in the common case; the guarded write after it closes what remains.
    if (!state.cancelledByDb) {
      const fresh = await this.batchRepository.findOne({ where: { id: batch.id }, select: { status: true } });
      if (fresh?.status === BatchStatus.CANCELLED) {
        state.cancelledByDb = true;
      } else if (fresh && ENDED_ELSEWHERE.has(fresh.status)) {
        this.logger.warn(`Batch ${batch.batchId} was ended elsewhere (${fresh.status}); keeping that status`);
        return this.keepResultsOnEndedRow(batch, results);
      }
    }
    const cancelled = state.cancelledByDb || !this.processingBatches.get(batch.id);
    batch.status = resolveFinalBatchStatus(cancelled, state.stoppedOnError, batch.progress);
    // Counters reconciled the same way cancelBatch does, for a CANCELLED row only. A copy: a write that
    // loses to a reap records the unreconciled counters, since that cancel never took effect.
    const cancelledProgress: BatchProgress = { ...batch.progress, cancelled: batch.progress.pending, pending: 0 };
    batch.completedAt = new Date();
    batch.results = results;
    // The batch is terminal now (never resumed), so drop the base64 media payloads before persisting —
    // otherwise the message_batches row retains multi-MB media forever.
    this.stripBatchMediaPayloads(batch.messages);
    const terminal = {
      status: batch.status,
      progress: cancelled ? cancelledProgress : batch.progress,
      results,
      currentIndex: batch.currentIndex,
      completedAt: batch.completedAt,
      messages: batch.messages,
    } as QueryDeepPartialEntity<MessageBatch>;
    if (batch.status === BatchStatus.CANCELLED) {
      // Write the reconciled counters over cancelBatch's own (possibly earlier, staler) write, but
      // never over a batch another node's reap failed meanwhile. An UPDATE, not a save: a row deleted
      // with its session also reads as a cancel, and save() would INSERT it back.
      const reconciled = await this.batchRepository.update(
        { id: batch.id, status: In([BatchStatus.PROCESSING, BatchStatus.CANCELLED]) },
        terminal,
      );
      // A reap that failed the batch after the re-read above keeps its status; the items this run sent
      // still go on the row (a no-op for a row deleted with its session).
      if (!reconciled.affected) await this.keepResultsOnEndedRow(batch, results);
    } else {
      // A cancel or a reap may have committed after the re-read above; the guard IN the UPDATE makes
      // this terminal write unable to replace either. Zero affected rows means one of them won the
      // final race: its status stands, and this run still records what it sent, with the counters
      // reconciled for a cancel.
      const finalized = await this.batchRepository.update({ id: batch.id, status: BatchStatus.PROCESSING }, terminal);
      if (!finalized.affected) {
        const stored = await this.batchRepository.findOne({ where: { id: batch.id }, select: { status: true } });
        batch.status = stored?.status ?? BatchStatus.CANCELLED;
        if (batch.status === BatchStatus.FAILED) {
          await this.keepResultsOnEndedRow(batch, results);
        } else if (batch.status === BatchStatus.CANCELLED && stored) {
          await this.keepResultsOnEndedRow(batch, results, BatchStatus.CANCELLED, cancelledProgress);
        }
        this.logger.log(`Batch ${batch.batchId} left PROCESSING just before completion; keeping ${batch.status}`);
      }
    }

    this.logger.log(`Batch ${batch.batchId} completed: ${batch.progress.sent} sent, ${batch.progress.failed} failed`);
  }

  /**
   * Require the field the item's type sends: a non-empty text for a text item, a url or base64 under
   * the matching media key otherwise. The DTO cannot express this per type, so it runs at batch
   * creation (a 400) and again per item after variables and the message:sending gate.
   */
  private assertItemContent(type: string, content: BulkMessageContent, beforeRender = false): void {
    if (type === 'text') {
      if (typeof content?.text !== 'string' || !content.text) {
        throw new BadRequestException('A text item requires a non-empty content.text');
      }
      return;
    }
    const media = content?.[type as 'image' | 'video' | 'audio' | 'document'];
    if (stripBase64DataUri(media?.base64)) return;
    if (!media?.url) {
      throw new BadRequestException(`A ${type} item requires content.${type}.url or content.${type}.base64`);
    }
    // Checked here rather than on the DTO because `variables` may supply the whole URL: before
    // rendering, a value holding a placeholder is left to the per-item check, which sees the rendered
    // (and plugin-rewritten) URL.
    if (!(beforeRender && typeof media.url === 'string' && media.url.includes('{')) && !isMediaUrl(media.url)) {
      throw new BadRequestException(`content.${type}.url must be an absolute http(s) URL`);
    }
  }

  /**
   * Bound one content payload's base64 media to the shared media byte cap. Runs at batch creation
   * and again per item after template variables and the message:sending gate are applied — both
   * can grow (or empty out) a payload relative to what was verified at create time.
   */
  private assertContentMediaWithinCap(content: BulkMessageContent): void {
    for (const media of [content?.image, content?.video, content?.audio, content?.document]) {
      const base64 = stripBase64DataUri(media?.base64);
      if (media?.base64 !== undefined && !base64 && !media.url) {
        throw new BadRequestException('Either url or base64 must be provided for bulk media');
      }
      assertBase64WithinMediaCap(base64);
    }
  }

  /**
   * Drop base64 payloads from a finished batch's stored message list. A completed/cancelled batch is
   * terminal (never resumed), so the (often multi-MB) base64 in `message_batches.messages` is dead
   * weight; the descriptive fields (mimetype/filename/caption/url) are kept.
   */
  private stripBatchMediaPayloads(messages: MessageBatch['messages']): void {
    for (const m of messages ?? []) {
      for (const key of ['image', 'video', 'audio', 'document']) {
        const media = m.content[key] as { base64?: unknown } | undefined;
        if (media && typeof media === 'object' && 'base64' in media) {
          delete media.base64;
        }
      }
    }
  }

  private applyVariables(content: BulkMessageContent, variables?: Record<string, string>): BulkMessageContent {
    if (!variables) return content;

    // Cap the RENDERED result, mirroring the single-send template path. `content.text` is
    // @MaxLength(4096)-validated on the way in, but that runs BEFORE substitution, so a caller-supplied
    // variable inflates a small item without bound: the request body stays far under the in-flight body
    // budget while each rendered item does not. Rejected (never truncated), which fails this item the
    // way a pacing refusal does rather than handing the engine and the messages.body column a string
    // of arbitrary size.
    const maxChars =
      this.configService?.get<number>('template.renderMaxChars', DEFAULT_TEMPLATE_RENDER_MAX_CHARS) ??
      DEFAULT_TEMPLATE_RENDER_MAX_CHARS;

    // Delegate to the shared renderer so the gateway exposes one templating syntax (#69). It
    // substitutes canonical `{{name}}` placeholders and still honors the legacy single-brace
    // `{name}` this endpoint historically used (deprecated — prefer `{{name}}`).
    const replaceVars = (str: string): string => renderTemplate(str, variables);

    const processValue = (value: unknown): unknown => {
      if (typeof value === 'string') {
        return replaceVars(value);
      }
      if (Array.isArray(value)) {
        return value.map(processValue);
      }
      if (typeof value === 'object' && value !== null) {
        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          result[k] = processValue(v);
        }
        return result;
      }
      return value;
    };

    const rendered = processValue(content) as BulkMessageContent;

    // Cap the MESSAGE, not the payload. Substitution runs over the whole content tree (a URL or a
    // filename may carry a placeholder too), but only the text-bearing fields are bounded: `base64`
    // holds media, which `assertBase64WithinMediaCap` governs at up to MEDIA_DOWNLOAD_MAX_BYTES —
    // three orders of magnitude above this cap. Capping every string rejected the most natural bulk
    // request there is, a personalised media send, because a 100 KB image is ~137,000 base64
    // characters.
    for (const field of ['text', 'caption'] as const) {
      const value = rendered[field];
      if (typeof value === 'string' && value.length > maxChars) {
        throw new BadRequestException(
          `Rendered ${field} is ${value.length} characters, over the ${maxChars}-character limit`,
        );
      }
    }
    return rendered;
  }

  /**
   * Persist a successfully-sent batch message via the shared single-send persistence path, so it
   * shows up in chat history and stats like any other outgoing message. Best-effort: a persistence
   * failure must never flip a message that actually went out to FAILED.
   */
  private async persistSentMessage(
    sessionId: string,
    chatId: string,
    type: string,
    content: BulkMessageContent,
    result: MessageResult,
  ): Promise<void> {
    // Store what sendMessage sent: the media under the item's own type key, and the caption for a
    // media item (audio carries none). Other keys on the item were never delivered.
    const media = type === 'text' ? undefined : content[type as 'image' | 'video' | 'audio' | 'document'];
    const body = type === 'text' ? content.text : type === 'audio' ? undefined : content.caption;
    // A bulk audio item flagged ptt is a voice note; store it in the 'voice' bucket like inbound PTT.
    const persistType = type === 'audio' && content.audio?.ptt ? 'voice' : type;
    try {
      await this.messageService.saveOutgoingMessage(sessionId, {
        waMessageId: result.id,
        chatId,
        body: body ?? '',
        type: persistType,
        timestamp: result.timestamp,
        status: MessageStatus.SENT,
        metadata: media
          ? {
              media: {
                mimetype: this.mediaMimetype(type, content),
                data: stripBase64DataUri(media.base64) || media.url,
                filename: media.filename,
              },
            }
          : undefined,
      });
    } catch (error) {
      // Losing the dedup race to the own-send echo is no longer an error here — saveOutgoingMessage
      // merges onto the echo's row. Anything reaching this point is a real persistence fault.
      this.logger.warn(`Batch message persisted-after-send failed: ${String(error)}`);
    }
  }

  /**
   * The mimetype a media item is sent with, and so the one its row must record: a stored row with no
   * mimetype cannot be served back from the media endpoint. An undeclared URL item gets the
   * 'application/octet-stream' placeholder buildMediaInput uses, which both engines read as "unknown",
   * so the fetched Content-Type wins. A voice note keeps ogg/opus either way, as on the single send.
   */
  private mediaMimetype(type: string, content: BulkMessageContent): string {
    const media = content[type as 'image' | 'video' | 'audio' | 'document'];
    if (media?.mimetype) return media.mimetype;
    if (type === 'audio' && content.audio?.ptt) return 'audio/ogg; codecs=opus';
    if (!stripBase64DataUri(media?.base64)) return 'application/octet-stream';
    if (type === 'image') return 'image/jpeg';
    if (type === 'video') return 'video/mp4';
    if (type === 'audio') return 'audio/mpeg';
    return 'application/octet-stream';
  }

  private sendMessage(
    engine: IWhatsAppEngine,
    chatId: string,
    type: string,
    content: BulkMessageContent,
  ): Promise<MessageResult> {
    switch (type) {
      case 'text':
        return content.mentions?.length
          ? engine.sendTextMessage(chatId, content.text || '', content.mentions)
          : engine.sendTextMessage(chatId, content.text || '');
      case 'image':
        return engine.sendImageMessage(chatId, {
          mimetype: this.mediaMimetype(type, content),
          data: stripBase64DataUri(content.image?.base64) || content.image?.url || '',
          caption: content.caption,
          mentions: content.mentions,
        });
      case 'video':
        return engine.sendVideoMessage(chatId, {
          mimetype: this.mediaMimetype(type, content),
          data: stripBase64DataUri(content.video?.base64) || content.video?.url || '',
          caption: content.caption,
          mentions: content.mentions,
        });
      case 'audio':
        // Forwarded even though audio carries no caption: a mention tags the recipient through
        // contextInfo without visible @text, which is why the single-send audio route accepts it too
        // (see sendAudioMessage in baileys-messaging.ts). Dropping it here would accept the field and
        // then deliver an untagged voice note with nothing to say so.
        return engine.sendAudioMessage(chatId, {
          mimetype: this.mediaMimetype(type, content),
          data: stripBase64DataUri(content.audio?.base64) || content.audio?.url || '',
          ptt: content.audio?.ptt,
          mentions: content.mentions,
        });
      case 'document':
        return engine.sendDocumentMessage(chatId, {
          mimetype: this.mediaMimetype(type, content),
          data: stripBase64DataUri(content.document?.base64) || content.document?.url || '',
          filename: content.document?.filename,
          caption: content.caption,
          mentions: content.mentions,
        });
      default:
        return Promise.reject(new Error(`Unsupported message type: ${type}`));
    }
  }

  private calculateDelay(options: { delayBetweenMessages: number; randomizeDelay: boolean }): number {
    let delay = options.delayBetweenMessages;
    if (options.randomizeDelay) {
      delay += Math.random() * 2000; // Add 0-2 seconds random
    }
    return delay;
  }
}
