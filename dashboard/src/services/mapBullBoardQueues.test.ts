import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapBullBoardQueues } from './mapBullBoardQueues.ts';

test('mapBullBoardQueues aggregates pending from waiting+active+delayed', () => {
  const mapped = mapBullBoardQueues({
    queues: [
      {
        name: 'webhook-queue',
        counts: {
          waiting: 2,
          active: 1,
          delayed: 3,
          completed: 10,
          failed: 4,
          prioritized: 0,
          'waiting-children': 0,
        },
      },
    ],
  });

  assert.equal(mapped.configured, true);
  assert.equal(mapped.source, 'bull-board');
  assert.deepEqual(mapped.queues, [{ name: 'webhook-queue', counts: { pending: 6, completed: 10, failed: 4 } }]);
});

test('mapBullBoardQueues treats empty queues as configured empty list', () => {
  const mapped = mapBullBoardQueues({ queues: [] });
  assert.equal(mapped.configured, true);
  assert.equal(mapped.source, 'bull-board');
  assert.deepEqual(mapped.queues, []);
});
