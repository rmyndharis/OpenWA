import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkflowSlot } from '../services/api.ts';
import { filterAndSortAgendaSlots, nextAgendaLocationEditorId } from './workflowAgenda.ts';

const slot = (id: string, startsAt: string, location: string): WorkflowSlot => ({
  id,
  startsAt,
  label: null,
  location,
  status: 'DISPONIVEL',
  capacity: 3,
  bookedCount: 0,
});

test('filters agenda slots by location without showing past slots', () => {
  const rows = [
    slot('past', '2026-09-13T12:00:00.000Z', 'Matriz'),
    slot('matriz', '2026-09-16T12:00:00.000Z', 'Matriz'),
    slot('delivery', '2026-09-15T12:00:00.000Z', 'Delivery Floresta'),
  ];

  assert.deepEqual(
    filterAndSortAgendaSlots(rows, {
      includePast: false,
      location: 'Matriz',
      sort: 'date-asc',
      now: Date.parse('2026-09-14T12:00:00.000Z'),
    }).map(item => item.id),
    ['matriz'],
  );
});

test('sorts agenda slots by date and location in both directions', () => {
  const rows = [
    slot('matriz', '2026-09-16T12:00:00.000Z', 'Matriz'),
    slot('delivery', '2026-09-15T12:00:00.000Z', 'Delivery Floresta'),
  ];
  const options = { includePast: true, location: 'all', now: 0 } as const;

  assert.deepEqual(
    filterAndSortAgendaSlots(rows, { ...options, sort: 'date-desc' }).map(item => item.id),
    ['matriz', 'delivery'],
  );
  assert.deepEqual(
    filterAndSortAgendaSlots(rows, { ...options, sort: 'location-asc' }).map(item => item.id),
    ['delivery', 'matriz'],
  );
  assert.deepEqual(
    filterAndSortAgendaSlots(rows, { ...options, sort: 'location-desc' }).map(item => item.id),
    ['matriz', 'delivery'],
  );
});

test('toggles the same location editor closed and switches directly to another location', () => {
  assert.equal(nextAgendaLocationEditorId(false, null, 'matriz'), 'matriz');
  assert.equal(nextAgendaLocationEditorId(true, 'matriz', 'matriz'), null);
  assert.equal(nextAgendaLocationEditorId(true, 'matriz', 'delivery'), 'delivery');
});
