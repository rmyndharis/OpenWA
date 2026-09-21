import type { WorkflowSlot } from '../services/api';

export type AgendaSlotSort = 'date-asc' | 'date-desc' | 'location-asc' | 'location-desc';

export function nextAgendaLocationEditorId(
  editorOpen: boolean,
  editingLocationId: string | null,
  clickedLocationId: string,
): string | null {
  return editorOpen && editingLocationId === clickedLocationId ? null : clickedLocationId;
}

export function filterAndSortAgendaSlots(
  slots: WorkflowSlot[],
  options: {
    includePast: boolean;
    location: string;
    sort: AgendaSlotSort;
    now?: number;
  },
): WorkflowSlot[] {
  const now = options.now ?? Date.now();
  return slots
    .filter(slot => options.includePast || Date.parse(slot.startsAt) > now)
    .filter(slot => options.location === 'all' || slot.location?.trim() === options.location)
    .sort((left, right) => {
      if (options.sort === 'date-desc') return Date.parse(right.startsAt) - Date.parse(left.startsAt);
      if (options.sort === 'location-asc' || options.sort === 'location-desc') {
        const locationOrder = (left.location ?? '').localeCompare(right.location ?? '', 'pt-BR');
        if (locationOrder !== 0) return options.sort === 'location-asc' ? locationOrder : -locationOrder;
      }
      return Date.parse(left.startsAt) - Date.parse(right.startsAt);
    });
}
