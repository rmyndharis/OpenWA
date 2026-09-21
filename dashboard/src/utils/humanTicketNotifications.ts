export interface HumanTicketSnapshot {
  id: string;
  status: string;
  lastRelevantAt: string;
}

export type HumanTicketChangeKind = 'new' | 'activity' | 'status';

export interface HumanTicketChange {
  key: string;
  ticketId: string;
  kind: HumanTicketChangeKind;
  status: string;
  occurredAt: string;
}

export function detectHumanTicketChanges(
  previous: ReadonlyMap<string, HumanTicketSnapshot>,
  current: HumanTicketSnapshot[],
): HumanTicketChange[] {
  const changes: HumanTicketChange[] = [];
  for (const ticket of current) {
    const before = previous.get(ticket.id);
    if (!before) {
      if (ticket.status !== 'CHAMADO_ENCERRADO') {
        changes.push({
          key: `${ticket.id}:${ticket.status}:${ticket.lastRelevantAt}`,
          ticketId: ticket.id,
          kind: 'new',
          status: ticket.status,
          occurredAt: ticket.lastRelevantAt,
        });
      }
      continue;
    }
    if (ticket.status !== before.status) {
      changes.push({
        key: `${ticket.id}:${ticket.status}:${ticket.lastRelevantAt}`,
        ticketId: ticket.id,
        kind: 'status',
        status: ticket.status,
        occurredAt: ticket.lastRelevantAt,
      });
      continue;
    }
    if (Date.parse(ticket.lastRelevantAt) > Date.parse(before.lastRelevantAt)) {
      changes.push({
        key: `${ticket.id}:${ticket.status}:${ticket.lastRelevantAt}`,
        ticketId: ticket.id,
        kind: 'activity',
        status: ticket.status,
        occurredAt: ticket.lastRelevantAt,
      });
    }
  }
  return changes;
}

export function snapshotHumanTickets(tickets: HumanTicketSnapshot[]): Map<string, HumanTicketSnapshot> {
  return new Map(tickets.map(ticket => [ticket.id, ticket]));
}
