export interface SelectableGroup {
  id: string;
  name?: string;
}

export interface GroupPickerRow {
  id: string;
  label: string;
}

export type GroupSendPlan = { mode: 'single'; chatId: string } | { mode: 'sequential'; chatIds: string[] };

// Answers the next call of the same run gets too: 409 an engine that is not ready, which fails every group alike,
// 429 the rate limit, 502 a reverse proxy that cannot reach the gateway, 503 WhatsApp not answering. A 504 is left out:
// the proxy reached the gateway and stopped waiting, so that request may still be running. A 400 is not listed because
// the gateway also answers it for one chat alone (a send a plugin vetoed); it counts only when it says the session is
// not running, see SESSION_NOT_RUNNING.
const GATEWAY_REFUSAL_STATUSES: readonly number[] = [409, 429, 502, 503];

// How the gateway words a 400 for a session with no engine: "Session '<id>' is not active. Start the session first."
// on the send routes, "Session is not started" on the contact and group routes.
const SESSION_NOT_RUNNING = /\bsession\b.*\bnot (active|started)\b/i;

export function groupLabel(group: SelectableGroup): string {
  return group.name?.trim() || group.id;
}

export function groupPickerRows(groups: readonly SelectableGroup[], selectedIds: readonly string[]): GroupPickerRow[] {
  const listed = new Set(groups.map(group => group.id));
  const unlisted = [...new Set(selectedIds)].filter(id => !listed.has(id));
  return [
    ...groups.map(group => ({ id: group.id, label: groupLabel(group) })),
    ...unlisted.map(id => ({ id, label: id })),
  ];
}

export function filterGroupRows(rows: readonly GroupPickerRow[], query: string): GroupPickerRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...rows];
  return rows.filter(row => row.label.toLocaleLowerCase().includes(needle));
}

export function toggleGroupId(selectedIds: readonly string[], id: string): string[] {
  return selectedIds.includes(id) ? selectedIds.filter(current => current !== id) : [...selectedIds, id];
}

export function addGroupIds(selectedIds: readonly string[], ids: readonly string[], limit: number): string[] {
  const next = [...selectedIds];
  for (const id of ids) {
    if (next.length >= limit) break;
    if (!next.includes(id)) next.push(id);
  }
  return next;
}

export function planGroupSend(selectedIds: readonly string[], messageType: string): GroupSendPlan | null {
  const [first] = selectedIds;
  if (first === undefined) return null;
  if (selectedIds.length === 1 || messageType === 'forward') return { mode: 'single', chatId: first };
  return { mode: 'sequential', chatIds: [...selectedIds] };
}

// A failure the rest of a run would meet too, so the run stops instead of recording one failure per remaining target:
// one of the statuses above, a 400 that says the session is not running, or a fetch that got no answer at all (it
// rejects with a TypeError). An error the page raised itself, or an answer it could not read, fails that call only.
export function isGatewayRefusal(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  const { status, message } = (err ?? {}) as { status?: unknown; message?: unknown };
  if (status === 400) return typeof message === 'string' && SESSION_NOT_RUNNING.test(message);
  return typeof status === 'number' && GATEWAY_REFUSAL_STATUSES.includes(status);
}
