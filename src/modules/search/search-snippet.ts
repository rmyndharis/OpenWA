import { foldForMatching } from './search-terms';

/**
 * Snippets for match=contains hits, built in the application rather than the database so both
 * dialects return the same text: FTS5's snippet() counts its window in trigrams on a trigram index,
 * and Postgres has no headline function for a substring match.
 *
 * The output follows the SearchHit.snippet contract of match=word: a window of the body, `…` where it
 * was cut, every match inside it wrapped in `<mark>`/`</mark>`, and the body text itself NOT
 * HTML-escaped (render it as text, never as HTML).
 */

/** Words shown before the first match, so a match late in a long message keeps some context. */
const WORDS_BEFORE_MATCH = 8;

/** A folded copy of a text, with the original start and end offset of each folded UTF-16 unit. */
interface FoldedText {
  folded: string;
  starts: number[];
  ends: number[];
}

/**
 * What folds as one unit: a character with the combining marks after it, or a Hangul syllable spelled
 * as jamo (leading consonants, vowels, trailing consonants), which NFC composes into one syllable.
 */
const FOLD_UNIT = /[\u1100-\u115f]+[\u1160-\u11a7]*[\u11a8-\u11ff]*\p{M}*|[\s\S]\p{M}*/gu;

/**
 * Folding can change a text's length: a body that spells `é` as `e` followed by a combining accent
 * loses that accent unit. Matches are therefore found in the folded copy and mapped back through
 * per-unit offsets, rather than assuming positions line up. The text folds one FOLD_UNIT at a time, as
 * the whole body folds for the score: a letter's accents fold away with it, so a match ending on it
 * covers them instead of leaving a dangling accent outside </mark>, and jamo recompose into the
 * syllable the term folds to.
 */
function foldWithOffsets(text: string): FoldedText {
  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (const { 0: unit, index } of text.matchAll(FOLD_UNIT)) {
    const mapped = foldForMatching(unit);
    for (let i = 0; i < mapped.length; i++) {
      starts.push(index);
      ends.push(index + unit.length);
    }
    folded += mapped;
  }
  return { folded, starts, ends };
}

/** Every occurrence of every term in `body`, as sorted, merged [start, end) offsets into the original. */
function matchRanges(body: string, terms: string[]): Array<[number, number]> {
  const { folded, starts, ends } = foldWithOffsets(body);
  const ranges: Array<[number, number]> = [];
  for (const term of terms.map(foldForMatching).filter(Boolean)) {
    for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + term.length)) {
      ranges.push([starts[at], ends[at + term.length - 1]]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * Up to `maxWords` words of `body`, starting a few words before the first match (or at the start when
 * none is found, e.g. a short term LIKE matched on SQLite's ASCII-only case folding), with every match
 * in the window marked.
 */
export function containsSnippet(body: string, terms: string[], maxWords: number): string {
  const words = [...body.matchAll(/\S+/g)];
  if (words.length === 0) return '';
  const ranges = matchRanges(body, terms);
  const firstHit = ranges.length ? words.findIndex(w => (w.index ?? 0) + w[0].length > ranges[0][0]) : 0;
  // Never more context than the window can hold next to the match itself.
  const before = Math.min(WORDS_BEFORE_MATCH, maxWords - 1);
  const from = Math.max(0, Math.min(firstHit - before, words.length - maxWords));
  const to = Math.min(words.length, from + maxWords);
  const sliceStart = words[from].index ?? 0;
  const sliceEnd = (words[to - 1].index ?? 0) + words[to - 1][0].length;

  let snippet = from > 0 ? '…' : '';
  let cursor = sliceStart;
  for (const [start, end] of ranges) {
    if (end <= sliceStart || start >= sliceEnd) continue;
    const markStart = Math.max(start, sliceStart);
    const markEnd = Math.min(end, sliceEnd);
    snippet += `${body.slice(cursor, markStart)}<mark>${body.slice(markStart, markEnd)}</mark>`;
    cursor = markEnd;
  }
  snippet += body.slice(cursor, sliceEnd);
  return to < words.length ? `${snippet}…` : snippet;
}
