# Dashboard `/chats` UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/chats` feel modern — clickable links + WhatsApp formatting in message bodies, full-featured photo lightbox (pinch/wheel zoom, swipe, download), and per-chat state cache that eliminates the reload + scroll-jump when switching back to a chat.

**Architecture:** Wrap message fetching in React Query (per-chat `queryKey`, `staleTime: Infinity`, WebSocket pushes to `setQueryData`). Extract pure logic (formatter parser, scroll decision, message mutation helpers) into `dashboard/src/utils/*.ts` so they're testable with the existing `node:test`-based setup. Thin React glue (hooks, components) wraps the pure functions. Adopt `yet-another-react-lightbox` for the photo viewer because the user-requested features (pinch+wheel zoom, swipe carousel, download) are gesture-heavy and not worth hand-rolling.

**Tech Stack:** React 19 + TypeScript + Vite + `@tanstack/react-query@^5` + `linkifyjs`/`linkify-react` (new) + `yet-another-react-lightbox` (new) + `node:test` (Node built-in) for unit tests.

**Spec:** `docs/superpowers/specs/2026-06-26-dashboard-chats-ux-improvements-design.md`

## Global Constraints

- **Test runner:** Use Node's built-in `node:test` with `import { test } from 'node:test'` and `import assert from 'node:assert/strict'`. Don't add Vitest, Jest, jsdom, or React Testing Library — they aren't in the repo and the maintainer's pattern is "pure logic in utils, thin glue in React, test the utils."
- **Test file location:** `*.test.ts` colocated with source. No `.test.tsx` files (the codebase has none; React glue is tested via build + lint + manual smoke).
- **Test command:** `npm --prefix dashboard run test:unit`
- **Build/typecheck command:** `npm --prefix dashboard run build` (runs `tsc -b && vite build`)
- **Lint command:** `npm --prefix dashboard run lint`
- **Path conventions:** All paths in this plan are relative to repo root unless stated.
- **i18n:** No new i18n keys in this PR. Use `t('chats.errors.loadMessages')` etc. only at sites that already use them.
- **Security:** No `dangerouslySetInnerHTML`. `<a>` tags must carry `target="_blank" rel="noopener noreferrer"`.
- **Branch:** Feature branch on `fork` remote (`softronicve/OpenWA`); PR targets `origin/main` (`rmyndharis/OpenWA`).
- **Commits:** Author `softronicve <desarrollosoftronic@gmail.com>`. NO `Co-Authored-By: Claude` lines. NO `🤖 Generated with Claude Code` lines.

---

### Task 1: Add deps + extract `ChatMessageView` + add mutation helpers in `chatMessages.ts`

**Files:**
- Modify: `dashboard/package.json` (deps section)
- Modify: `dashboard/src/utils/chatMessages.ts` — append helpers and export the `ChatMessageView` type
- Modify: `dashboard/src/pages/Chats.tsx:37-44` — change `interface ChatMessageView extends ChatMessage { ... }` from local declaration to `import { ChatMessageView } from '../utils/chatMessages'`
- Test: `dashboard/src/utils/chatMessages.test.ts` — append tests for the new helpers

**Interfaces:**
- Consumes: existing `ChatMessage` type from `../services/api`, existing `mergeChatMessages` from `chatMessages.ts`.
- Produces:
  - `export interface ChatMessageView extends ChatMessage { /* same shape as current Chats.tsx:37-44 */ }`
  - `export function mergeOrAppend(list: ChatMessageView[], incoming: ChatMessageView): ChatMessageView[]`
  - `export function replaceMessageById(list: ChatMessageView[], oldId: string, replacement: ChatMessageView): ChatMessageView[]`
  - `export function updateMessageById(list: ChatMessageView[], id: string, patch: Partial<ChatMessageView>): ChatMessageView[]`
  - `export function removeMessageById(list: ChatMessageView[], id: string): ChatMessageView[]`

- [ ] **Step 1: Install dependencies**

```bash
cd dashboard
npm install linkifyjs@^4 linkify-react@^4 yet-another-react-lightbox@^3
```

Expected output: 3 packages added, no peer warnings about React 19 (verify with `npm ls react`).

- [ ] **Step 2: Read current `ChatMessageView` definition**

Open `dashboard/src/pages/Chats.tsx` and copy the verbatim block at lines 37-44:

```ts
interface ChatMessageView extends ChatMessage {
  // exact body of the interface here — keep it verbatim
}
```

- [ ] **Step 3: Write failing tests for the four helpers**

Append to `dashboard/src/utils/chatMessages.test.ts`:

