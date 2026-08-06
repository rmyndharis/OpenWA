import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutomationRule } from './entities/automation-rule.entity';
import { AutomationRulesService } from './automation-rules.service';
import { AutomationRuleController } from './automation-rule.controller';

/**
 * Deliberately imports no feature module: SessionModule imports this one (the projector fires rule
 * evaluation), so anything imported here must not lead back to SessionModule. The reply dependency
 * (MessageService) is resolved lazily via ModuleRef inside the service for exactly that reason.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AutomationRule], 'data')],
  controllers: [AutomationRuleController],
  providers: [AutomationRulesService],
  exports: [AutomationRulesService],
})
export class AutomationModule {}
