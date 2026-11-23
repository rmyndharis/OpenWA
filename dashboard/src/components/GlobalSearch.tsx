import { useState, useEffect, useCallback, useId, useRef } from 'react';
import { searchApi, type SearchHit } from '../services/api';
import { renderHighlightedSnippet, buildSearchParams } from '../utils/search-highlight';
import { isComposingKey } from '../utils/composition';
import { contactSnippet } from '../utils/vcard';
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
  const listId = useId();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [total, setTotal] = useState(0);
  // Where the next page starts on the server: hits already listed are dropped from a page, so this can
  // run ahead of hits.length, and "more" stays up only while the server has rows past it.
  const [nextOffset, setNextOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  // The loading is for an appended page: the hits already listed stay, and the line goes under them.
  const [paging, setPaging] = useState(false);
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
        setPaging(false);
        return;
      }
      setLoading(true);
      setPaging(append);
      setError(null);
      try {
        const res = await searchApi.search(params);
        if (id !== requestId.current) return;
        if (!append) setActiveIndex(-1);
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
        if (id === requestId.current) {
          setLoading(false);
          setPaging(false);
        }
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
      setActiveIndex(-1);
      setTotal(0);
      setNextOffset(0);
      setError(null);
      setLoading(false);
      setPaging(false);
      return;
    }
    // From the keystroke on, the hits listed and any answer still on its way are for the text before this one: that
    // answer is dropped, the list no longer stands for any text (reopen searches again), and the loading line is
    // alone until the search for this text answers.
    requestId.current += 1;
    searchedKey.current = '';
    setActiveIndex(-1);
    setLoading(true);
    setPaging(false);
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

  const resultsVisible = Boolean(open && q.trim());
  const optionsReady = resultsVisible && (!loading || paging) && hits.length > 0;
  const activeOptionId =
    optionsReady && activeIndex >= 0 && hits[activeIndex] ? `${listId}-option-${activeIndex}` : undefined;

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
        blurTimer.current = setTimeout(() => {
          setOpen(false);
          setActiveIndex(-1);
        }, 150);
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
        setActiveIndex(-1);
      }}
    >
      <input
        ref={inputRef}
        className="global-search-input"
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={resultsVisible}
        aria-controls={resultsVisible ? listId : undefined}
        aria-activedescendant={activeOptionId}
        placeholder={t('search.placeholder')}
        value={q}
        onChange={e => setQ(e.target.value)}
        onKeyDown={e => {
          if (!optionsReady || isComposingKey(e.nativeEvent)) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIndex(prev => (prev + 1 < hits.length ? prev + 1 : 0));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex(prev => (prev > 0 ? prev - 1 : hits.length - 1));
          } else if (e.key === 'Enter' && activeIndex >= 0 && hits[activeIndex]) {
            e.preventDefault();
            const picked = hits[activeIndex];
            setOpen(false);
            setActiveIndex(-1);
            onHit(picked);
          }
        }}
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
      {resultsVisible && (
        <div id={listId} className="global-search-results" role="listbox">
          {loading && !paging && <div className="global-search-state">{t('search.loading')}</div>}
          {!loading && !error && hits.length === 0 && <div className="global-search-state">{t('search.empty')}</div>}
          {(!loading || paging) &&
            hits.map((h, index) => (
              <button
                key={h.messageId}
                id={`${listId}-option-${index}`}
                className="global-search-hit"
                role="option"
                aria-selected={index === activeIndex}
                // preventDefault on mousedown keeps focus in the input, as on "more"; click fires for the
                // mouse and for Enter/Space on a hit reached with Tab. Picking a hit closes the results.
                onMouseDown={e => e.preventDefault()}
                onClick={() => {
                  setOpen(false);
                  setActiveIndex(-1);
                  onHit(h);
                }}
              >
                <div className="global-search-hit-meta">
                  {/* bdi: the id and the time read left to right even inside right-to-left text. */}
                  <bdi>{h.chatId}</bdi> · <bdi>{new Date(h.timestamp * 1000).toLocaleString()}</bdi>
                </div>
                <div className="global-search-hit-snippet">
                  {/* The excerpt of a shared contact is a window of its vCard lines: read it like the chat list row. */}
                  {h.type === 'contact'
                    ? contactSnippet(h.body, t('chats.media.contact'))
                    : renderHighlightedSnippet(h.snippet).map((seg, i) =>
                        seg.marked ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
                      )}
                </div>
              </button>
            ))}
          {/* Under the hits, where a reader at the end of the list is looking: the next page loading, or failing. */}
          {paging && <div className="global-search-state">{t('search.loading')}</div>}
          {!loading && error && <div className="global-search-state">{error}</div>}
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
