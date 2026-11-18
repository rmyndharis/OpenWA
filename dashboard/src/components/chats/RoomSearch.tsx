import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, CalendarSearch, Search, X } from 'lucide-react';
import { searchApi, type SearchHit } from '../../services/api';
import { buildSearchParams, dayBoundsMs, renderHighlightedSnippet } from '../../utils/search-highlight';
import { isComposingKey } from '../../utils/composition';
import { contactSnippet } from '../../utils/vcard';
import './RoomSearch.css';

const DEBOUNCE_MS = 300;
const PAGE_SIZE = 20;

export interface RoomSearchProps {
  sessionId: string;
  chatId: string;
  onClose: () => void;
  onHit: (hit: SearchHit) => void;
  /** Jump to the first loaded message on that local day when the query is empty. */
  onJumpToDate?: (bounds: { dateFrom: number; dateTo: number }) => boolean;
}

/**
 * In-chat search bar (WhatsApp Desktop style): text field plus a calendar day filter, scoped to the
 * open conversation via GET /search `chatId` + optional `dateFrom`/`dateTo`.
 */
export function RoomSearch({ sessionId, chatId, onClose, onHit, onJumpToDate }: RoomSearchProps) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [day, setDay] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dateHint, setDateHint] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestId = useRef(0);
  // Parent may recreate the jump callback each render; keep the latest without re-running the effect.
  const jumpRef = useRef(onJumpToDate);
  jumpRef.current = onJumpToDate;

  const dayFrom = day ? dayBoundsMs(day)?.dateFrom : undefined;
  const dayTo = day ? dayBoundsMs(day)?.dateTo : undefined;

  const run = useCallback(
    async (query: string, offset: number, append: boolean) => {
      const id = ++requestId.current;
      const params = buildSearchParams(
        query,
        {
          sessionId,
          chatId,
          dateFrom: dayFrom,
          dateTo: dayTo,
        },
        { limit: PAGE_SIZE, offset },
      );
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
      setDateHint(null);
      try {
        const res = await searchApi.search(params);
        if (id !== requestId.current) return;
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
        setError(status === 501 ? t('search.unavailable') : t('search.error'));
        if (!append) {
          setHits([]);
          setTotal(0);
          setNextOffset(0);
        }
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [sessionId, chatId, dayFrom, dayTo, t],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const trimmed = q.trim();
    if (!trimmed) {
      requestId.current += 1;
      setHits([]);
      setTotal(0);
      setNextOffset(0);
      setError(null);
      setLoading(false);
      if (dayFrom != null && dayTo != null && jumpRef.current) {
        const found = jumpRef.current({ dateFrom: dayFrom, dateTo: dayTo });
        setDateHint(found ? null : t('chats.roomSearch.noDateHits'));
      } else {
        setDateHint(null);
      }
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = null;
      void run(q, 0, false);
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [q, dayFrom, dayTo, run, t]);

  return (
    <div
      className="room-search"
      onKeyDown={e => {
        if (e.key !== 'Escape' || isComposingKey(e.nativeEvent)) return;
        e.preventDefault();
        onClose();
      }}
    >
      <div className="room-search-top">
        <button type="button" className="room-back" onClick={onClose} aria-label={t('common.back')}>
          <ArrowLeft size={20} />
        </button>
        <span className="room-search-title">{t('chats.roomSearch.title')}</span>
      </div>
      <div className="room-search-fields">
        <button
          type="button"
          className={`room-search-date-btn${day ? ' has-day' : ''}`}
          title={t('chats.roomSearch.date')}
          aria-label={t('chats.roomSearch.date')}
          onClick={() => dateRef.current?.showPicker?.() ?? dateRef.current?.click()}
        >
          <CalendarSearch size={20} />
        </button>
        <input
          ref={dateRef}
          type="date"
          className="room-search-date-input"
          value={day}
          onChange={e => setDay(e.target.value)}
          aria-label={t('chats.roomSearch.date')}
        />
        <div className="room-search-input-wrap">
          <Search size={16} className="room-search-input-icon" aria-hidden />
          <input
            ref={inputRef}
            type="search"
            className="room-search-input"
            placeholder={t('chats.roomSearch.placeholder')}
            value={q}
            onChange={e => setQ(e.target.value)}
            aria-label={t('chats.roomSearch.placeholder')}
          />
          {(q || day) && (
            <button
              type="button"
              className="room-search-clear"
              aria-label={t('chats.clearSearch')}
              onClick={() => {
                setQ('');
                setDay('');
                setDateHint(null);
                inputRef.current?.focus();
              }}
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>
      {(q.trim() || dateHint) && (
        <div className="room-search-results" role="listbox">
          {loading && <div className="room-search-state">{t('search.loading')}</div>}
          {!loading && error && <div className="room-search-state">{error}</div>}
          {!loading && !error && dateHint && !q.trim() && <div className="room-search-state">{dateHint}</div>}
          {!loading && !error && q.trim() && hits.length === 0 && (
            <div className="room-search-state">{t('search.empty')}</div>
          )}
          {!loading &&
            !error &&
            hits.map(h => (
              <button
                key={h.messageId}
                type="button"
                className="room-search-hit"
                role="option"
                onMouseDown={e => e.preventDefault()}
                onClick={() => onHit(h)}
              >
                <div className="room-search-hit-meta">
                  <bdi>{new Date(h.timestamp * 1000).toLocaleString()}</bdi>
                </div>
                <div className="room-search-hit-snippet">
                  {h.type === 'contact'
                    ? contactSnippet(h.body, t('chats.media.contact'))
                    : renderHighlightedSnippet(h.snippet).map((seg, i) =>
                        seg.marked ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
                      )}
                </div>
              </button>
            ))}
          {!loading && nextOffset < total && (
            <button
              type="button"
              className="room-search-more"
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                inputRef.current?.focus();
                void run(q, nextOffset, true);
              }}
            >
              {t('search.loadMore', { shown: hits.length, total })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