```ts
import {
  mergeOrAppend,
  replaceMessageById,
  updateMessageById,
  removeMessageById,
  type ChatMessageView,
} from './chatMessages.ts';

const msg = (over: Partial<ChatMessageView> = {}): ChatMessageView => ({
  id: 'm-1',
  waMessageId: 'true_g@g.us_AAA',
  chatId: 'g@g.us',
  from: 'me',
  to: 'g@g.us',
  body: 'hello',
  type: 'text',
  direction: 'outgoing',
  status: 'sent',
  timestamp: 1782053999,
  createdAt: '2026-06-23T11:16:34.000Z',
  ...over,
});

test('mergeOrAppend appends when id is new', () => {
  const before = [msg({ id: 'm-1' })];
  const after = mergeOrAppend(before, msg({ id: 'm-2', body: 'world' }));
  assert.equal(after.length, 2);
  assert.equal(after[1].body, 'world');
});

test('mergeOrAppend replaces in place when id matches', () => {
  const before = [msg({ id: 'm-1', body: 'old' }), msg({ id: 'm-2' })];
  const after = mergeOrAppend(before, msg({ id: 'm-1', body: 'new' }));
  assert.equal(after.length, 2);
  assert.equal(after[0].body, 'new');
  assert.equal(after[1].id, 'm-2');
});

test('mergeOrAppend does not mutate the input array', () => {
  const before = [msg({ id: 'm-1' })];
  const after = mergeOrAppend(before, msg({ id: 'm-2' }));
  assert.notEqual(after, before);
  assert.equal(before.length, 1);
});

test('replaceMessageById swaps the entry with matching id', () => {
  const before = [msg({ id: 'temp-1', status: 'sending' }), msg({ id: 'm-2' })];
  const after = replaceMessageById(before, 'temp-1', msg({ id: 'real-1', status: 'sent' }));
  assert.equal(after.length, 2);
  assert.equal(after[0].id, 'real-1');
  assert.equal(after[0].status, 'sent');
});

test('replaceMessageById is a no-op when oldId is not present', () => {
  const before = [msg({ id: 'm-1' })];
  const after = replaceMessageById(before, 'missing', msg({ id: 'real' }));
  assert.deepEqual(after, before);
});

test('updateMessageById applies a partial patch by id', () => {
  const before = [msg({ id: 'm-1', status: 'sending' })];
  const after = updateMessageById(before, 'm-1', { status: 'failed' });
  assert.equal(after[0].status, 'failed');
  assert.equal(after[0].body, 'hello');  // other fields unchanged
});

test('updateMessageById is a no-op when id is not present', () => {
  const before = [msg({ id: 'm-1' })];
  const after = updateMessageById(before, 'missing', { status: 'failed' });
  assert.deepEqual(after, before);
});

test('removeMessageById filters out the matching id', () => {
  const before = [msg({ id: 'm-1' }), msg({ id: 'm-2' })];
  const after = removeMessageById(before, 'm-1');
  assert.equal(after.length, 1);
  assert.equal(after[0].id, 'm-2');
});

test('removeMessageById is a no-op when id is not present', () => {
  const before = [msg({ id: 'm-1' })];
  const after = removeMessageById(before, 'missing');
  assert.deepEqual(after, before);
});
```

- [ ] **Step 4: Run tests — verify they fail**

```bash
cd dashboard && npm run test:unit
```

Expected: failures with messages like `mergeOrAppend is not a function` or import errors.

- [ ] **Step 5: Implement the helpers and export `ChatMessageView`**

Append to `dashboard/src/utils/chatMessages.ts`:

```ts
// ChatMessageView extends ChatMessage with the view-only fields the chat page renders.
// Lifted from Chats.tsx so hooks/utils can share the same shape.
export interface ChatMessageView extends ChatMessage {
  // PASTE the exact body of the original Chats.tsx:37-44 interface here.
}

/**
 * Append `incoming` to `list`. If an entry with the same id exists, replace it in place.
 * Returns a new array — does not mutate the input.
 */
export function mergeOrAppend(
  list: ChatMessageView[],
  incoming: ChatMessageView,
): ChatMessageView[] {
  const idx = list.findIndex(m => m.id === incoming.id);
  if (idx === -1) return [...list, incoming];
  const next = list.slice();
  next[idx] = incoming;
  return next;
}

/**
 * Swap the entry whose id === `oldId` with `replacement`. No-op if not found.
 */
export function replaceMessageById(
  list: ChatMessageView[],
  oldId: string,
  replacement: ChatMessageView,
): ChatMessageView[] {
  const idx = list.findIndex(m => m.id === oldId);
  if (idx === -1) return list;
  const next = list.slice();
  next[idx] = replacement;
  return next;
}

/**
 * Apply a partial patch to the entry whose id matches. No-op if not found.
 */
export function updateMessageById(
  list: ChatMessageView[],
  id: string,
  patch: Partial<ChatMessageView>,
): ChatMessageView[] {
  const idx = list.findIndex(m => m.id === id);
  if (idx === -1) return list;
  const next = list.slice();
  next[idx] = { ...next[idx], ...patch };
  return next;
}

/**
 * Filter out the entry with the matching id. No-op if not found.
 */
export function removeMessageById(
  list: ChatMessageView[],
  id: string,
): ChatMessageView[] {
  if (!list.some(m => m.id === id)) return list;
  return list.filter(m => m.id !== id);
}
```

- [ ] **Step 6: Replace local `ChatMessageView` interface in `Chats.tsx` with the import**

In `dashboard/src/pages/Chats.tsx`:
- Delete the local `interface ChatMessageView extends ChatMessage { ... }` block at lines 37-44.
- Add to the existing import from `../utils/chatMessages`:

```ts
import { mergeChatMessages, type ChatMessageView } from '../utils/chatMessages';
```

