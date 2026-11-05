import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBulkRecipients } from './bulkRecipients.ts';

test('a 00 exit code is dropped from a short international number too', () => {
  assert.deepEqual(parseBulkRecipients('00376 612 345\n00298 212345\n00687 751234'), [
    '376612345@c.us',
    '298212345@c.us',
    '687751234@c.us',
  ]);
});

test('the exit code does not let an undersized number pass the digit floor', () => {
  assert.deepEqual(parseBulkRecipients('001234\n0012345'), []);
});
