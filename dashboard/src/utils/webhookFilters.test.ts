// The Webhooks modal keeps Create/Save disabled while filtersIncomplete is true, so a filter the gateway
// would reject never reaches it (a production build answers with a bare "Bad Request").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WebhookFilterCondition } from '../services/api.ts';
import { filtersIncomplete } from './webhookFilters.ts';

const sender = (value: string[]): WebhookFilterCondition => ({ field: 'sender', operator: 'is', value });

test('no filters, or complete ones, pass', () => {
  assert.equal(filtersIncomplete(null), false);
  assert.equal(filtersIncomplete(undefined), false);
  assert.equal(
    filtersIncomplete({
      conditions: [
        sender(['1@c.us']),
        { field: 'body', operator: 'contains', value: '' },
        { field: 'isGroup', operator: 'is', value: false },
      ],
    }),
    false,
  );
});

test('a list condition with no values is incomplete', () => {
  assert.equal(filtersIncomplete({ conditions: [sender(['1@c.us']), sender([])] }), true);
  assert.equal(filtersIncomplete({ conditions: [{ field: 'type', operator: 'is', value: [] }] }), true);
});

test('the gateway limits are enforced', () => {
  assert.equal(filtersIncomplete({ conditions: Array.from({ length: 20 }, () => sender(['1@c.us'])) }), false);
  assert.equal(filtersIncomplete({ conditions: Array.from({ length: 21 }, () => sender(['1@c.us'])) }), true);
  const values = (n: number) => Array.from({ length: n }, (_, i) => `${i}@c.us`);
  assert.equal(filtersIncomplete({ conditions: [sender(values(100))] }), false);
  assert.equal(filtersIncomplete({ conditions: [sender(values(101))] }), true);
  assert.equal(
    filtersIncomplete({ conditions: [{ field: 'body', operator: 'contains', value: 'x'.repeat(1001) }] }),
    true,
  );
});

test('a chat id entry past the gateway limit of 128 characters is incomplete', () => {
  const entry = (length: number) => '1'.repeat(length - '@g.us'.length) + '@g.us';
  assert.equal(filtersIncomplete({ conditions: [sender([entry(128)])] }), false);
  assert.equal(filtersIncomplete({ conditions: [sender(['1@c.us', entry(129)])] }), true);
});