(If there's no existing import line from `../utils/chatMessages`, add one. The file already references `mergeChatMessages` somewhere — verify the import is unified.)

- [ ] **Step 7: Run tests + build + lint — all must pass**

```bash
cd dashboard && npm run test:unit && npm run build && npm run lint
```

Expected: all green. `tsc -b` should typecheck clean (no `ChatMessageView` duplicate-definition or missing-import errors).

- [ ] **Step 8: Commit**

```bash
git add dashboard/package.json dashboard/package-lock.json dashboard/src/utils/chatMessages.ts dashboard/src/utils/chatMessages.test.ts dashboard/src/pages/Chats.tsx
git commit -m "feat(dashboard): add chats deps + extract ChatMessageView + mutation helpers"
```

---

### Task 2: WhatsApp formatter parser (pure `messageFormatter.ts`)

**Files:**
- Create: `dashboard/src/utils/messageFormatter.ts`
- Test: `dashboard/src/utils/messageFormatter.test.ts`

**Interfaces:**
- Consumes: nothing (pure stdlib).
- Produces:
  - `export type MessageNode = { type: 'text', value: string } | { type: 'bold' | 'italic' | 'strike', children: MessageNode[] } | { type: 'code', value: string } | { type: 'codeblock', value: string }`
  - `export function parseMessageBody(input: string): MessageNode[]`

- [ ] **Step 1: Write failing tests covering the rules**

Create `dashboard/src/utils/messageFormatter.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessageBody, type MessageNode } from './messageFormatter.ts';

const text = (value: string): MessageNode => ({ type: 'text', value });

test('plain text returns a single text node', () => {
  assert.deepEqual(parseMessageBody('hello world'), [text('hello world')]);
});

test('returns an empty array for empty input', () => {
  assert.deepEqual(parseMessageBody(''), []);
});

test('*bold* wraps with bold', () => {
  assert.deepEqual(parseMessageBody('hi *strong* there'), [
    text('hi '),
    { type: 'bold', children: [text('strong')] },
    text(' there'),
  ]);
});

test('_italic_ wraps with italic', () => {
  assert.deepEqual(parseMessageBody('_em_'), [
    { type: 'italic', children: [text('em')] },
  ]);
});

test('~strike~ wraps with strike', () => {
  assert.deepEqual(parseMessageBody('~gone~'), [
    { type: 'strike', children: [text('gone')] },
  ]);
});

test('`inline` produces a code node with literal value', () => {
  assert.deepEqual(parseMessageBody('use `npm i` now'), [
    text('use '),
    { type: 'code', value: 'npm i' },
    text(' now'),
  ]);
});

test('```block``` produces a codeblock node with literal value', () => {
  assert.deepEqual(parseMessageBody('```line1\nline2```'), [
    { type: 'codeblock', value: 'line1\nline2' },
  ]);
});

test('code segments do not get formatted inside', () => {
  // The `*not*` inside the code segment stays literal.
  assert.deepEqual(parseMessageBody('`*not*`'), [
    { type: 'code', value: '*not*' },
  ]);
});

test('nesting: *_a_* -> bold(italic(a))', () => {
  assert.deepEqual(parseMessageBody('*_a_*'), [
    {
      type: 'bold',
      children: [
        { type: 'italic', children: [text('a')] },
      ],
    },
  ]);
});

test('whitespace right after opening marker disables the format', () => {
  // '* not bold *' has space after the opener and before the closer → literal.
  assert.deepEqual(parseMessageBody('* not bold *'), [text('* not bold *')]);
});

test('unbalanced marker stays literal', () => {
  assert.deepEqual(parseMessageBody('a *b c'), [text('a *b c')]);
});

test('newlines are preserved in text nodes', () => {
  assert.deepEqual(parseMessageBody('a\nb'), [text('a\nb')]);
});

test('multiple consecutive formats: *a* _b_', () => {
  assert.deepEqual(parseMessageBody('*a* _b_'), [
    { type: 'bold', children: [text('a')] },
    text(' '),
    { type: 'italic', children: [text('b')] },
  ]);
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd dashboard && npm run test:unit
```

Expected: failures (`parseMessageBody is not exported`).

- [ ] **Step 3: Implement the parser**

Create `dashboard/src/utils/messageFormatter.ts`:

```ts
/**
 * AST node for parsed WhatsApp message text.
 * - text: literal string
 * - bold / italic / strike: container with children (allows nesting)
 * - code: inline `` `code` ``; value rendered literally, no link detection
 * - codeblock: ```` ```block``` ````; value rendered literally with newlines preserved
 */
export type MessageNode =
  | { type: 'text'; value: string }
  | { type: 'bold'; children: MessageNode[] }
  | { type: 'italic'; children: MessageNode[] }
  | { type: 'strike'; children: MessageNode[] }
  | { type: 'code'; value: string }
  | { type: 'codeblock'; value: string };

const FORMATS: Record<string, 'bold' | 'italic' | 'strike'> = {
  '*': 'bold',
  '_': 'italic',
  '~': 'strike',
};

const BOUNDARY_OUTSIDE = /[\s.,;:!?()[\]{}'"<>]|^|$/;

/**
 * Parse a WhatsApp-formatted text string into a list of MessageNode.
 *
 * Algorithm:
 * 1. Extract code segments (triple-backtick blocks first, then single-backtick inline)
 *    by walking the string and emitting `codeblock` / `code` nodes for them; the
 *    remaining text segments are passed to the format parser.
 * 2. The format parser does a recursive descent: it scans for the next opening
 *    marker (`*`, `_`, `~`) that has a valid boundary on the outside and a
 *    non-whitespace char immediately inside, finds the matching closing marker
 *    with the same boundary rules, and recurses on the inner content.
 * 3. Unbalanced or boundary-violating markers fall through as literal text.
 */
export function parseMessageBody(input: string): MessageNode[] {
  if (input.length === 0) return [];

  // Step 1: peel off code segments, emit nodes between them.
  const nodes: MessageNode[] = [];
  let cursor = 0;

  const flushText = (end: number) => {
    if (end <= cursor) return;
    const slice = input.slice(cursor, end);
    nodes.push(...parseFormatting(slice));
    cursor = end;
  };

  while (cursor < input.length) {
    // Look for next ``` first (longer marker wins).
    const tripleStart = input.indexOf('```', cursor);
    const singleStart = findSingleBacktick(input, cursor);

    let nextCode: 'triple' | 'single' | null = null;
    let nextIdx = Infinity;
    if (tripleStart !== -1 && tripleStart < nextIdx) {
      nextCode = 'triple';
      nextIdx = tripleStart;
    }
    if (singleStart !== -1 && singleStart < nextIdx) {
      nextCode = 'single';
      nextIdx = singleStart;
    }

    if (!nextCode) {
      flushText(input.length);
      break;
    }

    if (nextCode === 'triple') {
      const closeIdx = input.indexOf('```', nextIdx + 3);
      if (closeIdx === -1) {
        // Unclosed: treat the rest as plain.
        flushText(input.length);
        break;
      }
      flushText(nextIdx);
      const value = input.slice(nextIdx + 3, closeIdx);
      nodes.push({ type: 'codeblock', value });
      cursor = closeIdx + 3;
      continue;
    }

    // single backtick
    const closeIdx = input.indexOf('`', nextIdx + 1);
    if (closeIdx === -1) {
      flushText(input.length);
      break;
    }
    flushText(nextIdx);
    const value = input.slice(nextIdx + 1, closeIdx);
    nodes.push({ type: 'code', value });
    cursor = closeIdx + 1;
  }

  return nodes;
}

