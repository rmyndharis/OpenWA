import assert from 'node:assert/strict';
import test from 'node:test';
import { detectHumanTicketChanges, snapshotHumanTickets } from './humanTicketNotifications.ts';

test('detects new calls, activity and status changes with stable dedupe keys', () => {
  const previous = snapshotHumanTickets([
    { id: 'same', status: 'EM_ATENDIMENTO_HUMANO', lastRelevantAt: '2026-09-16T10:00:00.000Z' },
    { id: 'closed', status: 'EM_ATENDIMENTO_HUMANO', lastRelevantAt: '2026-09-16T10:00:00.000Z' },
  ]);
  const changes = detectHumanTicketChanges(previous, [
    { id: 'new', status: 'AGUARDANDO_ATENDIMENTO', lastRelevantAt: '2026-09-16T10:03:00.000Z' },
    { id: 'same', status: 'EM_ATENDIMENTO_HUMANO', lastRelevantAt: '2026-09-16T10:02:00.000Z' },
    { id: 'closed', status: 'CHAMADO_ENCERRADO', lastRelevantAt: '2026-09-16T10:01:00.000Z' },
  ]);

  assert.deepEqual(
    changes.map(change => [change.ticketId, change.kind]),
    [
      ['new', 'new'],
      ['same', 'activity'],
      ['closed', 'status'],
    ],
  );
  assert.equal(new Set(changes.map(change => change.key)).size, changes.length);
});

test('does not notify for unchanged or already closed tickets discovered on refresh', () => {
  const unchanged = { id: 'same', status: 'EM_ATENDIMENTO_HUMANO', lastRelevantAt: '2026-09-16T10:00:00.000Z' };
  assert.deepEqual(detectHumanTicketChanges(snapshotHumanTickets([unchanged]), [unchanged]), []);
  assert.deepEqual(
    detectHumanTicketChanges(new Map(), [
      { id: 'old', status: 'CHAMADO_ENCERRADO', lastRelevantAt: '2026-09-16T09:00:00.000Z' },
    ]),
    [],
  );
});
