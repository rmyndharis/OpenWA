import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  Optional,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, QueryDeepPartialEntity, Repository } from 'typeorm';
import { createHash, randomUUID } from 'crypto';
import {
  MessageBatch,
  BatchStatus,
  BatchMessageStatus,
  BatchProgress,
  BatchMessageResult,
} from './entities/message-batch.entity';
import { SendBulkMessageDto } from './dto/bulk-message.dto';
import { MessageStatus } from './entities/message.entity';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { MessageService } from './message.service';
import {
  SendPacingService,
  isPacingLimitedError,
  countsTowardSendBreaker,
  SEND_PACING_LIMITED,
} from './send-pacing.service';
import { SessionOwnershipService } from '../session/session-ownership.service';
import { HookManager } from '../../core/hooks';
import { assertBase64WithinMediaCap, stripBase64DataUri } from './media-cap.util';
import { SsrfBlockedError, SSRF_BLOCKED_CLIENT_MESSAGE } from '../../common/security/ssrf-guard';
import { renderTemplate } from '../../common/utils/template-render';
import { IWhatsAppEngine, MessageResult } from '../../engine/interfaces/whatsapp-engine.interface';
import { resolveNonNegativeIntEnv } from '../../config/configuration';

// Type definitions for bulk message content
interface BulkMessageContent {
  text?: string;
  caption?: string;
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
}

