# Dashboard `/chats` UX Improvements — Design Spec

**Date**: 2026-06-26
**Repo**: `OpenWA` (fork: `softronicve/OpenWA`, upstream: `rmyndharis/OpenWA`)
**Branch target**: feature branch on fork → PR to upstream `main`
**Affected page**: `dashboard/src/pages/Chats.tsx`

---

## Goal

Polish three rough edges on the dashboard's `/chats` page:

1. **Link detection** — message bodies render as plain text. URLs are not clickable, even canonical `https://…` ones. Bare domains (e.g. `github.com/affaan-m/ecc`) are obviously not detected either. Also: WhatsApp text formatting (`*bold*`, `_italic_`, `~strike~`, inline/block code) is not parsed.
2. **Photo viewer** — clicking an image in a message does nothing. Users have no way to view media at full size, zoom in, navigate between photos, or download.
3. **Chat state cache + scroll behavior** — switching back to a previously-opened chat refetches all messages from the server and re-runs a smooth scroll animation to the bottom. The user sees a loading flash, then a visible scroll jump. They expect: revisit a chat → it's already there, at the position they left it.

---

## Non-goals (deferred / YAGNI)

- Email / phone-number / mention / hashtag auto-linking (only URLs in this PR).
- "↓ N new messages" badge when scrolled up. The hook leaves an API hook for it.
- WebSocket reconnect cache invalidation (separate concern in WS layer).
- Video preview in lightbox (only `type === 'image'`).
- Sidebar / composer / header refactors.
- Rendering improvements outside `Chats.tsx` page.

---

## Architecture

### New files (`dashboard/src/`)

| Path | Purpose |
|---|---|
| `hooks/useChatMessages.ts` | React Query wrapper for per-chat message cache + mutation helpers (`appendMessage`, `replaceTempMessage`, `updateMessage`, `removeMessage`) used by realtime/send/ack flows. |
| `hooks/useChatScrollPosition.ts` | Per-chat `scrollTop` save/restore via `useRef<Map<chatId, number>>`. Decides auto-scroll vs preserve on append. |
| `components/chats/MessageBody.tsx` | Renders a message body as React nodes with WhatsApp text formatting + clickable links (linkifyjs/linkify-react). |
| `components/chats/MediaLightbox.tsx` | Thin wrapper around `yet-another-react-lightbox` with our `LightboxItem[]` shape + plugin set. |

### Modified files

