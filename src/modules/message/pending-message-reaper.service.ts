import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, QueryDeepPartialEntity, Repository } from 'typeorm';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { HookManager } from '../../core/hooks';
import { createLogger } from '../../common/services/logger.service';
import { resolveNonNegativeIntEnv } from '../../config/configuration';

export interface PendingMessageReaperOptions {
  // Sweep cadence. 0 disables the reaper (mirrors INGRESS_RECONCILE_INTERVAL_MS). A blank or
  // otherwise unparseable value falls back to the default rather than disabling the sweep, so a
  // mis-set variable can never silently turn the reaper off.
  intervalMs: number;
  // An outgoing PENDING row only becomes reap-eligible once it is older than this — the live send
  // path gets the whole window to persist its own SENT/FAILED outcome first.
  graceMs: number;
  batchSize: number;
}

export function resolvePendingMessageReaperOptions(env: NodeJS.ProcessEnv = process.env): PendingMessageReaperOptions {
  const batch = Number(env.MESSAGE_REAPER_BATCH_SIZE);
  return {
    intervalMs: resolveNonNegativeIntEnv(env.MESSAGE_REAPER_INTERVAL_MS, 10 * 60_000),
    graceMs: resolveNonNegativeIntEnv(env.MESSAGE_REAPER_GRACE_MS, 60 * 60_000),
    batchSize: Number.isInteger(batch) && batch >= 1 ? batch : 50,
  };
}

export interface PendingMessageReaperStats {
  scanned: number;
  reaped: number;
  // Rows whose bookkeeping write failed; they stay PENDING and are retried next sweep.
  failed: number;
}

/**
 * Closes the crash window of the outbound persist-before-send flow. Every sender saves the row
 * PENDING before handing it to the engine and transitions it to SENT/FAILED right after; a process
 * crash between those two writes strands the row PENDING forever — it sits in the messages table,
 * and in any search provider's index fed by `message:persisted`, as a message that never resolves.
 *
 * The reaper sweeps small batches of stale outgoing PENDING rows (older than the grace window),
 * marks them FAILED with a `reapedAt` metadata marker (distinguishable from a genuine send failure
 * without a new column), and re-emits `message:persisted` for each — the same emission MessageService
 * performs for every persisted outbound state — so a provider's copy reconciles to the terminal
 * state instead of staying stuck at the initial PENDING write.
 *
 * Mirrors IngressReconcilerService's lifecycle: a raw unref'd setInterval started on module init
 * (first sweep after one interval), cleared on destroy. Young PENDING rows (a send still in flight)
 * and non-outgoing rows are never touched.
 */
@Injectable()
export class PendingMessageReaperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('PendingMessageReaperService');
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;

  constructor(
    @InjectRepository(Message, 'data') private readonly messages: Repository<Message>,
    private readonly hookManager: HookManager,
  ) {}

  onModuleInit(): void {
    const opts = resolvePendingMessageReaperOptions();
    if (opts.intervalMs <= 0) {
      this.logger.log('Pending message reaper disabled (MESSAGE_REAPER_INTERVAL_MS <= 0)');
      return;
    }
    this.timer = setInterval(() => {
      this.sweep(opts).catch(err =>
        this.logger.error('Pending message reaper sweep failed', err instanceof Error ? err.stack : String(err)),
      );
    }, opts.intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One bounded pass over the stale outgoing-PENDING backlog. Overlap-guarded: a slow sweep never
   * stacks a second pass on top of itself. Each reap write is guarded on the row still being
   * PENDING, so a send that resolves between the find and the write keeps its own outcome.
   */
  async sweep(opts: PendingMessageReaperOptions, now: Date = new Date()): Promise<PendingMessageReaperStats> {
    const stats: PendingMessageReaperStats = { scanned: 0, reaped: 0, failed: 0 };
    if (this.sweeping) return stats;
    this.sweeping = true;
    try {
      const cutoff = new Date(now.getTime() - opts.graceMs);
      const rows = await this.messages.find({
        where: {
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.PENDING,
          createdAt: LessThan(cutoff),
        },
        order: { createdAt: 'ASC' },
        take: opts.batchSize,
      });
      for (const row of rows) {
        stats.scanned++;
        try {
          if (await this.reapRow(row, now)) {
            stats.reaped++;
          }
        } catch (err) {
          // A bookkeeping failure (repo update) must not abort the batch; the row stays PENDING and
          // is retried next sweep.
          this.logger.error(
            'Reaping a stuck pending message failed',
            err instanceof Error ? err.message : String(err),
            { messageId: row.id, sessionId: row.sessionId, action: 'pending_message_reap_failed' },
          );
          stats.failed++;
        }
      }
      if (stats.reaped > 0) {
        this.logger.log(`Reaped ${stats.reaped} outbound message(s) stuck PENDING past the grace window`, {
          action: 'pending_messages_reaped',
        });
      }
      return stats;
    } finally {
      this.sweeping = false;
    }
  }

  private async reapRow(row: Message, now: Date): Promise<boolean> {
    // A reaped row is terminal: it is never retried and its media is never rendered, so drop the
    // base64 payload exactly as MessageService.saveFailedMessage does for a genuine send failure —
    // keeping a multi-MB payload in a terminal row only bloats the messages table. The reapedAt
    // marker tells the reaper's FAILED apart from a real send failure.
    const media = (row.metadata as { media?: { data?: unknown } } | undefined)?.media;
    if (media) {
      delete media.data;
    }
    row.metadata = { ...(row.metadata ?? {}), reapedAt: now.toISOString() };
    row.status = MessageStatus.FAILED;
    // The guard lives IN the UPDATE: a send that resolved between this sweep's find() and this
    // write has already persisted its own SENT + waMessageId, and a blind save would clobber that
    // terminal outcome back to FAILED/null. Zero affected rows = the live path won the race —
    // leave the row alone and skip the emission below.
    const reaped = await this.messages.update({ id: row.id, status: MessageStatus.PENDING }, {
      status: row.status,
      metadata: row.metadata,
    } as QueryDeepPartialEntity<Message>);
    if (!reaped.affected) {
      return false;
    }
    // Reconcile provider copies of the earlier PENDING emission: fire-and-forget with a shallow
    // snapshot, the exact shape of MessageService.emitPersisted — a plugin handler must never
    // break the sweep.
    void this.hookManager
      .execute(
        'message:persisted',
        { sessionId: row.sessionId, message: { ...row } },
        { sessionId: row.sessionId, source: 'PendingMessageReaperService' },
      )
      .catch(() => undefined);
    return true;
  }
}
