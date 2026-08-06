interface Page<T> {
  data: T[];
  total: number;
}

interface FetchAllPagesOptions {
  pageSize?: number;
  maxItems?: number;
}

/**
 * Walk an offset-paginated list endpoint to completion.
 *
 * Termination is driven by the server's own `total` and by short/empty pages — never by comparing
 * the returned page length against the *requested* size. Endpoints clamp `limit` server-side (audit
 * caps at MAX_AUDIT_PAGE_SIZE), so a `page.length < requested` test reads a clamped first page as
 * "last page" and silently truncates the result.
 */
export async function fetchAllPages<T>(
  fetchPage: (limit: number, offset: number) => Promise<Page<T>>,
  { pageSize = 200, maxItems = 50_000 }: FetchAllPagesOptions = {},
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  for (;;) {
    const { data, total } = await fetchPage(pageSize, offset);
    all.push(...data);
    offset += data.length;
    if (data.length === 0 || offset >= total || all.length >= maxItems) break;
  }
  return all;
}