- `dashboard/src/pages/Chats.tsx` — replace `useState<messages>` + `loadMessages` with `useChatMessages`; replace inline `<div className="message-text">{msg.body}</div>` with `<MessageBody>`; add `<MediaLightbox>` and `onClick` on `<img>`; replace `chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' })` with `useChatScrollPosition`.
- `dashboard/package.json` — add deps: `linkifyjs`, `linkify-react`, `yet-another-react-lightbox`. Combined ~25 KB gzip.
- `dashboard/src/pages/Chats.css` (the project's global stylesheet) — append small overrides on top of yarl's default theme to match dashboard dark theme, plus `.message-image { cursor: zoom-in; }`. If `.message-text` doesn't already set `white-space: pre-wrap`, add it there so newlines render.

---

## Section 1 — Message cache (React Query)

### Hook

```ts
// hooks/useChatMessages.ts
const messagesKey = (sessionId: string, chatId: string) =>
  ['messages', sessionId, chatId] as const;

export function useChatMessages(sessionId: string, chatId: string | null) {
  return useQuery({
    queryKey: messagesKey(sessionId, chatId ?? ''),
    queryFn: () => fetchMessages(sessionId, chatId!),  // same db+history merge used today
    enabled: !!sessionId && !!chatId,
    staleTime: Infinity,        // never auto-refetch; WS keeps it fresh
    gcTime: 30 * 60 * 1000,     // drop from cache after 30min unused
  });
}

export function useChatMessagesActions() {
  const qc = useQueryClient();
  return {
    appendMessage: (sId: string, cId: string, msg: ChatMessageView) =>
      qc.setQueryData(messagesKey(sId, cId), (old: ChatMessageView[] = []) =>
        mergeOrAppend(old, msg)),  // mergeOrAppend = same dedupe-by-id semantics used today by the WS handler in Chats.tsx:224 (replace if id exists, append if new). Extract to dashboard/src/utils/chatMessages.ts (file exists; add the helper there).
    replaceTempMessage: (sId: string, cId: string, tempId: string, real: ChatMessageView) =>
      qc.setQueryData(messagesKey(sId, cId), (old: ChatMessageView[] = []) =>
        old.map(m => m.id === tempId ? real : m)),
    updateMessage: (sId: string, cId: string, id: string, patch: Partial<ChatMessageView>) =>
      qc.setQueryData(messagesKey(sId, cId), (old: ChatMessageView[] = []) =>
        old.map(m => m.id === id ? { ...m, ...patch } : m)),
    removeMessage: (sId: string, cId: string, id: string) =>
      qc.setQueryData(messagesKey(sId, cId), (old: ChatMessageView[] = []) =>
        old.filter(m => m.id !== id)),
  };
}
```

### Data flow changes in `Chats.tsx`

| Today | Tomorrow |
|---|---|
| `const [messages, setMessages] = useState<ChatMessageView[]>([])` | `const { data: messages = [], isLoading } = useChatMessages(selectedSessionId, activeChat?.id ?? null)` |
| `useEffect [activeChat] → loadMessages(activeChat.id)` | Removed — `useQuery` handles it; revisit cached chat returns data instantly. |
| `setMessages(prev => [...prev, newMsg])` (WS subscribe) | `appendMessage(newMsg.sessionId, newMsg.chatId, newMsg)` |
| `setMessages(prev => [...prev, temp])` (optimistic send) | `appendMessage(selectedSessionId, activeChat.id, temp)` |
| `setMessages(prev => prev.map(m => m.id === tempId ? real : m))` | `replaceTempMessage(...)` |
| `setMessages(prev => prev.map(m => m.id === id ? {...m, status: 'failed'} : m))` (ack/error) | `updateMessage(sId, cId, id, { status: 'failed' })` |

### Key behavioural consequence

When chat X receives a message via WS while user is looking at chat Y, the cache for X is updated even though X is off-screen. Clicking X next time renders the new message immediately — no spinner, no fetch.

---

## Section 2 — Scroll behavior

### Hook

```ts
// hooks/useChatScrollPosition.ts
export function useChatScrollPosition(activeChatId: string | null) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollMap = useRef<Map<string, number>>(new Map());
  const prevChatIdRef = useRef<string | null>(null);

  // Save scrollTop of the chat we're leaving (before activeChatId changes propagates).
  // Restore scrollTop of the chat we're entering, before paint.
  useLayoutEffect(() => {
    const prev = prevChatIdRef.current;
    const next = activeChatId;
    const el = containerRef.current;

    if (prev && el) scrollMap.current.set(prev, el.scrollTop);
    if (next && el) {
      const saved = scrollMap.current.get(next);
      el.scrollTop = saved !== undefined ? saved : el.scrollHeight;
    }
    prevChatIdRef.current = next;
  }, [activeChatId]);

  const onMessageAppended = useCallback((direction: 'incoming' | 'outgoing') => {
    const el = containerRef.current;
    if (!el) return;
    // Snapshot BEFORE the React Query update commits and re-renders the list.
    // scrollHeight here reflects the OLD content; scrollTop is current.
    const wasNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    // Defer to next frame so React has committed the new message into the DOM
    // (scrollHeight grows). Then scroll to the new bottom.
    requestAnimationFrame(() => {
      const cur = containerRef.current;
      if (!cur) return;
      if (direction === 'outgoing' || wasNearBottom) {
        cur.scrollTop = cur.scrollHeight;
      }
      // else: preserve current scrollTop (user is reading old messages)
    });
  }, []);

  return { containerRef, onMessageAppended };
}
```

### Rules summary

| Event | Behavior |
|---|---|
| First-ever entry to a chat | `scrollTop = scrollHeight` (jump to bottom, no animation) |
| Revisit cached chat | Restore saved `scrollTop` (no animation, no flicker — `useLayoutEffect`) |
| Incoming msg (other user), user near bottom (≤100px) | Auto-scroll to bottom |
| Incoming msg (other user), user scrolled up (>100px) | Preserve scrollTop |
| Outgoing msg (user sent) | Always scroll to bottom |
| ACK update (sending → sent/delivered/read) | No scroll change |
| Window resize / virtual keyboard | If user was at bottom, stay at bottom. Otherwise preserve `scrollTop` (handled by container `overflow-anchor` CSS + browser default). |

### Integration

```tsx
const { containerRef, onMessageAppended } = useChatScrollPosition(activeChat?.id ?? null);

// in WS subscribe:
appendMessage(sId, cId, newMsg);
if (activeChat?.id === newMsg.chatId) onMessageAppended('incoming');

// in optimistic send:
appendMessage(sId, cId, tempMessage);
onMessageAppended('outgoing');

// in render:
<div ref={containerRef} className="messages-list">…</div>
```

### Why `useLayoutEffect` + `useRef<Map>`

- `useLayoutEffect` runs synchronously after DOM mutations but before the browser paints — eliminates the visible "jump" the user complained about.
- `useRef<Map>` doesn't trigger re-renders when we save scroll positions. Map identity persists across renders. Cleanup happens automatically when `Chats.tsx` unmounts.

---

## Section 3 — Message body rendering (`MessageBody`)

### Component API

```tsx
interface MessageBodyProps {
  text: string;
  className?: string;
  enableLinks?: boolean;  // default true
}
```

### Pipeline (single pass)

1. **Extract code segments** (`` ```block``` `` and `` `inline` ``). Replace with opaque placeholders, store originals in a side array. Code content is NEVER processed for formatting or linkified.
2. **Parse formatting markers** in the remaining text using a small recursive descent: `*…*` → `<strong>`, `_…_` → `<em>`, `~…~` → `<s>`. Nesting allowed (`*_a_*` → `<strong><em>a</em></strong>`).
3. **Linkify text leaves** with `<Linkify>` from `linkify-react`: bare domains, URLs with/without protocol, with proper trailing-punctuation handling.

### WhatsApp formatting rules (matching the official client's behavior)

- ` ```block``` ` → `<pre><code>` (multi-line; no formatting or linkify inside)
- `` `inline` `` → `<code>` (no formatting or linkify inside)
- `*bold*` — must have non-whitespace immediately inside the markers; boundary outside (start/end of string, whitespace, or punctuation)
- `_italic_` — same rules
- `~strike~` — same rules
- Markers nested allowed; same marker can't open inside itself
- Newlines preserved via `white-space: pre-wrap` on `.message-text` and `.quote-body`. Implementer adds the rule if not already present.

### Linkify config

```ts
import Linkify from 'linkify-react';

const linkifyOptions = {
  target: '_blank',
  rel: 'noopener noreferrer',
  defaultProtocol: 'https',  // bare `github.com/x` → `https://github.com/x`
  attributes: {
    onClick: (e: MouseEvent) => e.stopPropagation(),  // don't trigger message row handlers
  },
};
```

### Security

- No `dangerouslySetInnerHTML`. Output is React nodes.
- `linkify-react` rejects `javascript:` URIs by default.
- `<a target="_blank" rel="noopener noreferrer">` always.
- Input text is rendered as React text nodes → React escapes automatically (no `<script>` injection).

### Reemplazos in `Chats.tsx`

```diff
- <div className="message-text">{msg.body}</div>
+ <MessageBody text={msg.body} className="message-text" />

