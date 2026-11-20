import type { WebhookFilters } from '../services/api';

// Mirror the backend limits (src/modules/webhook/filters/filter-types.ts). The gateway rejects filters
// past them, and a production build answers with a bare "Bad Request" that names no condition.
export const MAX_FILTER_CONDITIONS = 20;
export const MAX_FILTER_VALUES = 100;
export const MAX_FILTER_TEXT_LENGTH = 1000;
export const MAX_FILTER_ID_LENGTH = 128;

/**
 * True when the gateway would reject these filters: a list condition with no values, or a limit exceeded. A chat id
 * entry past MAX_FILTER_ID_LENGTH counts, so a webhook stored with one cannot be saved until the entry is removed.
 */
export function filtersIncomplete(filters: WebhookFilters | null | undefined): boolean {
  const conditions = filters?.conditions ?? [];
  return (
    conditions.length > MAX_FILTER_CONDITIONS ||
    conditions.some(({ value }) =>
      Array.isArray(value)
        ? value.length === 0 ||
          value.length > MAX_FILTER_VALUES ||
          value.some(entry => typeof entry === 'string' && entry.length > MAX_FILTER_ID_LENGTH)
        : typeof value === 'string' && value.length > MAX_FILTER_TEXT_LENGTH,
    )
  );
}
