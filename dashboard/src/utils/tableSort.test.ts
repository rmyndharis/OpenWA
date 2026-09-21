import assert from 'node:assert/strict';
import test from 'node:test';
import { compareTableValues, toggleTableSort } from './tableSort.ts';

test('toggles the active column and resets a new column to ascending', () => {
  assert.deepEqual(toggleTableSort({ columnId: 'name', direction: 'asc' }, 'name'), {
    columnId: 'name',
    direction: 'desc',
  });
  assert.deepEqual(toggleTableSort({ columnId: 'name', direction: 'desc' }, 'updated'), {
    columnId: 'updated',
    direction: 'asc',
  });
});

test('sorts text naturally, numbers numerically and dates chronologically', () => {
  assert.ok(compareTableValues('Pessoa 2', 'Pessoa 10', 'asc') < 0);
  assert.ok(compareTableValues(20, 3, 'desc') < 0);
  assert.ok(compareTableValues(new Date('2026-09-01'), new Date('2026-09-10'), 'asc') < 0);
  assert.ok(compareTableValues('', 'preenchido', 'asc') > 0);
});