- <div className="quote-body">{msg.metadata.quotedMessage.body}</div>
+ <MessageBody text={msg.metadata.quotedMessage.body} className="quote-body" />
```

---

## Section 4 — Media lightbox (`MediaLightbox`)

### Why `yet-another-react-lightbox` (yarl)

User scope includes pinch-to-zoom, wheel zoom, pan, swipe carousel, and download. Hand-rolling these is ~400 lines of device-touchy gesture code. yarl is ~14 KB gzip core + ~3 KB per plugin, MIT, actively maintained, React 19 compatible, plugin-architected.

### Component (thin wrapper, ~40 lines)

```tsx
import Lightbox from 'yet-another-react-lightbox';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import Download from 'yet-another-react-lightbox/plugins/download';
import Counter from 'yet-another-react-lightbox/plugins/counter';
import Captions from 'yet-another-react-lightbox/plugins/captions';
import 'yet-another-react-lightbox/styles.css';
import 'yet-another-react-lightbox/plugins/counter.css';
import 'yet-another-react-lightbox/plugins/captions.css';

export interface LightboxItem {
  id: string;
  url: string;
  alt?: string;
  senderName?: string;
  timestamp?: string;
}

interface Props {
  items: LightboxItem[];
  index: number | null;
  onClose: () => void;
  onNavigate: (next: number) => void;
}

export default function MediaLightbox({ items, index, onClose, onNavigate }: Props) {
  if (index === null || items.length === 0) return null;

  return (
    <Lightbox
      open={true}
      close={onClose}
      index={index}
      on={{ view: ({ index: i }) => onNavigate(i) }}
      slides={items.map(m => ({
        src: m.url,
        alt: m.alt ?? '',
        title: m.senderName,
        description: m.timestamp,
        download: { url: m.url, filename: m.alt ?? `image-${m.id}.jpg` },
      }))}
      plugins={[Zoom, Download, Counter, Captions]}
      zoom={{
        maxZoomPixelRatio: 3,
        wheelZoomDistanceFactor: 100,
        pinchZoomDistanceFactor: 100,
        scrollToZoom: true,
      }}
      carousel={{ finite: true, preload: 2 }}
      controller={{ closeOnBackdropClick: true }}
    />
  );
}
```

### Page-level state in `Chats.tsx`

```ts
const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

const imageMedia = useMemo<LightboxItem[]>(() =>
  messages
    .filter(m => m.type === 'image' && m.media?.url)
    .map(m => ({
      id: m.id,
      url: m.media!.url,
      alt: m.body,
      senderName: m.senderName,
      timestamp: m.timestamp,
    })),
  [messages]);
