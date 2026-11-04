import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateWebhookDto, UpdateWebhookDto, WEBHOOK_EVENTS } from './webhook.dto';
import { CreateAutomationRuleDto, UpdateAutomationRuleDto } from '../../automation/dto/automation-rule.dto';
import { collectFilterErrors } from '../filters/filter-validation';
import { TABLE_IMPORTERS } from '../../infra/table-importers';

// Every event an OpenWA process emits for a session reads and evaluates each active webhook row of that session,
// so what a webhook may store is per-event work. The events list names at most the event vocabulary plus '*', and
// a filter id value is a WhatsApp id; neither has a reason to be megabytes long.
describe('webhook configuration size bounds', () => {
  const url = 'https://receiver.example/hook';
  const vocabulary = WEBHOOK_EVENTS.length + 1;

  it.each([
    ['CreateWebhookDto', CreateWebhookDto, { url }],
    ['UpdateWebhookDto', UpdateWebhookDto, {}],
  ] as const)('%s rejects an events list far longer than the event vocabulary', async (_name, cls, base) => {
    const events = Array.from({ length: 100_000 }, () => 'message.received');
    const errors = await validate(plainToInstance<object, object>(cls, { ...base, events }));
    expect(events.length).toBeGreaterThan(vocabulary);
    expect(errors.map(e => e.property)).toContain('events');
  });

  it('rejects a filter id value of 100,000 characters', async () => {
    const filters = { conditions: [{ field: 'sender', operator: 'is', value: ['6'.repeat(100_000) + '@c.us'] }] };
    const errors = await validate(plainToInstance(CreateWebhookDto, { url, filters }));
    expect(errors.map(e => e.property)).toContain('filters');
  });

  it.each([CreateWebhookDto, UpdateWebhookDto])('accepts the vocabulary and short repeats in %p', async cls => {
    for (const events of [
      [...WEBHOOK_EVENTS, '*'],
      ['message.received', 'message.received'],
    ]) {
      expect(await validate(plainToInstance<object, object>(cls, { url, events }))).toHaveLength(0);
    }
    const errors = await validate(plainToInstance<object, object>(cls, { url, events: [...WEBHOOK_EVENTS, '*', '*'] }));
    expect(errors.map(e => e.property)).toContain('events');
  });

  it.each([
    ['CreateWebhookDto', CreateWebhookDto, { url }, 'filters'],
    ['UpdateWebhookDto', UpdateWebhookDto, {}, 'filters'],
    ['CreateAutomationRuleDto', CreateAutomationRuleDto, { name: 'Reply', replyText: 'Hello' }, 'conditions'],
    ['UpdateAutomationRuleDto', UpdateAutomationRuleDto, {}, 'conditions'],
  ] as const)('%s bounds id and idArray filter values', async (_name, cls, base, property) => {
    for (const field of ['sender', 'recipient', 'chatId', 'mentions']) {
      for (const length of [128, 129]) {
        const filters = { conditions: [{ field, operator: 'is', value: ['1'.repeat(length)] }] };
        const errors = await validate(plainToInstance<object, object>(cls, { ...base, [property]: filters }));
        expect(errors.some(e => e.property === property)).toBe(length > 128);
      }
    }
  });

  it('restores correctly shaped historical configurations beyond the write limits', () => {
    const filters = { conditions: [{ field: 'sender', operator: 'is', value: ['1'.repeat(129)] }] };
    expect(collectFilterErrors(filters)).toEqual([]);
    for (const key of ['webhooks', 'automationRules']) {
      const importer = TABLE_IMPORTERS.find(candidate => candidate.key === key)!;
      const row = { id: 'stored', events: Array(28).fill('message.received'), filters, conditions: filters };
      expect(importer.skip?.(row as never)).toBeNull();
    }
  });
});
