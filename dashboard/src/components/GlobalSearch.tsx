import { useState, useEffect, useCallback, useRef } from 'react';
import { searchApi, type SearchHit } from '../services/api';
import { renderHighlightedSnippet, buildSearchParams } from '../utils/search-highlight';
import { useTranslation } from 'react-i18next';
import './GlobalSearch.css';

interface GlobalSearchProps {
  /** Called when the user clicks a result — the parent navigates to that chat/message. */
  onHit: (hit: SearchHit) => void;
  /** When set, the scope toggle defaults to this session (optional). */
  currentSessionId?: string;
}

const DEBOUNCE_MS = 300;
const PAGE_SIZE = 20;

export function GlobalSearch({ onHit, currentSessionId }: GlobalSearchProps) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scopeCurrent, setScopeCurrent] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(async (query: string, offset: number, append: boolean) => {
    const params = buildSearchParams(query, scopeCurrent && currentSessionId ? { sessionId: currentSessionId } : undefined, { limit: PAGE_SIZE, offset });
    if (!params) { setHits([]); setTotal(0); setError(null); setLoading(false); return; }
    setLoading(true); setError(null);
    try {
      const res = await searchApi.search(params);
      setHits(prev => append ? [...prev, ...res.hits] : res.hits);
      setTotal(res.total);
    } catch (e: unknown) {
      const status = (e as { status?: number }).status;
      if (status === 501) setError(t('search.unavailable'));
      else if (status === 503) setError(t('search.error'));
      else setError(t('search.error'));
      setHits([]); setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [scopeCurrent, currentSessionId, t]);

  // Debounce on input change.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!q.trim()) { setHits([]); setTotal(0); setError(null); return; }
    timer.current = setTimeout(() => { setOpen(true); void run(q, 0, false); }, DEBOUNCE_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q, run]);

  // Clear any pending blur timeout on unmount so it can't fire setState after teardown.
  useEffect(() => {
    return () => { if (blurTimer.current) clearTimeout(blurTimer.current); };
  }, []);

  const loadMore = () => void run(q, hits.length, true);

  return (
    <div className="global-search">
      <input
        className="global-search-input"
        type="text"
        placeholder={t('search.placeholder')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => q.trim() && setOpen(true)}
        onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 150); }}
        aria-label={t('search.placeholder')}
      />
      {currentSessionId && (
        <label className="global-search-scope">
          <input type="checkbox" checked={scopeCurrent} onChange={(e) => setScopeCurrent(e.target.checked)} />
          {t('search.scope.current')}
        </label>
      )}
      {open && q.trim() && (
        <div className="global-search-results" role="listbox">
          {loading && <div className="global-search-state">{t('search.loading')}</div>}
          {!loading && error && <div className="global-search-state">{error}</div>}
          {!loading && !error && hits.length === 0 && <div className="global-search-state">{t('search.empty')}</div>}
          {!loading && !error && hits.map((h) => (
            <button key={h.messageId} className="global-search-hit" role="option" onMouseDown={() => onHit(h)}>
              <div className="global-search-hit-meta">{h.chatId} · {new Date(h.timestamp * 1000).toLocaleString()}</div>
              <div className="global-search-hit-snippet">
                {renderHighlightedSnippet(h.snippet).map((seg, i) => seg.marked ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>)}
              </div>
            </button>
          ))}
          {!loading && !error && hits.length < total && (
            <button className="global-search-more" onClick={loadMore}>{t('search.results', { count: total })}</button>
          )}
        </div>
      )}
    </div>
  );
}
