import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBulkRecipients } from './bulkRecipients.ts';

// No phone number has more than 15 digits (E.164). Spaces are formatting inside one number, so two whole numbers on
// one line fold into one longer run of digits; that run is dropped, never sent as a recipient nobody typed.

test('two numbers separated by a space are not sent as one recipient', () => {
  assert.deepEqual(parseBulkRecipients('6281234567890 6289876543210'), []);
});

test('the other lines of the list are still read', () => {
  assert.deepEqual(parseBulkRecipients('6281234567890 6289876543210\n628111222333'), ['628111222333@c.us']);
});

test('fifteen digits is still a recipient and sixteen is not', () => {
  assert.deepEqual(parseBulkRecipients('123456789012345\n1234567890123456'), ['123456789012345@c.us']);
});

test('a formatted single number is still one recipient', () => {
  assert.deepEqual(parseBulkRecipients('+62 812-3456-7890'), ['6281234567890@c.us']);
});

// No phone number starts with 0, so `00` in front of one is the international exit code, as the Number Checker reads it.
test('a 00 exit code is not part of the recipient, and is not counted toward the fifteen digits', () => {
  assert.deepEqual(parseBulkRecipients('0062812345678\n00 123 456 789 012 345'), [
    '62812345678@c.us',
    '123456789012345@c.us',
  ]);
});
