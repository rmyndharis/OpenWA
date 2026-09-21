export type SortDirection = 'asc' | 'desc';

export interface TableSortState {
  columnId: string;
  direction: SortDirection;
}

export function toggleTableSort(current: TableSortState, columnId: string): TableSortState {
  return current.columnId === columnId
    ? { columnId, direction: current.direction === 'asc' ? 'desc' : 'asc' }
    : { columnId, direction: 'asc' };
}

export function compareTableValues(left: unknown, right: unknown, direction: SortDirection): number {
  const factor = direction === 'asc' ? 1 : -1;
  const leftEmpty = left === null || left === undefined || left === '';
  const rightEmpty = right === null || right === undefined || right === '';
  if (leftEmpty || rightEmpty) return (leftEmpty === rightEmpty ? 0 : leftEmpty ? 1 : -1) * factor;
  if (typeof left === 'number' && typeof right === 'number') return (left - right) * factor;
  if (left instanceof Date && right instanceof Date) return (left.getTime() - right.getTime()) * factor;
  return String(left).localeCompare(String(right), 'pt-BR', { numeric: true, sensitivity: 'base' }) * factor;
}
