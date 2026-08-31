import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutomationRule } from './entities/automation-rule.entity';
import { Message } from '../message/entities/message.entity';
import { AutomationRulesService } from './automation-rules.service';
import { AutomationRuleController } from './automation-rule.controller';

/**
 * Deliberately imports no feature module: SessionModule imports this one (the projector fires rule
 * evaluation), so anything imported here must not lead back to SessionModule. The reply dependency
 * (MessageService) is resolved lazily via ModuleRef inside the service for exactly that reason.
 *
 * `forFeature([..., Message])` is NOT a breach of that rule and needs no forwardRef: it registers
 * repository providers off the root `data` DataSource, not an edge to MessageModule, and the
 * Message ENTITY file imports nothing but typeorm and the column-type helpers. ChatMediaModule and
 * StatsModule inject `Repository<Message>` the same way without importing MessageModule at all.
 * The chat-history gates (`newContactOnly`, `pauseOnHumanReply`) read that repository.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AutomationRule, Message], 'data')],
  controllers: [AutomationRuleController],
  providers: [AutomationRulesService],
  exports: [AutomationRulesService],
})
export class AutomationModule {}
