import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Search, X } from 'lucide-react';
import { searchApi, type SearchHit } from '../../services/api';
import { buildSearchParams, dayBoundsMs, renderHighlightedSnippet } from '../../utils/search-highlight';
import { isComposingKey } from '../../utils/composition';
import { contactSnippet } from '../../utils/vcard';
import './RoomSearch.css';

const DEBOUNCE_MS = 300;
const PAGE_SIZE = 20;

/** What the thread did with a day: scrolled to it, has not loaded that far back yet, or holds no message of it. */
export type DayJump = 'shown' | 'older' | 'none';

export interface RoomSearchProps {
  sessionId: string;
  chatId: string;
  onClose: () => void;
  /** Scrolls the thread to the hit. False when its message is not among the ones the thread has loaded. */
  onHit: (hit: SearchHit) => boolean;
  /** Scrolls the thread to the first message of that local day. Asked only while the text is empty. */
  onJumpToDate?: (bounds: { dateFrom: number; dateTo: number }) => DayJump;
}

/**
 * In-chat search bar (WhatsApp Desktop style): text field plus a calendar day filter, scoped to the
 * open conversation via GET /search `chatId` + optional `dateFrom`/`dateTo`.
 */
export function RoomSearch({ sessionId, chatId, onClose, onHit, onJumpToDate }: RoomSearchProps) {
  const { t } = useTranslation();
  const listId = useId();
  const [q, setQ] = useState('');
  const [day, setDay] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  // The loading is for an appended page: the hits already listed stay, and the line goes under them.
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Why the thread did not move for the hit or the day just picked. Shown under the list, which stays.
  const [notice, setNotice] = useState<string | null>(null);
  // The list folds once the thread has scrolled to a picked hit, which it would cover. The text and the hits are kept,
  // and the field brings the list back.
  const [open, setOpen] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestId = useRef(0);

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
    [sessionId, chatId, dayFrom, dayTo, t],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounce on the text, and on the day through `run`. The callbacks the page passes are no part of it: the page
  // makes new ones on every thread update, and a search restarted by each incoming message would never finish.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    // An answer still on its way is for the text before this one.
    requestId.current += 1;
    setActiveIndex(-1);
    if (!q.trim()) {
      setHits([]);
      setTotal(0);
      setNextOffset(0);
      setError(null);
      setLoading(false);
      setPaging(false);
      return;
    }
    // Searching from the keystroke on, so that "no messages" is only ever said of a search that has run.
    setLoading(true);
    setPaging(false);
    timer.current = setTimeout(() => {
      timer.current = null;
      void run(q, 0, false);
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [q, run]);

  useEffect(() => {
    setActiveIndex(-1);
  }, [q, day, run]);

  // The jump is the user's act (a day picked, or the text cleared with a day set), never an effect: an effect runs
  // again whenever the thread changes, and would pull a reader who scrolled away back to the day.
  const jumpToDay = (value: string) => {
    const bounds = dayBoundsMs(value);
    const jump = bounds && onJumpToDate ? onJumpToDate(bounds) : 'shown';
    setNotice(
      jump === 'older' ? t('chats.roomSearch.notLoaded') : jump === 'none' ? t('chats.roomSearch.noDateHits') : null,
    );
  };

  const changeText = (value: string) => {
    setQ(value);
    setOpen(true);
    setActiveIndex(-1);
    if (q.trim() && !value.trim()) jumpToDay(day);
    else setNotice(null);
  };

  const changeDay = (value: string) => {
    setDay(value);
    setOpen(true);
    setActiveIndex(-1);
    // With text the day only narrows the search.
    if (q.trim()) setNotice(null);
    else jumpToDay(value);
  };

  const pick = (hit: SearchHit) => {
    if (!onHit(hit)) {
      setNotice(t('chats.roomSearch.notLoaded'));
      return;
    }
    setNotice(null);
    // A hit picked from the keyboard unmounts with the list, so focus goes to the field. That comes first: reaching
    // the field opens the list, and the fold below is the later update.
    inputRef.current?.focus();
    setOpen(false);
    setActiveIndex(-1);
  };

  const listed = open && q.trim() !== '';
  const optionsReady = listed && (!loading || paging) && hits.length > 0;
  const activeOptionId =
    optionsReady && activeIndex >= 0 && hits[activeIndex] ? `${listId}-option-${activeIndex}` : undefined;

  return (
    <div
      className="room-search"
      onKeyDown={e => {
        // A surface that already took the key (the emoji picker does, in the capture phase) has used it up.
        if (e.key !== 'Escape' || e.defaultPrevented || isComposingKey(e.nativeEvent)) return;
        e.preventDefault();
        onClose();
      }}
    >
      <div className="room-search-top">
        <button type="button" className="icon-btn room-search-close" onClick={onClose} aria-label={t('common.back')}>
          <ArrowLeft size={20} />
        </button>
        <span className="room-search-title">{t('chats.roomSearch.title')}</span>
        <div className="room-search-input-wrap room-search-day">
          <input
            ref={dateRef}
            type="date"
            className="room-search-input"
            value={day}
            onChange={e => changeDay(e.target.value)}
            // Picking the day already set changes nothing, so Enter is what takes the thread back to it.
            onKeyDown={e => {
              if (e.key === 'Enter' && !q.trim()) jumpToDay(day);
            }}
            title={t('chats.roomSearch.date')}
            aria-label={t('chats.roomSearch.date')}
          />
          {day && (
            <button
              type="button"
              className="search-clear"
              title={t('chats.roomSearch.clearDate')}
              aria-label={t('chats.roomSearch.clearDate')}
              onClick={() => {
                changeDay('');
                dateRef.current?.focus();
              }}
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>
      <div className="room-search-fields">
        <div className="room-search-input-wrap">
          <Search size={16} className="room-search-input-icon" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={listed}
            aria-controls={listed ? listId : undefined}
            aria-activedescendant={activeOptionId}
            className="room-search-input"
            placeholder={t('chats.roomSearch.placeholder')}
            value={q}
            onChange={e => changeText(e.target.value)}
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
                pick(hits[activeIndex]);
              }
            }}
            onFocus={() => setOpen(true)}
            // A pick folds the list with focus still in the field, where a click fires no focus.
            onClick={() => setOpen(true)}
            aria-label={t('chats.roomSearch.placeholder')}
          />
          {q && (
            <button
              type="button"
              className="search-clear"
              aria-label={t('chats.clearSearch')}
              onClick={() => {
                changeText('');
                inputRef.current?.focus();
              }}
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>
      {(notice || listed) && (
        <div className="room-search-results">
          {listed && (
            <div id={listId} role="listbox">
              {loading && !paging && <div className="room-search-state">{t('search.loading')}</div>}
              {!loading && !error && hits.length === 0 && <div className="room-search-state">{t('search.empty')}</div>}
              {(!loading || paging) &&
                hits.map((h, index) => (
                  <button
                    key={h.messageId}
                    id={`${listId}-option-${index}`}
                    type="button"
                    className="room-search-hit"
                    role="option"
                    aria-selected={index === activeIndex}
                    onMouseDown={e => e.preventDefault()}
                    onClick={() => pick(h)}
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
              {/* Under the hits, where a reader at the end of the list is looking: the next page loading, or failing. */}
              {paging && <div className="room-search-state">{t('search.loading')}</div>}
              {!loading && error && <div className="room-search-state">{error}</div>}
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
          {/* Under the hits, so that none of them moves from under the pointer when this appears. */}
          {notice && (
            <div className="room-search-notice" role="status">
              {notice}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
