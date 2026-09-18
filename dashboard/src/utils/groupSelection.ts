export interface SelectableGroup {
  id: string;
  name: string;
}

export function groupLabel(group: SelectableGroup): string {
  return group.name.trim() || group.id;
}

export function filterGroupsByName<T extends SelectableGroup>(groups: readonly T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...groups];
  return groups.filter(group => groupLabel(group).toLocaleLowerCase().includes(needle));
}

export function toggleGroupId(selectedIds: readonly string[], id: string): string[] {
  return selectedIds.includes(id) ? selectedIds.filter(current => current !== id) : [...selectedIds, id];
}

export function addGroupIds(selectedIds: readonly string[], ids: readonly string[]): string[] {
  return [...new Set([...selectedIds, ...ids])];
}