/**
 * Find next single-backtick that is NOT part of a triple-backtick.
 * Returns -1 if none.
 */
function findSingleBacktick(s: string, from: number): number {
  let i = from;
  while (i < s.length) {
    const idx = s.indexOf('`', i);
    if (idx === -1) return -1;
    // Skip if part of a triple-backtick sequence.
    if (s.slice(idx, idx + 3) === '```') {
      i = idx + 3;
      continue;
    }
    if (idx > 0 && s.slice(idx - 1, idx + 2) === '```') {
      // The '`' is the last of a triple opener; skip past the triple.
      i = idx + 2;
      continue;
    }
    return idx;
  }
  return -1;
}

/**
 * Parse a text segment (no code in it) for *bold*, _italic_, ~strike~.
 * Recursive: inner content is parsed again so *_a_* nests.
 */
function parseFormatting(input: string): MessageNode[] {
  if (input.length === 0) return [];

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const fmt = FORMATS[ch];
    if (!fmt) continue;

    // Boundary outside the opener: previous char must be a boundary or string-start.
    const prev = i === 0 ? '' : input[i - 1];
    if (!BOUNDARY_OUTSIDE.test(prev) && prev !== '') continue;

    // Char immediately inside (right after the opener) must NOT be whitespace.
    const inside = input[i + 1];
    if (!inside || /\s/.test(inside)) continue;

    // Find the matching closing marker.
    for (let j = i + 1; j < input.length; j++) {
      if (input[j] !== ch) continue;
      // Char immediately before closer must NOT be whitespace.
      const beforeCloser = input[j - 1];
      if (/\s/.test(beforeCloser)) continue;
      // Boundary after closer: must be boundary or string-end.
      const after = j === input.length - 1 ? '' : input[j + 1];
      if (after !== '' && !BOUNDARY_OUTSIDE.test(after)) continue;

      const before = input.slice(0, i);
      const inner = input.slice(i + 1, j);
      const rest = input.slice(j + 1);
      return [
        ...(before ? [{ type: 'text', value: before } as MessageNode] : []),
        { type: fmt, children: parseFormatting(inner) },
        ...parseFormatting(rest),
      ];
    }
    // No matching closer for this opener — fall through to next character.
  }

  return [{ type: 'text', value: input }];
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd dashboard && npm run test:unit
```

Expected: all 13 new tests pass. If any boundary rule trips up an edge case, refine the regex/loop until green.

- [ ] **Step 5: Build + lint**

```bash
cd dashboard && npm run build && npm run lint
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/utils/messageFormatter.ts dashboard/src/utils/messageFormatter.test.ts
git commit -m "feat(dashboard): WhatsApp text format parser (bold/italic/strike/code)"
```

---

### Task 3: `MessageBody` React component

**Files:**
- Create: `dashboard/src/components/chats/MessageBody.tsx`

**Interfaces:**
- Consumes: `parseMessageBody`, `MessageNode` from Task 2; `<Linkify>` from `linkify-react`.
- Produces:
  - Default export `function MessageBody(props: { text: string; className?: string; enableLinks?: boolean }): JSX.Element`

- [ ] **Step 1: Create the component**

Create `dashboard/src/components/chats/MessageBody.tsx`:

```tsx
import { memo, type ReactNode } from 'react';
import Linkify from 'linkify-react';
import { parseMessageBody, type MessageNode } from '../../utils/messageFormatter';

interface Props {
  text: string;
  className?: string;
  enableLinks?: boolean;
}

const linkifyOptions = {
  target: '_blank',
  rel: 'noopener noreferrer',
  defaultProtocol: 'https',
  attributes: {
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  },
};

function renderNode(node: MessageNode, key: number): ReactNode {
  switch (node.type) {
    case 'text':
      return <span key={key}>{node.value}</span>;
    case 'bold':
      return <strong key={key}>{node.children.map(renderNode)}</strong>;
    case 'italic':
      return <em key={key}>{node.children.map(renderNode)}</em>;
    case 'strike':
      return <s key={key}>{node.children.map(renderNode)}</s>;
    case 'code':
      return <code key={key}>{node.value}</code>;
    case 'codeblock':
      return <pre key={key}><code>{node.value}</code></pre>;
  }
}

function MessageBodyBase({ text, className, enableLinks = true }: Props) {
  const nodes = parseMessageBody(text);
  const rendered = <>{nodes.map(renderNode)}</>;
  return (
    <div className={className}>
      {enableLinks ? <Linkify options={linkifyOptions}>{rendered}</Linkify> : rendered}
    </div>
  );
}

export default memo(MessageBodyBase);
```

- [ ] **Step 2: Typecheck + lint**

```bash
cd dashboard && npm run build && npm run lint
```

Expected: clean. If `linkify-react` types don't resolve, install `@types/linkify-react` or check the package's bundled types (linkify-react v4 bundles its own types).

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/chats/MessageBody.tsx
git commit -m "feat(dashboard): MessageBody component (formatting + linkify)"
```

---

### Task 4: Scroll decision utility + `useChatScrollPosition` hook

**Files:**
- Create: `dashboard/src/utils/scrollDecision.ts`
- Test: `dashboard/src/utils/scrollDecision.test.ts`
- Create: `dashboard/src/hooks/useChatScrollPosition.ts`

