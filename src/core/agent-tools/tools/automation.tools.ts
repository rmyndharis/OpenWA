import { z } from 'zod';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import type { AutomationRulesService } from '../../../modules/automation/automation-rules.service';
import { AutomationRuleResponseDto } from '../../../modules/automation/dto/automation-rule.dto';
import { defineTool, type AnyToolDescriptor } from '../tool-descriptor';

const sessionId = z.string().min(1).describe('Session UUID (the session id, not the name)');

export function automationTools(automation: AutomationRulesService): AnyToolDescriptor[] {
  return [
    defineTool({
      name: 'AutomationRuleFindAll',
      description: 'List a session’s autoreply rules in evaluation order (creation time, id as tiebreak).',
      tier: 'read',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({ sessionId }),
      handler: input =>
        automation
          .findAll(input.sessionId)
          .then(rules => rules.map(rule => AutomationRuleResponseDto.fromEntity(rule))),
    }),
    defineTool({
      name: 'AutomationRuleFindOne',
      description: 'Get one autoreply rule by ID within a session.',
      tier: 'read',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        ruleId: z.string().describe('Rule UUID'),
      }),
      handler: input =>
        automation.findOne(input.sessionId, input.ruleId).then(rule => AutomationRuleResponseDto.fromEntity(rule)),
    }),
  ];
}
