import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Session } from './entities/session.entity';
import { Message } from '../message/entities/message.entity';
import { MessageQuote } from '../message/entities/message-quote.entity';
import { MessageReaction } from '../message/entities/message-reaction.entity';
import { SessionService } from './session.service';
import { SessionController } from './session.controller';
import { WebhookModule } from '../webhook/webhook.module';

@Module({
  // WebhookModule does not import SessionModule back, so the dependency is one-directional —
  // no forwardRef() needed.
  imports: [TypeOrmModule.forFeature([Session, Message, MessageQuote, MessageReaction], 'data'), WebhookModule],
  controllers: [SessionController],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
