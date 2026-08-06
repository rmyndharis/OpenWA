import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessageService } from './message.service';
import { BulkMessageService } from './bulk-message.service';
import { MessageTypeBackfillService } from './message-type-backfill.service';
import { PendingMessageReaperService } from './pending-message-reaper.service';
import { MessageController } from './message.controller';
import { SessionModule } from '../session/session.module';
import { TemplateModule } from '../template/template.module';
import { ChatMediaModule } from '../chat-media/chat-media.module';
import { Message } from './entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { SendPacingService } from './send-pacing.service';
import { MessageBatch } from './entities/message-batch.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Message, MessageBatch, Session], 'data'),
    SessionModule,
    TemplateModule,
    ChatMediaModule,
  ],
  controllers: [MessageController],
  providers: [
    MessageService,
    BulkMessageService,
    MessageTypeBackfillService,
    PendingMessageReaperService,
    SendPacingService,
  ],
  exports: [MessageService, BulkMessageService, SendPacingService],
})
export class MessageModule {}
