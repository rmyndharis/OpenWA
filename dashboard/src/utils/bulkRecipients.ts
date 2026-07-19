// The backend caps a bulk batch at 100 messages (ArrayMaxSize on SendBulkMessageDto).
export const BULK_MAX_RECIPIENTS = 100;

/**
 * Parse the bulk-recipients textarea (one entry per line) into chat IDs: trims whitespace,
 * drops blank lines, de-dupes, and normalizes bare phone numbers to `<digits>@c.us`. Lines
 * containing '@' are treated as full chat IDs and pass through untouched; lines with no '@'
 * and no digits at all are dropped rather than sent as the meaningless '@c.us'.
 */
export function parseBulkRecipients(text: string): string[] {
  const seen = new Set<string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.includes('@')) {
      seen.add(line);
      continue;
    }
    const digits = line.replace(/[^0-9]/g, '');
    if (digits) seen.add(`${digits}@c.us`);
  }
  return [...seen];
}
