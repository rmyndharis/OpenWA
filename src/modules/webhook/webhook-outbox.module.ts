import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhookOutboxEvent } from './entities/webhook-outbox-event.entity';
import { WebhookOutboxService } from './webhook-outbox.service';
import { RecoveryJournal } from '../../common/utils/recovery-journal';

/**
 * The one owner of WebhookOutboxService, which both WebhookModule and QueueModule need. QueueModule
 * cannot import WebhookModule (WebhookModule imports it), and providing the service in each made two
 * instances: the startup prune and the daily prune timer ran twice.
 */
@Module({
  imports: [TypeOrmModule.forFeature([WebhookOutboxEvent], 'data')],
  // The journal of what the database refused: one per process, shared by the outbox and the delivery service.
  providers: [WebhookOutboxService, { provide: RecoveryJournal, useFactory: () => new RecoveryJournal() }],
  exports: [WebhookOutboxService, RecoveryJournal],
})
export class WebhookOutboxModule {}
