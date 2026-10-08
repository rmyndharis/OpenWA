interface Page<T> {
  data: T[];
  total: number;
}

interface FetchAllPagesOptions {
  pageSize?: number;
  maxItems?: number;
  /** Wait before the first retry of a throttled (429) page; doubles on each further retry. */
  retryDelayMs?: number;
}

// The gateway throttles each route per IP in three tiers by default: 10 requests a second, 100 a
// minute and 1000 an hour, and a tripped tier refuses the route for its whole window. A walk of
// more than ten pages trips the one-second tier, which a wait of one second, then two, outlasts. A
// 429 still there after both comes from the minute or hour tier, which no wait here outlasts, so the
// walk stops instead of spending more of the budget that tier is refusing. The default `maxItems`
// stops a walk at 50 pages of 200: half the minute's budget stays for the caller's own reads of that
// route, and an hour's budget holds about 20 such walks.
const THROTTLE_RETRIES = 2;

async function retryThrottled<T>(fetchOnce: () => Promise<T>, delayMs: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchOnce();
    } catch (err) {
      if ((err as { status?: number }).status !== 429 || attempt >= THROTTLE_RETRIES) throw err;
      await new Promise(resolve => setTimeout(resolve, delayMs * 2 ** attempt));
    }
  }
}

/**
 * Walk an offset-paginated list endpoint to completion.
 *
 * Termination is driven by the server's own `total` and by short/empty pages — never by comparing
 * the returned page length against the *requested* size. Endpoints clamp `limit` server-side (audit
 * caps at MAX_AUDIT_PAGE_SIZE), so a `page.length < requested` test reads a clamped first page as
 * "last page" and silently truncates the result.
 *
 * `truncated` is set when the `maxItems` safety cap ended the walk while the server still had rows,
 * or when a page stayed throttled after rows were already in hand; `throttled` tells the second apart.
 */
export async function fetchAllPages<T>(
  fetchPage: (limit: number, offset: number) => Promise<Page<T>>,
  { pageSize = 200, maxItems = 10_000, retryDelayMs = 1000 }: FetchAllPagesOptions = {},
): Promise<{ items: T[]; truncated: boolean; throttled: boolean }> {
  const all: T[] = [];
  let offset = 0;
  // Logout cancels nothing in flight. A walk that outlived its key would send the rest of its pages
  // keyless (a 401 that reloads the login form) or as the next sign-in's key, mixing two actors'
  // rows, and a page answered after logout would still finish it. Stop once the key has changed.
  const key = sessionStorage.getItem('openwa_api_key');
  const fetchOnce = async () => {
    if (sessionStorage.getItem('openwa_api_key') !== key) throw new Error('Signed out');
    const page = await fetchPage(pageSize, offset);
    if (sessionStorage.getItem('openwa_api_key') !== key) throw new Error('Signed out');
    return page;
  };
  for (;;) {
    let page: Page<T>;
    try {
      page = await retryThrottled(fetchOnce, retryDelayMs);
    } catch (err) {
      if (all.length > 0 && (err as { status?: number }).status === 429) {
        return { items: all, truncated: true, throttled: true };
      }
      throw err;
    }
    const { data, total } = page;
    all.push(...data);
    offset += data.length;
    if (data.length === 0 || offset >= total) return { items: all, truncated: false, throttled: false };
    if (all.length >= maxItems) return { items: all, truncated: true, throttled: false };
  }
}
