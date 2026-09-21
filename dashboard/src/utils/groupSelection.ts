export interface SelectableGroup {
  id: string;
  name?: string;
}

export interface GroupPickerRow {
  id: string;
  label: string;
}

export type GroupSendPlan = { mode: 'single'; chatId: string } | { mode: 'sequential'; chatIds: string[] };

const GATEWAY_REFUSAL_STATUSES: readonly number[] = [429, 503];

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

export function isGatewayRefusal(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && GATEWAY_REFUSAL_STATUSES.includes(status);
}
