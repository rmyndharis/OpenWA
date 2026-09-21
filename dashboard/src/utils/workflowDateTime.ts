const pad = (value: number) => String(value).padStart(2, '0');

export function toLocalDateTimeValue(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

export function fromLocalDateTimeValue(value: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function isPastCalendarDay(date: Date, now = new Date()): boolean {
  const selectedDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return selectedDay < today;
}

export function isPastHour(hour: number, date: Date, now = new Date()): boolean {
  const endOfHour = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, 59, 59, 999);
  return endOfHour <= now;
}

export function isPastMinute(minute: number, date: Date, now = new Date()): boolean {
  const selectedMinute = new Date(date);
  selectedMinute.setMinutes(minute, 0, 0);
  return selectedMinute <= now;
}
