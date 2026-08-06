/**
 * AST node for parsed WhatsApp message text.
 * - text: literal string
 * - bold / italic / strike: container with children (allows nesting)
 * - code: inline `code`; value rendered literally, no link detection
 * - codeblock: ```block```; value rendered literally with newlines preserved
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
  _: 'italic',
  '~': 'strike',
};

const BOUNDARY_CHAR = /^[\s.,;:!?()[\]{}'"<>]$/;

/**
 * Parse a WhatsApp-formatted text string into a list of MessageNode.
 *
 * Algorithm:
 * 1. Extract code segments (triple-backtick blocks first, then single-backtick inline)
 *    by walking the string and emitting `codeblock` / `code` nodes for them; the
 *    remaining text segments are passed to the format parser.
 * 2. The format parser scans for the next opening marker (`*`, `_`, `~`) that has a valid
 *    boundary on the outside and a non-whitespace char immediately inside, finds the matching
 *    closing marker with the same boundary rules, and re-parses the inner content. Sibling
 *    segments are emitted iteratively and nesting is depth-capped (MAX_FORMAT_DEPTH), so a
 *    pathological message can't exhaust the call stack; beyond the cap the rest stays literal.
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
    // Loop instead of nodes.push(...parsed): spreading a huge segment list into push() hits the
    // engine's argument-count limit and throws the same RangeError as a stack overflow.
    for (const node of parseFormatting(slice)) nodes.push(node);
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
      // The '`' is the middle of a triple backtick; skip past all three.
      i = idx + 2;
      continue;
    }
    return idx;
  }
  return -1;
}

/**
 * Deepest nesting of format markers the parser will honour. A hostile message can alternate
 * openers (`*_*_*_…`) to nest thousands of levels, or repeat segments (`*a* *a* …`) to queue
 * thousands of sibling splits; an unbounded recursive descent overflows the call stack and
 * freezes the tab. Segments at one level are emitted iteratively (no stack growth), and past
 * this depth the remaining content falls back to a literal text node — markers and all — so
 * the message still renders, just without the deeper formatting.
 */
const MAX_FORMAT_DEPTH = 20;

/**
 * Parse a text segment (no code in it) for *bold*, _italic_, ~strike~.
 * Inner content is parsed again (depth-bounded) so *_a_* nests; sibling segments after a
 * formatted span are handled by the loop, not by recursion.
 */
function parseFormatting(input: string, depth = 0): MessageNode[] {
  if (input.length === 0) return [];
  if (depth >= MAX_FORMAT_DEPTH) return [{ type: 'text', value: input }];

  const nodes: MessageNode[] = [];
  let rest = input;
  while (rest.length > 0) {
    const split = splitFirstFormat(rest);
    if (!split) {
      nodes.push({ type: 'text', value: rest });
      break;
    }
    if (split.before) nodes.push({ type: 'text', value: split.before });
    nodes.push({ type: split.fmt, children: parseFormatting(split.inner, depth + 1) });
    rest = split.after;
  }
  return nodes;
}

/**
 * Locate the first usable format span: an opening marker (`*`, `_`, `~`) with a valid boundary
 * on the outside and a non-whitespace char immediately inside, paired with the first closing
 * marker satisfying the same boundary rules. Returns the text before the span, the format, the
 * inner content, and the unconsumed remainder — or null when the segment holds no valid span
 * (unbalanced or boundary-violating markers stay literal).
 */
function splitFirstFormat(
  input: string,
): { before: string; fmt: 'bold' | 'italic' | 'strike'; inner: string; after: string } | null {
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const fmt = FORMATS[ch];
    if (!fmt) continue;

    // Boundary outside the opener: previous char must be a boundary or string-start.
    const prev = i === 0 ? '' : input[i - 1];
    if (prev !== '' && !BOUNDARY_CHAR.test(prev)) continue;

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
      if (after !== '' && !BOUNDARY_CHAR.test(after)) continue;

      return {
        before: input.slice(0, i),
        fmt,
        inner: input.slice(i + 1, j),
        after: input.slice(j + 1),
      };
    }
    // No matching closer for this opener — fall through to next character.
  }

  return null;
}