```

### Click handler (line 790 today)

```tsx
<img
  src={…}
  alt={…}
  className="message-image"
  style={{ cursor: 'zoom-in' }}
  onClick={() => setLightboxIndex(imageMedia.findIndex(x => x.id === msg.id))}
/>
```

### Render (at the bottom of `Chats.tsx`)

```tsx
<MediaLightbox
  items={imageMedia}
  index={lightboxIndex}
  onClose={() => setLightboxIndex(null)}
  onNavigate={setLightboxIndex}
/>
```

### CSS overrides

Appended to `dashboard/src/pages/Chats.css` — small overrides matching the dashboard's dark palette. yarl uses CSS variables (e.g. `--yarl__color_backdrop`, `--yarl__color_button`) which we override in one block.

### Out of scope (future PRs if requested)

- Videos in lightbox
- Slideshow auto-play, thumbnails strip
- Sharing / forwarding from the lightbox

---

## Error handling

- `useChatMessages` query failure → React Query's `error` state; reuse existing `showErrorToast(t('chats.errors.loadMessages'), err.message)` path.
- `useChatMessages` queryFn throws on network error → query state `error`; UI shows the error toast as today; no cache pollution (failed fetch doesn't write `setQueryData`).
- `appendMessage`/`updateMessage`/`removeMessage` are no-ops if the cache key has no entry yet (defensive default `(old = [])`).
- `MessageBody` malformed input (unbalanced `*`, etc.) → renders raw characters as text. No crash, no DOM-mutation surprise.
- `MediaLightbox` items array empty or `index >= items.length` → returns null.
- yarl image load failure → its built-in error state shows a broken-image placeholder. No additional handling needed.

---

## Testing

### Hook tests (Vitest + RTL `renderHook`)

`hooks/useChatMessages.test.ts`:
- Revisit (second `renderHook` with same key) reuses cache (`queryFn` not called twice).
- `appendMessage` adds to the right cache key, doesn't reset others.
- `replaceTempMessage` swaps by id; if id missing, no-op.
- `updateMessage` with non-existent id is no-op (no crash).
- `removeMessage` filters by id.

`hooks/useChatScrollPosition.test.ts`:
- Switch A → B → A restores A's `scrollTop`.
- First entry scrolls to `scrollHeight` (bottom, no animation).
- Append incoming with `scrollTop` near bottom (<100px gap) → scrolls to bottom.
- Append incoming with `scrollTop` far from bottom (>100px gap) → preserves position.
- Append outgoing always scrolls to bottom.
- jsdom has writeable `scrollTop`/`scrollHeight` — already used by the project.

### Component tests (Vitest + RTL)

`components/chats/MessageBody.test.tsx`:
- Plain text renders unchanged.
- `*bold*` → `<strong>` with the inner text.
- `_italic_` → `<em>`.
- `~strike~` → `<s>`.
- `` `inline` `` → `<code>`, no formatting or linkify inside it.
- ` ```block``` ` → `<pre><code>`, whitespace preserved.
- Nested: `*_a_*` → `<strong><em>a</em></strong>`.
- Edge case: `* not bold *` (whitespace inside markers) → literal text.
- Bare URL: `mira github.com/x funciona` → one `<a href="https://github.com/x">`, no trailing `funciona`.
- URL in code: `` `ver https://x.com` `` → literal, no `<a>`.
- Format + URL: `*ver github.com/x*` → `<strong><a>github.com/x</a></strong>`.
- XSS attempt: `<script>alert(1)</script>` → text content, no script execution (assert via DOM check).

`components/chats/MediaLightbox.test.tsx`:
- `index === null` → no `dialog` role in DOM.
- `index >= 0` with items → yarl renders; assert image `src`.
- `onClose` callback fires when yarl's `close` is invoked (mock interaction via `userEvent` on the close button).
- `onNavigate` callback fires with new index when navigating.
- Empty items array → returns null.

### Integration smoke (`Chats.test.tsx` — if/where existing test scaffolding allows)

- Click a chat → messages render.
- Click a different chat → messages render.
- Click the first chat again → messages render WITHOUT a second `queryFn` invocation (assert via mock).
- WS push for the active chat appends a message at bottom; user near bottom → scroll follows. User scrolled up → scroll stays.
- Click a `.message-image` → lightbox opens at correct index.

---

## Migration / rollout

- Single PR against `rmyndharis/OpenWA` `main` from a feature branch on `softronicve/OpenWA`.
- No DB migration, no env vars, no API changes — pure dashboard front-end change.
- Backward-compatible with existing message payloads.

---

## Open questions

None — all design decisions resolved in brainstorm.

## Future work (deferred)

- "↓ N new messages" badge when user is scrolled up and new messages arrive.
- Email/phone/mention auto-linking in `MessageBody`.
- Video preview in lightbox.
- WS reconnect → React Query cache invalidation strategy.
