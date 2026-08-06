import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Message } from './entities/message.entity';
import { createLogger } from '../../common/services/logger.service';

/**
 * One-time, idempotent backfill of `messages.type` to the engine-neutral vocabulary (#265).
 *
 * Older incoming rows were persisted with raw whatsapp-web.js tokens (`chat`/`ptt`/`vcard`); the
 * engine now emits neutral types (`text`/`voice`/`contact`) at the adapter boundary, and the
 * dashboard chat view + message stats read these persisted rows. Without the backfill, old rows
 * render wrong (text as a `[chat]` media bubble, voice notes as document links) and stats split the
 * same kind across old/new tokens.
 *
 * This runs on startup in EVERY DB mode. A TypeORM data migration would NOT suffice: the zero-config
 * SQLite default uses `synchronize: true`, under which `migrationsRun` is false, so migrations never
 * run there. The mapping is forward-only and collision-free (the neutral targets were never valid
 * raw tokens, and passthrough kinds already match), so re-running on already-converted rows is a
 * no-op — safe to execute on every boot.
 */
@Injectable()
export class MessageTypeBackfillService implements OnApplicationBootstrap {
  private readonly logger = createLogger('MessageTypeBackfill');

  constructor(
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // [legacy wwebjs token(s)] -> neutral MessageType. Kept in sync with mapWwebjsMessageType.
    const conversions: Array<{ from: string[]; to: string }> = [
      { from: ['chat'], to: 'text' },
      { from: ['ptt'], to: 'voice' },
      { from: ['vcard', 'multi_vcard'], to: 'contact' },
    ];

    let total = 0;
    try {
      for (const { from, to } of conversions) {
        const result = await this.messageRepository.update(
          { type: from.length === 1 ? from[0] : In(from) },
          { type: to },
        );
        total += result.affected ?? 0;
      }
      if (total > 0) {
        this.logger.log(`Backfilled ${total} legacy message type(s) to the neutral vocabulary`, {
          action: 'message_type_backfill',
        });
      }
    } catch (error) {
      // Non-fatal: new rows are already neutral; only historical rows are affected. Surface it so it
      // can be re-run (e.g. via a restart) rather than crashing boot.
      this.logger.error(
        'Failed to backfill legacy message types',
        error instanceof Error ? error.stack : String(error),
        { action: 'message_type_backfill_failed' },
      );
    }
  }
}
