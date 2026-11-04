import { useState, useEffect, useCallback, useRef } from 'react';
import { searchApi, type SearchHit } from '../services/api';
import { renderHighlightedSnippet, buildSearchParams } from '../utils/search-highlight';
import { isComposingKey } from '../utils/composition';
import { useTranslation } from 'react-i18next';
import './GlobalSearch.css';

interface GlobalSearchProps {
  /** Called when the user clicks a result — the parent navigates to that chat/message. */
  onHit: (hit: SearchHit) => void;
  /** When set, offers a toggle that limits the search to this session (off by default). */
  currentSessionId?: string;
}

const DEBOUNCE_MS = 300;
const PAGE_SIZE = 20;

export function GlobalSearch({ onHit, currentSessionId }: GlobalSearchProps) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [total, setTotal] = useState(0);
  // Where the next page starts on the server: hits already listed are dropped from a page, so this can
  // run ahead of hits.length, and "more" stays up only while the server has rows past it.
  const [nextOffset, setNextOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scopeCurrent, setScopeCurrent] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Bumped by every search and by clearing the input: a response whose id is no longer current belongs
  // to a query the user has moved past, and a slower earlier one must not overwrite the latest results.
  const requestId = useRef(0);
  // The query and scope the list was last searched for; Escape can cancel a pending search (a keystroke or
  // a scope toggle), leaving the list behind what the input shows.
  const searchedKey = useRef('');
  const scopeKey = scopeCurrent && currentSessionId ? currentSessionId : '';

  const run = useCallback(
    async (query: string, offset: number, append: boolean) => {
      const id = ++requestId.current;
      searchedKey.current = `${scopeKey}|${query}`;
      const params = buildSearchParams(query, scopeKey ? { sessionId: scopeKey } : undefined, {
        limit: PAGE_SIZE,
        offset,
      });
      if (!params) {
        setHits([]);
        setTotal(0);
        setNextOffset(0);
        setError(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await searchApi.search(params);
        if (id !== requestId.current) return;
        // A message indexed since the last page shifts the offset, so the next page can repeat a hit.
        setHits(prev => {
          if (!append) return res.hits;
          const seen = new Set(prev.map(h => h.messageId));
          return [...prev, ...res.hits.filter(h => !seen.has(h.messageId))];
        });
        setTotal(res.total);
        setNextOffset(offset + res.hits.length);
      } catch (e: unknown) {
        if (id !== requestId.current) return;
        const status = (e as { status?: number }).status;
        if (status === 501) setError(t('search.unavailable'));
        else if (status === 503) setError(t('search.error'));
        else setError(t('search.error'));
        // A failed next page keeps the pages already shown, and "more" stays on as the retry.
        if (!append) {
          setHits([]);
          setTotal(0);
          setNextOffset(0);
        }
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [scopeKey, t],
  );

  // Debounce on input change.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!q.trim()) {
      requestId.current += 1;
      setHits([]);
      setTotal(0);
      setNextOffset(0);
      setError(null);
      setLoading(false);
      return;
    }
    // timer.current is non-null exactly while a search is pending, which the Escape handler reads.
    timer.current = setTimeout(() => {
      timer.current = null;
      setOpen(true);
      void run(q, 0, false);
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [q, run]);

  // Clear any pending blur timeout on unmount so it can't fire setState after teardown.
  useEffect(() => {
    return () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    };
  }, []);

  const reopen = () => {
    if (!q.trim()) return;
    if (searchedKey.current !== `${scopeKey}|${q}`) {
      // Searched now, so the keystroke debounce still pending for the same text would only repeat it.
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      void run(q, 0, false);
    }
    setOpen(true);
  };

  // Focus returns to the input so a keyboard user can keep going (Escape, Tab) once the button is
  // replaced by the loading row, which would otherwise leave focus on nothing.
  const loadMore = () => {
    inputRef.current?.focus();
    void run(q, nextOffset, true);
  };

  return (
    <div
      className="global-search"
      // Focus back inside before the close below runs (a quick Tab out and back) cancels it.
      onFocus={() => {
        if (blurTimer.current) clearTimeout(blurTimer.current);
      }}
      // Close only when focus leaves the whole widget: tabbing from the input to the scope toggle or
      // the "more" button must keep the results open, or the button unmounts before it can be used.
      onBlur={e => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        blurTimer.current = setTimeout(() => setOpen(false), 150);
      }}
      // Escape dismisses the open results from anywhere in the widget (input, scope toggle, a hit,
      // "more") and is consumed, so a page-level Escape handler (the Chats page closes the open
      // conversation) leaves it alone.
      onKeyDown={e => {
        if (e.key !== 'Escape' || isComposingKey(e.nativeEvent)) return;
        // A pending debounce would reopen the results the user just dismissed. Cancelling it is the
        // key's whole effect, so it is consumed too, even before any results have opened.
        const cancelledSearch = timer.current !== null;
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        if (!cancelledSearch && (!open || !q.trim())) return;
        e.preventDefault();
        setOpen(false);
      }}
    >
      <input
        ref={inputRef}
        className="global-search-input"
        type="text"
        placeholder={t('search.placeholder')}
        value={q}
        onChange={e => setQ(e.target.value)}
        onFocus={reopen}
        // A pick or Escape closes the results with focus still in the input, where a click fires no focus.
        onClick={reopen}
        aria-label={t('search.placeholder')}
      />
      {currentSessionId && (
        <label className="global-search-scope">
          <input type="checkbox" checked={scopeCurrent} onChange={e => setScopeCurrent(e.target.checked)} />
          {t('search.scope.current')}
        </label>
      )}
      {open && q.trim() && (
        <div className="global-search-results" role="listbox">
          {loading && <div className="global-search-state">{t('search.loading')}</div>}
          {!loading && error && <div className="global-search-state">{error}</div>}
          {!loading && !error && hits.length === 0 && <div className="global-search-state">{t('search.empty')}</div>}
          {!loading &&
            hits.map(h => (
              <button
                key={h.messageId}
                className="global-search-hit"
                role="option"
                // preventDefault on mousedown keeps focus in the input, as on "more"; click fires for the
                // mouse and for Enter/Space on a hit reached with Tab. Picking a hit closes the results.
                onMouseDown={e => e.preventDefault()}
                onClick={() => {
                  setOpen(false);
                  onHit(h);
                }}
              >
                <div className="global-search-hit-meta">
                  {/* bdi: the id and the time read left to right even inside right-to-left text. */}
                  <bdi>{h.chatId}</bdi> · <bdi>{new Date(h.timestamp * 1000).toLocaleString()}</bdi>
                </div>
                <div className="global-search-hit-snippet">
                  {renderHighlightedSnippet(h.snippet).map((seg, i) =>
                    seg.marked ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
                  )}
                </div>
              </button>
            ))}
          {!loading && nextOffset < total && (
            // preventDefault on mousedown keeps focus in the input, so a mouse click does not start the
            // close timer; click still fires for the mouse and for Enter/Space.
            <button className="global-search-more" onMouseDown={e => e.preventDefault()} onClick={loadMore}>
              {t('search.loadMore', { shown: hits.length, total })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
