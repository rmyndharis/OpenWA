import type { TFunction } from 'i18next';

/** How long ago a session was last active: a phrase up to a day, the date after that. */
export function formatLastActive(t: TFunction, date?: string | null, now: number = Date.now()): string {
  if (!date) return t('common.never');
  const diff = now - new Date(date).getTime();
  if (diff < 60_000) return t('common.justNow');
  if (diff < 3_600_000) return t('common.minAgo', { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('common.hoursAgo', { count: Math.floor(diff / 3_600_000) });
  return new Date(date).toLocaleDateString();
}

/** A session status as the operator reads it; a status the catalogue does not know shows as it is. */
export function formatSessionStatus(t: TFunction, status: string): string {
  return t(`sessionStatus.${status}`, { defaultValue: status });
}