**Interfaces:**
- Consumes: React (`useRef`, `useLayoutEffect`, `useCallback`).
- Produces:
  - `export interface ScrollGeometry { scrollTop: number; scrollHeight: number; clientHeight: number }`
  - `export type ScrollDirection = 'incoming' | 'outgoing'`
  - `export type ScrollAction = 'bottom' | 'preserve'`
  - `export function decideScroll(direction: ScrollDirection, geometry: ScrollGeometry, nearBottomThreshold?: number): ScrollAction`
  - `export function useChatScrollPosition(activeChatId: string | null): { containerRef: React.RefObject<HTMLDivElement | null>; onMessageAppended: (direction: ScrollDirection) => void }`

- [ ] **Step 1: Write failing tests for the decision function**

Create `dashboard/src/utils/scrollDecision.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideScroll, type ScrollGeometry } from './scrollDecision.ts';

const at = (scrollTop: number, scrollHeight = 1000, clientHeight = 500): ScrollGeometry => ({
  scrollTop, scrollHeight, clientHeight,
});

test('outgoing message always scrolls to bottom', () => {
  // User scrolled way up (0).
  assert.equal(decideScroll('outgoing', at(0)), 'bottom');
});

test('incoming message scrolls to bottom when user is near bottom (default 100px)', () => {
  // gap = scrollHeight - scrollTop - clientHeight = 1000 - 450 - 500 = 50 < 100
  assert.equal(decideScroll('incoming', at(450)), 'bottom');
});

test('incoming message preserves position when user is far from bottom', () => {
  // gap = 1000 - 100 - 500 = 400 > 100
  assert.equal(decideScroll('incoming', at(100)), 'preserve');
});

test('incoming message at exact bottom scrolls (gap = 0)', () => {
  // gap = 1000 - 500 - 500 = 0 < 100
  assert.equal(decideScroll('incoming', at(500)), 'bottom');
});

test('incoming message exactly at threshold preserves (gap = 100 is NOT < 100)', () => {
  // gap = 1000 - 400 - 500 = 100, strictly < 100 is false
  assert.equal(decideScroll('incoming', at(400)), 'preserve');
});

test('custom threshold overrides default', () => {
  // gap = 200, threshold 300 → bottom
  assert.equal(decideScroll('incoming', at(300), 300), 'bottom');
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd dashboard && npm run test:unit
```

Expected: failures (`decideScroll is not a function`).

- [ ] **Step 3: Implement `scrollDecision.ts`**

Create `dashboard/src/utils/scrollDecision.ts`:

```ts
export interface ScrollGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export type ScrollDirection = 'incoming' | 'outgoing';
export type ScrollAction = 'bottom' | 'preserve';

const DEFAULT_NEAR_BOTTOM_THRESHOLD = 100;

/**
 * Decide whether to scroll to bottom after a new message is appended.
 *
 * - Outgoing (user sent it) always scrolls — the user wants to see their own message.
 * - Incoming scrolls only when the user is already near the bottom (i.e. they're
 *   following the conversation). When the user has scrolled up to read older messages,
 *   we preserve their position so a new arrival doesn't yank them away.
 *
 * `geometry` should be captured BEFORE the new message has been committed to the DOM,
 * so `scrollHeight` reflects the pre-append state and the "near bottom" question
 * answers the user's current intent.
 */
export function decideScroll(
  direction: ScrollDirection,
  geometry: ScrollGeometry,
  nearBottomThreshold: number = DEFAULT_NEAR_BOTTOM_THRESHOLD,
): ScrollAction {
  if (direction === 'outgoing') return 'bottom';
  const gap = geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight;
  return gap < nearBottomThreshold ? 'bottom' : 'preserve';
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd dashboard && npm run test:unit
```

Expected: 6 new tests pass.

- [ ] **Step 5: Implement the hook**

Create `dashboard/src/hooks/useChatScrollPosition.ts`:

```ts
import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import { decideScroll, type ScrollDirection } from '../utils/scrollDecision';

/**
 * Per-chat scroll-position memory + auto-scroll heuristic.
 *
 * - On chat switch: saves the leaving chat's scrollTop, restores the entering
 *   chat's scrollTop (or jumps to bottom on first visit) BEFORE paint via
 *   useLayoutEffect — no visible "jump" or smooth-scroll animation.
 * - On message append: `onMessageAppended(direction)` snapshots the geometry
 *   BEFORE the new message is committed, then defers the scroll-to-bottom (if
 *   any) to the next frame so the new message is already in the DOM.
 *
 * Mount the returned `containerRef` on the scroll container (the `.messages-list`
 * div). The Map of saved positions lives in a ref so it doesn't trigger renders
 * and is garbage-collected when the host component unmounts.
 */
export function useChatScrollPosition(activeChatId: string | null): {
  containerRef: RefObject<HTMLDivElement | null>;
  onMessageAppended: (direction: ScrollDirection) => void;
} {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scrollMap = useRef<Map<string, number>>(new Map());
  const prevChatIdRef = useRef<string | null>(null);

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

  const onMessageAppended = useCallback((direction: ScrollDirection) => {
    const el = containerRef.current;
    if (!el) return;
    const action = decideScroll(direction, {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    if (action === 'preserve') return;
    requestAnimationFrame(() => {
      const cur = containerRef.current;
      if (cur) cur.scrollTop = cur.scrollHeight;
    });
  }, []);

  return { containerRef, onMessageAppended };
}
```

- [ ] **Step 6: Build + lint**

```bash
cd dashboard && npm run build && npm run lint
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/utils/scrollDecision.ts dashboard/src/utils/scrollDecision.test.ts dashboard/src/hooks/useChatScrollPosition.ts
git commit -m "feat(dashboard): per-chat scroll position memory + auto-scroll heuristic"
```

---

### Task 5: `useChatMessages` hook

**Files:**
- Create: `dashboard/src/hooks/useChatMessages.ts`

