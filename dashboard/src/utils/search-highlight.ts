const OPEN_MARK = '<mark>';
const CLOSE_MARK = '</mark>';

/**
 * Split a backend search `snippet` (which carries `<mark>...</mark>` highlight markers around matched
 * terms, with the body text NOT HTML-escaped) into segments. A consumer renders each segment as React
 * text (segments marked `true` inside a `<mark>` element, others as text nodes): because React escapes
 * text-node content, the unescaped body becomes inert characters. NEVER use `dangerouslySetInnerHTML`
 * on the raw snippet.
 *
 * Scans balanced `<mark>...</mark>` pairs in linear time so literal `<mark>` or `</mark>` tokens in
 * the message body stay plain text without flipping highlight parity.
 */
export function renderHighlightedSnippet(snippet: string): { text: string; marked: boolean }[] {
  if (!snippet) return [{ text: '', marked: false }];

  const segments: { text: string; marked: boolean }[] = [];
  const pushPlain = (chunk: string) => {
    if (!chunk) return;
    const prev = segments[segments.length - 1];
    if (prev && !prev.marked) prev.text += chunk;
    else segments.push({ text: chunk, marked: false });
  };

  let cursor = 0;
  let nextOpen = snippet.indexOf(OPEN_MARK, 0);
  let nextClose = -1;

  while (cursor < snippet.length) {
    if (nextOpen !== -1 && nextOpen < cursor) {
      nextOpen = snippet.indexOf(OPEN_MARK, cursor);
    }
    if (nextOpen === -1) {
      pushPlain(snippet.slice(cursor));
      break;
    }
    const open = nextOpen;
    const contentStart = open + OPEN_MARK.length;
    if (nextClose < contentStart) {
      nextClose = snippet.indexOf(CLOSE_MARK, contentStart);
    }
    if (nextClose === -1) {
      pushPlain(snippet.slice(cursor));
      break;
    }
    nextOpen = snippet.indexOf(OPEN_MARK, contentStart);
    if (nextOpen !== -1 && nextOpen < nextClose) {
      pushPlain(snippet.slice(cursor, nextOpen));
      cursor = nextOpen;
      continue;
    }
    pushPlain(snippet.slice(cursor, open));
    const markedText = snippet.slice(contentStart, nextClose);
    if (markedText.length > 0) {
      segments.push({ text: markedText, marked: true });
    }
    cursor = nextClose + CLOSE_MARK.length;
  }

  return segments;
}

/** Inclusive epoch-ms bounds for one local calendar day (`YYYY-MM-DD`). */
export function dayBoundsMs(day: string): { dateFrom: number; dateTo: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const [y, m, d] = day.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const end = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { dateFrom: start, dateTo: end };
}

/** Build the SearchParams for a debounced query (trims, drops empty). */
export function buildSearchParams(
  q: string,
  scope?: { sessionId?: string; chatId?: string; dateFrom?: number; dateTo?: number },
  paging?: { limit?: number; offset?: number },
): {
  q: string;
  sessionId?: string;
  chatId?: string;
  dateFrom?: number;
  dateTo?: number;
  limit?: number;
  offset?: number;
} | null {
  const trimmed = q.trim();
  if (!trimmed) return null;
  return {
    q: trimmed,
    sessionId: scope?.sessionId,
    chatId: scope?.chatId,
    dateFrom: scope?.dateFrom,
    dateTo: scope?.dateTo,
    limit: paging?.limit,
    offset: paging?.offset,
  };
}
