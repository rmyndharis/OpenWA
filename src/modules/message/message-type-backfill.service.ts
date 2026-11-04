import { Injectable, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message } from './entities/message.entity';
import { createLogger } from '../../common/services/logger.service';
import { BackfillLegacyMessageTypes1791300000000 } from '../../database/migrations/1791300000000-BackfillLegacyMessageTypes';

/**
 * Backfill of `messages.type` to the engine-neutral vocabulary (#265) for the one setup where no migration
 * ever runs: a SQLite data DB under DATABASE_SYNCHRONIZE=true (the dev and e2e setup, where `migrationsRun` is
 * false). Every other database got the same conversion once, from BackfillLegacyMessageTypes, which runs
 * on a pool without the runtime statement timeout. Running it at every boot there meant a full scan of the
 * unindexed `type` column on each start, ahead of the HTTP listener.
 *
 * The conversion is idempotent (the neutral targets were never valid raw tokens), so running it on every
 * boot of a synchronized database is safe, and it stays a single statement in the migration, which owns it.
 */
@Injectable()
export class MessageTypeBackfillService implements OnApplicationBootstrap {
  private readonly logger = createLogger('MessageTypeBackfill');

  constructor(
    @InjectRepository(Message, 'data')
    private readonly messageRepository: Repository<Message>,
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.configService?.get<boolean>('dataDatabase.synchronize', false) !== true) return;

    const runner = this.messageRepository.manager.connection.createQueryRunner();
    try {
      await BackfillLegacyMessageTypes1791300000000.backfill(runner);
    } catch (error) {
      // Non-fatal: new rows are already neutral; only historical rows are affected. Surface it so it
      // can be re-run (e.g. via a restart) rather than crashing boot.
      this.logger.error(
        'Failed to backfill legacy message types',
        error instanceof Error ? error.stack : String(error),
        { action: 'message_type_backfill_failed' },
      );
    } finally {
      await runner.release();
    }
  }
}