**Interfaces:**
- Consumes: `useQuery`, `useQueryClient` from `@tanstack/react-query`; `mergeOrAppend`, `replaceMessageById`, `updateMessageById`, `removeMessageById`, `ChatMessageView` from Task 1; existing `fetchMessages`-equivalent logic from `Chats.tsx:332-353` (`loadMessages` body).
- Produces:
  - `export type MessagesQueryKey = readonly ['messages', string, string]`
  - `export function messagesQueryKey(sessionId: string, chatId: string): MessagesQueryKey`
  - `export function useChatMessages(sessionId: string, chatId: string | null): UseQueryResult<ChatMessageView[], Error>`
  - `export function useChatMessagesActions(): { appendMessage, replaceTempMessage, updateMessage, removeMessage }` — each takes `(sessionId, chatId, ...)` and writes to `queryClient.setQueryData`.

- [ ] **Step 1: Locate the existing fetch logic**

Open `dashboard/src/pages/Chats.tsx` and find the `loadMessages` callback (search for `loadMessages`). It currently does:

```ts
const loadMessages = useCallback(async (chatId: string) => {
  // 1. fetch db messages: const dbMessages = await messageApi.list(selectedSessionId, chatId);
  // 2. fetch history:    const history = await messageApi.history(selectedSessionId, chatId);
  // 3. merge:            setMessages(mergeChatMessages(dbMessages, history));
}, [...]);
```

(Confirm the exact API calls and merge helper used. Rule: this task lifts the SAME logic into the queryFn, not a refactor.)

- [ ] **Step 2: Create the hook file**

Create `dashboard/src/hooks/useChatMessages.ts`:

```ts
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  mergeChatMessages,
  mergeOrAppend,
  replaceMessageById,
  updateMessageById,
  removeMessageById,
  type ChatMessageView,
} from '../utils/chatMessages';
import { messageApi } from '../services/api';  // adjust import to match how Chats.tsx imports today

export type MessagesQueryKey = readonly ['messages', string, string];

export function messagesQueryKey(sessionId: string, chatId: string): MessagesQueryKey {
  return ['messages', sessionId, chatId] as const;
}

/**
 * Fetch messages for one (sessionId, chatId) and keep them cached forever
 * (staleTime: Infinity). Realtime updates flow through useChatMessagesActions,
 * not through refetches. Cache eviction happens 30 min after the chat stops
 * being observed (gcTime).
 */
export function useChatMessages(
  sessionId: string,
  chatId: string | null,
): UseQueryResult<ChatMessageView[], Error> {
  return useQuery<ChatMessageView[], Error>({
    queryKey: messagesQueryKey(sessionId, chatId ?? ''),
    queryFn: async () => {
      // MIRROR the existing loadMessages body from Chats.tsx — same API calls,
      // same merge helper, just lifted into a queryFn. Do not silently change
      // semantics.
      const dbMessages = await messageApi.list(sessionId, chatId!);
      const history = await messageApi.history(sessionId, chatId!);
      return mergeChatMessages(dbMessages, history);
    },
    enabled: Boolean(sessionId && chatId),
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
  });
}

/**
 * Mutation helpers that write directly to the React Query cache. Use these
 * from the WebSocket subscriber, the optimistic-send flow, and ACK handlers
 * instead of calling setMessages locally.
 */
export function useChatMessagesActions() {
  const qc = useQueryClient();

  return {
    appendMessage(sessionId: string, chatId: string, msg: ChatMessageView) {
      qc.setQueryData<ChatMessageView[]>(
        messagesQueryKey(sessionId, chatId),
        (old = []) => mergeOrAppend(old, msg),
      );
    },
    replaceTempMessage(sessionId: string, chatId: string, tempId: string, real: ChatMessageView) {
      qc.setQueryData<ChatMessageView[]>(
        messagesQueryKey(sessionId, chatId),
        (old = []) => replaceMessageById(old, tempId, real),
      );
    },
    updateMessage(sessionId: string, chatId: string, id: string, patch: Partial<ChatMessageView>) {
      qc.setQueryData<ChatMessageView[]>(
        messagesQueryKey(sessionId, chatId),
        (old = []) => updateMessageById(old, id, patch),
      );
    },
    removeMessage(sessionId: string, chatId: string, id: string) {
      qc.setQueryData<ChatMessageView[]>(
        messagesQueryKey(sessionId, chatId),
        (old = []) => removeMessageById(old, id),
      );
    },
  };
}
```

> Note for the implementer: the exact `messageApi.list(...)` / `.history(...)` calls in the queryFn MUST mirror the current `loadMessages` callback in `Chats.tsx`. If the function names are different in your tree, use the real names. Don't invent. Don't refactor the API surface.

- [ ] **Step 3: Build + lint**

```bash
cd dashboard && npm run build && npm run lint
```

Expected: clean. If `@tanstack/react-query` isn't already wired with a `QueryClientProvider` at the app root (`App.tsx` / `main.tsx`), the existing code already uses React Query (verify in App.tsx) — no setup needed in this task.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/hooks/useChatMessages.ts
git commit -m "feat(dashboard): useChatMessages hook (React Query cache + mutations)"
```

---

### Task 6: `MediaLightbox` component (yarl wrapper)

**Files:**
- Create: `dashboard/src/components/chats/MediaLightbox.tsx`

**Interfaces:**
- Consumes: `Lightbox` + plugins from `yet-another-react-lightbox`.
- Produces:
  - `export interface LightboxItem { id: string; url: string; alt?: string; senderName?: string; timestamp?: string }`
  - Default export `function MediaLightbox(props: { items: LightboxItem[]; index: number | null; onClose: () => void; onNavigate: (next: number) => void }): JSX.Element | null`

- [ ] **Step 1: Create the component**

Create `dashboard/src/components/chats/MediaLightbox.tsx`:

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

- [ ] **Step 2: Build + lint**

```bash
cd dashboard && npm run build && npm run lint
```

Expected: clean. yarl bundles its own types.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/chats/MediaLightbox.tsx
git commit -m "feat(dashboard): MediaLightbox component (yarl wrapper)"
```

