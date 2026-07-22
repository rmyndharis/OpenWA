import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Message } from '../message/entities/message.entity';
import { MessageQuote } from '../message/entities/message-quote.entity';
import { MessageReaction } from '../message/entities/message-reaction.entity';
import { AgentContextController } from './agent-context.controller';
import { AgentContextService } from './agent-context.service';

@Module({
  imports: [TypeOrmModule.forFeature([Message, MessageQuote, MessageReaction], 'data')],
  controllers: [AgentContextController],
  providers: [AgentContextService],
})
export class AgentContextModule {}
