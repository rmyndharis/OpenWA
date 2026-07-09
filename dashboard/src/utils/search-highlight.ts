/**
 * Split a backend search `snippet` (which carries `<mark>…</mark>` highlight markers around matched
 * terms, with the body text NOT HTML-escaped) into segments. A consumer renders each segment as React
 * text (segments marked `true` inside a `<mark>` element, others as text nodes) — because React escapes
 * text-node content, the unescaped body becomes inert characters. NEVER use `dangerouslySetInnerHTML`
 * on the raw snippet.
 */
export function renderHighlightedSnippet(
  snippet: string,
): { text: string; marked: boolean }[] {
  if (!snippet) return [{ text: '', marked: false }];
  // Split on <mark>/</mark>; odd indices (1, 3, …) were between the tags → highlighted.
  // The marked flag is derived from the pre-filter index, then empty boundary segments
  // (e.g. the leading/trailing '' around a snippet that starts/ends with a marker) are
  // dropped — without this, '<mark>x</mark>' would yield ['', 'x', ''] (length 3).
  return snippet
    .split(/<\/?mark>/)
    .map((text, i) => ({ text, marked: i % 2 === 1 }))
    .filter((seg) => seg.text.length > 0);
}

/** Build the SearchParams for a debounced query (trims, drops empty). */
export function buildSearchParams(
  q: string,
  scope?: { sessionId?: string; chatId?: string },
  paging?: { limit?: number; offset?: number },
): { q: string; sessionId?: string; chatId?: string; limit?: number; offset?: number } | null {
  const trimmed = q.trim();
  if (!trimmed) return null;
  return {
    q: trimmed,
    sessionId: scope?.sessionId,
    chatId: scope?.chatId,
    limit: paging?.limit,
    offset: paging?.offset,
  };
}