---

### Task 7: Wire everything into `Chats.tsx`

**Files:**
- Modify: `dashboard/src/pages/Chats.tsx` (multi-site)

**Interfaces:**
- Consumes: `useChatMessages` + `useChatMessagesActions` (Task 5), `useChatScrollPosition` (Task 4), `MessageBody` (Task 3), `MediaLightbox` + `LightboxItem` (Task 6).
- Produces: same external surface (the page renders the same UI from the outside).

This is the largest task. It replaces state in `Chats.tsx` without changing the rendered DOM structure beyond what each feature needs.

- [ ] **Step 1: Replace the messages state with the React Query hook**

In `dashboard/src/pages/Chats.tsx`:

**Remove**:
```ts
const [messages, setMessages] = useState<ChatMessageView[]>([]);
const [loadingMessages, setLoadingMessages] = useState<boolean>(false);
```

**Remove** the entire `loadMessages` useCallback definition.

**Remove** the `useEffect` that fires `loadMessages` when `activeChat` changes (the block at `Chats.tsx:430-437`).

**Add** near the other hooks (after `selectedSessionId` / `activeChat` are declared):
```ts
import { useChatMessages, useChatMessagesActions } from '../hooks/useChatMessages';

const {
  data: messages = [],
  isLoading: loadingMessages,
} = useChatMessages(selectedSessionId, activeChat?.id ?? null);

const { appendMessage, replaceTempMessage, updateMessage, removeMessage } =
  useChatMessagesActions();
```

(Replace any reference to the removed `setMessages` and `setLoadingMessages` further in the file according to the next steps. `loadingMessages` keeps its name so existing UI conditionals still read.)

- [ ] **Step 2: Rewire the WebSocket subscriber (around `Chats.tsx:176-254`)**

Inside the WS subscriber's message handler, find every `setMessages(prev => …)` call and translate:

- `setMessages(prev => […prev, newMsg])` (append) → `appendMessage(newMsg.sessionId, newMsg.chatId, newMsg)`
- `setMessages(prev => prev.map(m => m.id === id ? {...m, status} : m))` (ack) → `updateMessage(event.sessionId, chatId, event.messageId, { status })`
- Mark-as-read effects: unchanged — `markChatRead` is unrelated to the messages cache.

**Important**: when the WS append targets the currently active chat AND the new message is rendered, also call `onMessageAppended('incoming')` to keep the scroll heuristic in sync (Step 4 below sets this up).

- [ ] **Step 3: Rewire the optimistic send flow (around `Chats.tsx:482-590`)**

In `handleSend`:

- The line that adds the temp message — `setMessages(prev => [...prev, tempMessage])` — becomes:
  ```ts
  appendMessage(selectedSessionId, activeChat.id, tempMessage);
  onMessageAppended('outgoing');
  ```
- The success path that replaces the temp with the real response — `setMessages(prev => prev.map(m => m.id === tempId ? real : m))` — becomes:
  ```ts
  replaceTempMessage(selectedSessionId, activeChat.id, tempId, real);
  ```
- The failure path that marks the temp as failed — `setMessages(prev => prev.map(m => m.id === tempId ? {...m, status: 'failed'} : m))` — becomes:
  ```ts
  updateMessage(selectedSessionId, activeChat.id, tempId, { status: 'failed' });
  ```

Other paths that touch `setMessages` (delete-for-everyone, edit, reaction) follow the same pattern: pick the right helper (`updateMessage` for in-place changes, `removeMessage` for deletions).

- [ ] **Step 4: Replace the scroll effect with the hook (around `Chats.tsx:440-441`)**

**Remove**:
```ts
useEffect(() => {
  chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
}, [messages]);
```

**Remove** the `chatBottomRef` if it's not used anywhere else.

**Add** (near the other hooks):
```ts
import { useChatScrollPosition } from '../hooks/useChatScrollPosition';

const { containerRef: messagesContainerRef, onMessageAppended } =
  useChatScrollPosition(activeChat?.id ?? null);
```

In the JSX, attach `messagesContainerRef` to the scroll container (the existing `<div className="messages-list">` or whichever element holds the scrolling list of messages — find it in the render block).

Call `onMessageAppended('incoming')` immediately after each `appendMessage` from the WS handler (Step 2), gated on `activeChat?.id === newMsg.chatId` (only the visible chat scrolls).

Call `onMessageAppended('outgoing')` immediately after the optimistic-append in `handleSend` (Step 3 already shows this).

- [ ] **Step 5: Wire the lightbox**

Near the other `useState` declarations:
```ts
import { useMemo } from 'react';
import MediaLightbox, { type LightboxItem } from '../components/chats/MediaLightbox';

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

In the message render (`<img ... className="message-image">` near `Chats.tsx:790`), add a click handler:
```tsx
<img
  src={…}            // existing
  alt={…}            // existing
  className="message-image"
  onClick={() => setLightboxIndex(imageMedia.findIndex(x => x.id === msg.id))}
/>
```

(Keep the `style={{ cursor: 'zoom-in' }}` in CSS instead of inline — see Task 8.)

At the bottom of the page JSX, render the lightbox:
```tsx
<MediaLightbox
  items={imageMedia}
  index={lightboxIndex}
  onClose={() => setLightboxIndex(null)}
  onNavigate={setLightboxIndex}
