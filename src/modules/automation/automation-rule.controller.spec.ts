import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AutomationRuleController } from './automation-rule.controller';
import type { AutomationRulesService } from './automation-rules.service';
import type { AutomationRule } from './entities/automation-rule.entity';

/**
 * The controller is a thin map from route params/DTOs onto AutomationRulesService, plus the
 * entity→response projection. What is worth pinning here is the wiring itself (which argument lands
 * in which slot), that responses expose only the DTO fields, and that service rejections
 * (invalid rule, no such rule) reach the caller unmapped.
 */
function ruleEntity(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rule-1',
    sessionId: 's1',
    session: undefined as unknown as AutomationRule['session'],
    name: 'Greet new enquiries',
    enabled: true,
    conditions: null,
    replyText: 'Thanks for reaching out — we reply within the hour.',
    cooldownSeconds: 60,
    newContactOnly: false,
    pauseOnHumanReply: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

describe('AutomationRuleController', () => {
  const service = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  };
  const controller = new AutomationRuleController(service as unknown as AutomationRulesService);

  beforeEach(() => jest.clearAllMocks());

  it('create delegates to the service and projects the entity onto the response DTO', async () => {
    // Distinct from ruleEntity()'s name/replyText, so a projection that reads the DTO's slots
    // instead of the entity's cannot pass by echoing identical values.
    const dto = { name: 'Away-hours autoresponder', replyText: 'We are closed — we reply next business day.' };
    service.create.mockResolvedValue(ruleEntity());

    const result = await controller.create('s1', dto);

    expect(service.create).toHaveBeenCalledWith('s1', dto);
    expect(result.id).toBe('rule-1');
    expect(result.sessionId).toBe('s1');
    expect(result).not.toHaveProperty('session');
  });

  it('findAll forwards the session id and projects every rule', async () => {
    service.findAll.mockResolvedValue([ruleEntity(), ruleEntity({ id: 'rule-2', enabled: false })]);

    const result = await controller.findAll('s1');

    expect(service.findAll).toHaveBeenCalledWith('s1');
    expect(result.map(rule => rule.id)).toEqual(['rule-1', 'rule-2']);
    expect(result[1].enabled).toBe(false);
    expect(result[0]).not.toHaveProperty('session');
  });

  it('findOne forwards both route params', async () => {
    service.findOne.mockResolvedValue(ruleEntity());

    const result = await controller.findOne('s1', 'rule-1');

    expect(service.findOne).toHaveBeenCalledWith('s1', 'rule-1');
    expect(result.id).toBe('rule-1');
  });

  it('update forwards the route params and DTO', async () => {
    const dto = { enabled: false };
    service.update.mockResolvedValue(ruleEntity({ enabled: false }));

    const result = await controller.update('s1', 'rule-1', dto);

    expect(service.update).toHaveBeenCalledWith('s1', 'rule-1', dto);
    expect(result.enabled).toBe(false);
  });

  it('remove forwards both route params and resolves without a body', async () => {
    service.remove.mockResolvedValue(undefined);

    await expect(controller.remove('s1', 'rule-1')).resolves.toBeUndefined();
    expect(service.remove).toHaveBeenCalledWith('s1', 'rule-1');
  });

  it('create propagates invalid-rule rejections unmapped', async () => {
    const error = new BadRequestException('Rule text exceeds the length limit');
    service.create.mockRejectedValue(error);

    await expect(controller.create('s1', { name: 'Too long', replyText: 'x'.repeat(5000) })).rejects.toBe(error);
  });

  it('findOne propagates not-found rejections unmapped', async () => {
    const error = new NotFoundException('Automation rule rule-404 not found');
    service.findOne.mockRejectedValue(error);

    await expect(controller.findOne('s1', 'rule-404')).rejects.toBe(error);
  });

  it('remove propagates not-found rejections unmapped', async () => {
    const error = new NotFoundException('Automation rule rule-404 not found');
    service.remove.mockRejectedValue(error);

    await expect(controller.remove('s1', 'rule-404')).rejects.toBe(error);
  });
});
