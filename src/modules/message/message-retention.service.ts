import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { Message } from './entities/message.entity';
import { BatchStatus, MessageBatch } from './entities/message-batch.entity';
import { createLogger } from '../../common/services/logger.service';
import { resolveNonNegativeIntEnv } from '../../config/configuration';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rows deleted per statement. Small enough to stay far below the bind-parameter limit of either
 * dialect and to keep each write short: SQLite has one writer, so a long delete (each row also fires
 * the full-text index trigger) would stall message ingest behind it.
 */
const PRUNE_BATCH_SIZE = 500;

/** Statements per run, so one run deletes at most MAX_BATCHES_PER_RUN * PRUNE_BATCH_SIZE rows. */
const MAX_BATCHES_PER_RUN = 200;

/**
 * Delay before the next run when one stopped at its cap. Without it a deployment that stores more
 * than one run's worth of messages a day, or a first enable against a large backlog, never catches up.
 */
const CAPPED_RUN_FOLLOW_UP_MS = 60_000;

/** Batches in these states are finished; pending and processing ones are never pruned. */
const TERMINAL_BATCH_STATUSES = [BatchStatus.COMPLETED, BatchStatus.CANCELLED, BatchStatus.FAILED];

/**
 * The longest window, about a century. A cutoff far enough back is bound on SQLite as a truncated
 * 4-digit year that sorts after today and matches every row, so a larger value must not reach a query.
 * env.validation.ts rejects it at boot.
 */
export const MAX_MESSAGE_RETENTION_DAYS = 36500;

/**
 * MESSAGE_RETENTION_DAYS: stored messages (and finished bulk batches) older than this many days are
 * deleted. 0, unset, negative, not an integer or above MAX_MESSAGE_RETENTION_DAYS keeps everything,
 * which is the default.
 */
export function resolveMessageRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const days = resolveNonNegativeIntEnv(env.MESSAGE_RETENTION_DAYS, 0);
  return days > MAX_MESSAGE_RETENTION_DAYS ? 0 : days;
}

/** The instant before which retention deletes messages, or undefined while retention is off. */
export function resolveMessageRetentionCutoff(
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Date | undefined {
  const days = resolveMessageRetentionDays(env);
  return days > 0 ? new Date(now.getTime() - days * DAY_MS) : undefined;
}

/**
 * Opt-in age limit for the `messages` table and finished `message_batches` rows. Runs once at startup
 * and then daily on an unref'd timer, like the audit-log prune.
 *
 * Deleting a row needs no other cleanup: the SQLite full-text index follows through its delete
 * trigger, the PostgreSQL one is part of the row, and the chat-media orphan sweep removes archived
 * files whose row is gone. Search plugins are NOT told: no `message:deleted` fires per pruned row,
 * the same as on session delete, so an external index keeps its copies.
 */
@Injectable()
export class MessageRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('MessageRetentionService');
  private timer?: ReturnType<typeof setInterval>;
  private followUp?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running = false;

  constructor(
    @InjectRepository(Message, 'data') private readonly messages: Repository<Message>,
    @InjectRepository(MessageBatch, 'data') private readonly batches: Repository<MessageBatch>,
  ) {}

  onModuleInit(): void {
    const days = resolveMessageRetentionDays();
    if (days <= 0) {
      this.logger.log('Message retention disabled (MESSAGE_RETENTION_DAYS unset or <= 0)');
      return;
    }
    const run = (): void => {
      this.prune()
        .then(({ messages, batches }) => {
          if (messages > 0 || batches > 0) {
            this.logger.log(
              `Pruned ${messages} message(s) and ${batches} finished batch(es) older than ${days} day(s)`,
              { action: 'messages_pruned', messages, batches },
            );
          }
          if (messages >= MAX_BATCHES_PER_RUN * PRUNE_BATCH_SIZE && !this.stopped) {
            this.logger.warn('Message retention hit its per-run cap; expired rows remain, running again shortly', {
              action: 'messages_prune_capped',
            });
            clearTimeout(this.followUp);
            this.followUp = setTimeout(run, CAPPED_RUN_FOLLOW_UP_MS);
            this.followUp.unref?.();
          }
        })
        .catch(err =>
          this.logger.error('Message retention prune failed', err instanceof Error ? err.stack : String(err)),
        );
    };
    run();
    this.timer = setInterval(run, DAY_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    clearTimeout(this.followUp);
  }

  /** One bounded pass. Overlap-guarded, and a no-op while retention is off. */
  async prune(now: Date = new Date()): Promise<{ messages: number; batches: number }> {
    const cutoff = resolveMessageRetentionCutoff(now);
    if (!cutoff || this.running) return { messages: 0, batches: 0 };
    this.running = true;
    try {
      let messages = 0;
      for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
        const rows = await this.messages.find({
          select: { id: true },
          where: { createdAt: LessThan(cutoff) },
          order: { createdAt: 'ASC' },
          take: PRUNE_BATCH_SIZE,
        });
        if (rows.length === 0) break;
        await this.messages.delete({ id: In(rows.map(row => row.id)) });
        messages += rows.length;
        if (rows.length < PRUNE_BATCH_SIZE) break;
      }
      const { affected } = await this.batches.delete({
        status: In(TERMINAL_BATCH_STATUSES),
        createdAt: LessThan(cutoff),
      });
      return { messages, batches: affected ?? 0 };
    } finally {
      this.running = false;
    }
  }
}