/>
```

- [ ] **Step 6: Swap `{msg.body}` plain renders to `<MessageBody>`**

Find the line (currently `Chats.tsx:855`):
```tsx
<div className="message-text">{msg.body}</div>
```
Replace with:
```tsx
<MessageBody text={msg.body} className="message-text" />
```

Find the quoted-message render (currently `Chats.tsx:844`):
```tsx
<div className="quote-body">{msg.metadata.quotedMessage.body}</div>
```
Replace with:
```tsx
<MessageBody text={msg.metadata.quotedMessage.body} className="quote-body" />
```

Add the import:
```ts
import MessageBody from '../components/chats/MessageBody';
```

- [ ] **Step 7: Build + lint**

```bash
cd dashboard && npm run build && npm run lint
```

Expected: clean. Common gotchas:
- A `setMessages` reference left behind somewhere — `tsc -b` will catch the missing identifier.
- The WS handler's `sessionId` argument: ensure you're passing the message's session, not the currently-selected one (a WS event for chat X belonging to session Z should still update Z's cache).
- React Query is already set up at the app root (existing pages use it). If `npm run build` complains there's no `QueryClientProvider`, check `dashboard/src/App.tsx` and `dashboard/src/main.tsx`.

- [ ] **Step 8: Run unit tests — they all still pass**

```bash
cd dashboard && npm run test:unit
```

Expected: all tests pass (we haven't touched the pure utilities they cover).

- [ ] **Step 9: Manual smoke**

Start the dev server against a running OpenWA instance:
```bash
cd dashboard && npm run dev
```

Open the dashboard. With a connected WhatsApp session that has chat history:
1. Open chat A → messages load with a spinner. Scrolls to bottom (no smooth animation).
2. Click chat B → loads with spinner, at bottom.
3. Click chat A again → renders INSTANTLY (no spinner), scroll position at the bottom (where you left it). No visible scroll jump.
4. In chat A, scroll up to old messages. Switch to chat B. Switch back to A → scroll restored to where you left it.
5. With chat A open and scrolled up, have someone send a message to A → no auto-scroll. (Or set scrollTop to near-bottom and verify auto-scroll triggers.)
6. Send a message from A → scrolls to bottom.
7. Send a message with body `mira *bold* y _italic_ y github.com/x`. The bold/italic apply, `github.com/x` is a clickable link in a new tab.
8. Receive a photo. Click it → lightbox opens, image fills viewport. Wheel-zoom in, drag to pan. ESC closes. ←/→ navigate if multiple photos.
9. Lightbox download button downloads the image.

- [ ] **Step 10: Commit**

```bash
git add dashboard/src/pages/Chats.tsx
git commit -m "feat(dashboard): wire Chats.tsx to React Query, scroll memory, formatter, lightbox"
```

---

### Task 8: CSS additions (`Chats.css`)

**Files:**
- Modify: `dashboard/src/pages/Chats.css`

**Interfaces:**
- Consumes: existing rules for `.message-text`, `.quote-body`, `.message-image`.
- Produces: visual polish — cursor on photos, newline preservation, yarl theme overrides matching the dashboard.

- [ ] **Step 1: Inspect existing rules**

Open `dashboard/src/pages/Chats.css` and find the existing `.message-text` block (around line 410). Check if `white-space: pre-wrap` is already present.

- [ ] **Step 2: Add the rules**

Append to `dashboard/src/pages/Chats.css`:

```css
/* Inline message body: preserve newlines from WhatsApp text. */
.chats-page .message-text,
.chats-page .quote-body {
  white-space: pre-wrap;
}

/* Inline code inside a message body. */
.chats-page .message-text code,
.chats-page .quote-body code {
  background: var(--surface-2, rgba(255, 255, 255, 0.08));
  padding: 0.1em 0.35em;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.9em;
}

/* Code block. */
.chats-page .message-text pre {
  background: var(--surface-2, rgba(255, 255, 255, 0.08));
  padding: 0.5em 0.75em;
  border-radius: 6px;
  margin: 0.25em 0;
  overflow-x: auto;
}

.chats-page .message-text pre code {
  background: transparent;
  padding: 0;
}

/* Clickable photo cue. */
.chats-page .message-image {
  cursor: zoom-in;
}

/* yarl theme — match dashboard dark palette. */
.yarl__container { --yarl__color_backdrop: rgba(0, 0, 0, 0.92); }
.yarl__button   { --yarl__color_button: rgba(255, 255, 255, 0.9); }
```

If `.message-text` already had `white-space: pre-wrap` (Step 1), drop the first block; the rest still applies.

- [ ] **Step 3: Verify visually**

`npm run dev`, open a chat with multi-line messages, inline code, and an image. Confirm:
- Multi-line text renders with line breaks.
- Inline `` `code` `` looks distinct.
- Hovering a photo shows the zoom cursor.
- Opening the lightbox uses a near-black backdrop (consistent with dashboard).

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/pages/Chats.css
git commit -m "style(dashboard): chats — formatting rules + lightbox theme + zoom cursor"
```

---

## Final integration check

After all 8 tasks land:

- [ ] `cd dashboard && npm run test:unit && npm run build && npm run lint` — all green.
- [ ] `cd dashboard && npm run i18n:check` — green (we didn't add i18n keys; the script should remain happy).
- [ ] Manual smoke matrix from Task 7 Step 9 still passes.
- [ ] Visual check on mobile viewport: pinch-to-zoom works in the lightbox, swipe between photos works.

## Branch + PR

When all green:

```bash
# (from your local clone of softronicve/OpenWA — NOT in /var/www/openwa.softronic.dev)
git checkout -b feat/chats-ux-improvements main
git cherry-pick <each commit SHA from this plan in order>
git push -u fork feat/chats-ux-improvements
gh pr create --repo rmyndharis/OpenWA --base main --head softronicve:feat/chats-ux-improvements \
  --title "Dashboard /chats: clickable links, formatting, lightbox, scroll memory" \
  --body "$(cat docs/superpowers/specs/2026-06-26-dashboard-chats-ux-improvements-design.md | head -50)"
```

(Adjust the cherry-pick to whatever workflow you prefer — squash, or push commits as-is. The plan's commits are already focused and well-titled.)