@Injectable()
export class BulkMessageService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BulkMessageService.name);
  private readonly processingBatches = new Map<string, boolean>(); // Track active batches for cancellation
  private inFlightBatches = 0; // count of batches currently in processBatch (memory bound, see cap above)

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
  ) {}

  /**
   * Transition orphaned batches on startup. A batch still in PROCESSING belongs to a
   * previous (crashed/restarted) process — this fresh process is not driving it, so it would
   * otherwise be stuck in PROCESSING forever. Mark it FAILED. Auto-resume is intentionally NOT
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
    const processing = await this.batchRepository.find({ where: { status: BatchStatus.PROCESSING } });
    const orphaned = await this.ownedByThisNode(processing);
    for (const batch of orphaned) {
      await this.failOrphanedBatch(batch);
    }
    if (orphaned.length > 0) {
      this.logger.warn(
        `Marked ${orphaned.length} orphaned PROCESSING batch(es) FAILED on startup (interrupted by a restart)`,
      );
    }
    const skipped = processing.length - orphaned.length;
    if (skipped > 0) {
      this.logger.log(`Left ${skipped} PROCESSING batch(es) alone: their sessions are held by another node`);
    }
  }

  private async failOrphanedBatch(batch: MessageBatch): Promise<void> {
    batch.status = BatchStatus.FAILED;
    this.stripBatchMediaPayloads(batch.messages);
    await this.batchRepository.save(batch);
  }

  /**
   * Fail a session's stuck PROCESSING batches after the session was adopted from a lapsed node.
   * Same policy as the boot reaper and for the same reason: the dead node's already-sent messages
   * are unknowable, so resuming risks double-sends — FAILED with the payloads stripped is the
   * honest terminal state, and the caller can re-issue the batch knowingly.
   */
  async reapProcessingBatches(sessionId: string, reason: string): Promise<number> {
    const processing = await this.batchRepository.find({ where: { status: BatchStatus.PROCESSING, sessionId } });
    for (const batch of processing) {
      await this.failOrphanedBatch(batch);
    }
    if (processing.length > 0) {
      this.logger.warn(`Marked ${processing.length} PROCESSING batch(es) FAILED for session ${sessionId} (${reason})`);
    }
    return processing.length;
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
    for (const { content } of messages) {
      this.assertContentMediaWithinCap(content);
    }

    const batchId = dto.batchId || `batch_${randomUUID().split('-')[0]}`;

    // Check if this batchId already exists FOR THIS SESSION. Scoping by sessionId (matching how
    // getBatchStatus/cancelBatch already query) makes (sessionId, batchId) the namespace: one session
    // can't deny another a batchId, and the 400-vs-202 difference can't probe another session's ids.
    const existing = await this.batchRepository.findOne({ where: { batchId, sessionId } });
    if (existing) {
      throw new BadRequestException(`Batch ID '${batchId}' already exists`);
    }

    // Reject before persisting a row when too many batches are already processing, so a burst can't
    // hold an unbounded number of full message sets (base64 media included) in memory at once.
    const maxConcurrentBatches = resolveMaxConcurrentBatches();
    if (maxConcurrentBatches > 0 && this.inFlightBatches >= maxConcurrentBatches) {
      throw new BadRequestException(`Too many bulk batches in progress (max ${maxConcurrentBatches}); retry shortly`);
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
      batchId,
      sessionId,
      status: BatchStatus.PENDING,
      messages: messages as MessageBatch['messages'],
      options,
      progress,
      results: [],
      currentIndex: 0,
    });

    // Reserve synchronously in the same turn as the cap check. There is deliberately no await between
    // them, so a burst cannot all observe the same stale count and overshoot the ceiling.
    this.inFlightBatches++;
    try {
      await this.batchRepository.save(batch);
    } catch (error) {
      this.inFlightBatches--;
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

    // Signal cancellation
    this.processingBatches.set(batch.id, false);

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
      this.processingBatches.set(batch.id, true);
      await this.executeBatch(batch);
    } finally {
      if (reserved) this.inFlightBatches--;
      if (batch) this.processingBatches.delete(batch.id);
    }
  }

  private async executeBatch(batch: MessageBatch): Promise<void> {
    if (!(await this.markBatchProcessing(batch))) return;

    const engine = this.engines.get(batch.sessionId);
    if (!engine) {
      await this.failBatchWithoutEngine(batch);
      return;
    }

    const results: BatchMessageResult[] = batch.results || [];
    const state: BatchExecutionState = { results, stoppedOnError: false, cancelledByDb: false };
    await this.processBatchMessages(batch, engine, state);
    await this.finalizeBatch(batch, state);
  }

  /** Returns false when a committed cancel won the guarded start UPDATE — send nothing. */
  private async markBatchProcessing(batch: MessageBatch): Promise<boolean> {
    // Transition to PROCESSING with the guard IN the UPDATE: it only lands while the stored status
    // is not CANCELLED, so a cancel that already committed (any process) can never be overwritten
    // back to PROCESSING. Zero affected rows = cancel-before-start won; send nothing.
    batch.status = BatchStatus.PROCESSING;
    batch.startedAt = new Date();
    const started = await this.batchRepository.update(
      { id: batch.id, status: Not(BatchStatus.CANCELLED) },
      { status: BatchStatus.PROCESSING, startedAt: batch.startedAt },
    );
    if (!started.affected) {
      this.logger.log(`Batch ${batch.batchId} was cancelled before processing started; nothing was sent`);
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

  private async processBatchMessages(
    batch: MessageBatch,
    engine: IWhatsAppEngine,
    state: BatchExecutionState,
  ): Promise<void> {
    for (let i = batch.currentIndex; i < batch.messages.length; i++) {
      if (!(await this.processBatchMessage(batch, engine, i, state))) break;
    }
  }

  /**
   * Send one batch message through the moderation gate, record the outcome, and persist progress.
   * Returns false when the batch loop must stop (cancellation or stopOnError).
   */
  private async processBatchMessage(
    batch: MessageBatch,
    engine: IWhatsAppEngine,
    i: number,
    state: BatchExecutionState,
  ): Promise<boolean> {
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
    try {
      // Apply template variables
      content = this.applyVariables(msg.content, msg.variables);

      // Pacing runs BEFORE the moderation gate, matching MessageService: a send policy forbids is not
      // offered to plugins at all. A refusal is a 429 that fails THIS item (honouring stopOnError),
      // not the batch — the allowance may free up, and a batch killed outright could not resume.
      await this.pacing.assertSendAllowed(batch.sessionId, msg.chatId);

      // Per-message moderation gate — the SAME message:sending hook single sends use, so a
      // compliance/moderation plugin sees bulk traffic too (bulk previously bypassed it entirely).
      // A block fails just THIS message (honouring stopOnError below); a plugin may also rewrite it.
      const gate = await this.hookManager.execute(
        'message:sending',
        { sessionId: batch.sessionId, input: content, type: msg.type },
        { sessionId: batch.sessionId, source: 'BulkMessageService' },
      );
      if (!gate.continue) {
        blockedByPlugin = true;
        throw new BadRequestException('Message sending blocked by plugin');
      }
      content = (gate.data as { input: BulkMessageContent }).input;

      // Re-validate the ACTUAL outbound payload against the media cap: template variables and a
      // gate rewrite can grow base64 media past the limit createBatch verified on the raw input.
      // A violation fails just this item (honouring stopOnError) instead of sending it.
      this.assertContentMediaWithinCap(content);

      // Send message based on type. The engine call is bracketed on its own so the pacing breaker
      // hears exactly what the single-send path feeds it (message.service failSend/persistSentState):
      // recordSendFailure only when the ENGINE was asked and refused — never for the pre-engine
      // pacing/plugin/media-cap throws above — and recordSendSuccess the moment it accepts. Without
      // this the breaker was blind to bulk, the highest-volume path it exists to protect.
      let messageResult;
      try {
        messageResult = await this.sendMessage(engine, msg.chatId, msg.type, content);
      } catch (engineError) {
        // Same filter the single-send path applies: adapters also raise client-fault and
        // engine-state errors from inside this call, and those say nothing about the account.
        if (countsTowardSendBreaker(engineError)) {
          this.pacing.recordSendFailure(batch.sessionId);
        }
        throw engineError;
      }
      this.pacing.recordSendSuccess(batch.sessionId);

      result.status = BatchMessageStatus.SENT;
      result.messageId = messageResult.id;
      result.sentAt = new Date();
      batch.progress.sent++;
      batch.progress.pending--;

      // Persist like a single send so the message shows in chat history + stats. The engine echo
      // (onMessageCreate) fires the webhook/WS but does NOT write the DB, so without this the
      // bulk-sent message is invisible to the messages table.
      await this.persistSentMessage(batch.sessionId, msg.chatId, msg.type, content, messageResult);

      this.logger.debug(`Batch ${batch.batchId}: Sent message ${i + 1}/${batch.messages.length} to ${msg.chatId}`);
    } catch (error) {
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
          { sessionId: batch.sessionId, error: sanitized.message, input: content, type: msg.type },
          { sessionId: batch.sessionId, source: 'BulkMessageService' },
        );
      }

      this.logger.warn(`Batch ${batch.batchId}: Failed message ${i + 1} to ${msg.chatId}: ${sanitized.message}`);

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

    // Save progress periodically (every 10 messages or last message)
    if (i % 10 === 0 || i === batch.messages.length - 1) {
      // Honor a cancellation issued by ANY process — the in-memory Map only sees same-process
      // cancels. The guard lives IN the UPDATE (not a read-then-write), so a CANCELLED that
      // committed first can never be clobbered back to PROCESSING: zero affected rows means the
      // cancel won and the loop stops.
      const progressSaved = await this.batchRepository.update(
        { id: batch.id, status: Not(BatchStatus.CANCELLED) },
        { progress: batch.progress, results, currentIndex: batch.currentIndex },
      );
      if (!progressSaved.affected) {
        state.cancelledByDb = true;
        this.logger.log(`Batch ${batch.batchId} cancelled (DB) at index ${i}`);
        return false;
      }
    }

    // Delay before next message (except for last)
    if (i < batch.messages.length - 1 && this.processingBatches.get(batch.id)) {
      const delay = this.calculateDelay(batch.options);
      await this.sleep(delay);
    }
    return true;
  }

  private async finalizeBatch(batch: MessageBatch, state: BatchExecutionState): Promise<void> {
    const { results } = state;
    // Final update. `batch` still holds the in-memory PROCESSING status from the start, so the
    // terminal status is re-derived from the cancellation signals (DB + in-memory flag) rather than
    // saved blindly. The re-read below narrows the race window so the reconciled counters stay
    // consistent in the common case; the guarded write after it closes what remains.
    if (!state.cancelledByDb) {
      const fresh = await this.batchRepository.findOne({ where: { id: batch.id }, select: { status: true } });
      if (fresh?.status === BatchStatus.CANCELLED) {
        state.cancelledByDb = true;
      }
    }
    const cancelled = state.cancelledByDb || !this.processingBatches.get(batch.id);
    batch.status = resolveFinalBatchStatus(cancelled, state.stoppedOnError, batch.progress);
    if (cancelled) {
      // Reconcile the counters the same way cancelBatch does, so the persisted state is consistent.
      batch.progress.cancelled = batch.progress.pending;
      batch.progress.pending = 0;
    }
    batch.completedAt = new Date();
    batch.results = results;
    // The batch is terminal now (never resumed), so drop the base64 media payloads before persisting —
    // otherwise the message_batches row retains multi-MB media forever. Intermediate (cadence) saves
    // above keep the payload so a batch interrupted mid-run can still resume from currentIndex.
    this.stripBatchMediaPayloads(batch.messages);
    if (batch.status === BatchStatus.CANCELLED) {
      // Persisting CANCELLED can never resurrect a finished batch — save the reconciled counters
      // over cancelBatch's own (possibly earlier, staler) write.
      await this.batchRepository.save(batch);
    } else {
      // A cancel may have committed after the re-read above; the guard IN the UPDATE makes this
      // terminal write unable to flip a CANCELLED batch back to COMPLETED/FAILED. Zero affected
      // rows means the cancel won the final race — the batch stays exactly as cancelBatch left it.
      const finalized = await this.batchRepository.update({ id: batch.id, status: Not(BatchStatus.CANCELLED) }, {
        status: batch.status,
        progress: batch.progress,
        results,
        currentIndex: batch.currentIndex,
        completedAt: batch.completedAt,
        messages: batch.messages,
      } as QueryDeepPartialEntity<MessageBatch>);
      if (!finalized.affected) {
        batch.status = BatchStatus.CANCELLED;
        this.logger.log(`Batch ${batch.batchId} was cancelled just before completion; keeping CANCELLED`);
      }
    }

    this.logger.log(`Batch ${batch.batchId} completed: ${batch.progress.sent} sent, ${batch.progress.failed} failed`);
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

    return processValue(content) as BulkMessageContent;
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
    const media = content.image ?? content.video ?? content.audio ?? content.document;
    // A bulk audio item flagged ptt is a voice note; store it in the 'voice' bucket like inbound PTT.
    const persistType = type === 'audio' && content.audio?.ptt ? 'voice' : type;
    try {
      await this.messageService.saveOutgoingMessage(sessionId, {
        waMessageId: result.id,
        chatId,
        body: content.text ?? content.caption ?? '',
        type: persistType,
        timestamp: result.timestamp,
        status: MessageStatus.SENT,
        metadata: media
          ? {
              media: {
                mimetype: media.mimetype,
                data: stripBase64DataUri(media.base64) || media.url,
                filename: media.filename,
              },
            }
          : undefined,
      });
    } catch (error) {
      this.logger.warn(`Batch message persisted-after-send failed: ${String(error)}`);
    }
  }

  private sendMessage(
    engine: IWhatsAppEngine,
    chatId: string,
    type: string,
    content: BulkMessageContent,
  ): Promise<MessageResult> {
    switch (type) {
      case 'text':
        return engine.sendTextMessage(chatId, content.text || '');
      case 'image':
        return engine.sendImageMessage(chatId, {
          mimetype: content.image?.mimetype || 'image/jpeg',
          data: stripBase64DataUri(content.image?.base64) || content.image?.url || '',
          caption: content.caption,
        });
      case 'video':
        return engine.sendVideoMessage(chatId, {
          mimetype: content.video?.mimetype || 'video/mp4',
          data: stripBase64DataUri(content.video?.base64) || content.video?.url || '',
          caption: content.caption,
        });
      case 'audio':
        return engine.sendAudioMessage(chatId, {
          mimetype: content.audio?.mimetype || (content.audio?.ptt ? 'audio/ogg; codecs=opus' : 'audio/mpeg'),
          data: stripBase64DataUri(content.audio?.base64) || content.audio?.url || '',
          ptt: content.audio?.ptt,
        });
      case 'document':
        return engine.sendDocumentMessage(chatId, {
          mimetype: content.document?.mimetype || 'application/octet-stream',
          data: stripBase64DataUri(content.document?.base64) || content.document?.url || '',
          filename: content.document?.filename,
          caption: content.caption,
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

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
