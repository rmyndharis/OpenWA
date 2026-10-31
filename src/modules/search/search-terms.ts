import { BadRequestException } from '@nestjs/common';

/**
 * What the built-in index (SQLite FTS5, unicode61) makes of a query, as an upper bound on its words. A
 * run of letters or digits is one word. ASCII punctuation separates. Any other character outside ASCII
 * may separate or be part of a word, depending on what the index's own Unicode table knows of it: the
 * ones it knows as marks, punctuation or symbols separate, and private use, a letter it does not split
 * on and every code point that table predates (among them recent emoji and marks) are parts of words.
 *
 * The 21 letters its tokenizer still splits on are left out of the run, so they count among the other
 * characters. search-terms.spec.ts compares every code point, and strings of them, with the bundled
 * SQLite, so an upgrade that moves one fails there instead of silently loosening the bound.
 */
const RUN_CHAR = /^(?![ᦰ-ᧀᧈᧉᳲᳳ])[\p{L}\p{N}]$/u;

/**
 * The words of one whitespace-free string, at most: each run of letters or digits is one, and so are
 * the characters outside ASCII that are neither, which the index may take as words of their own.
 *
 * A stretch of m such characters adds at most ceil(m / 2) words, alternating one the index glues with
 * one it separates on. Next to a run of letters it adds fewer: a glued character there joins that
 * word, so at most floor(m / 2) words with one neighbour and floor((m - 1) / 2) with two. A vowel sign
 * or a joiner between letters therefore adds none, and Devanagari or Persian text counts the words the
 * index finds in it.
 */
function wordsOf(word: string): number {
  let words = 0;
  let inRun = false;
  let stretch = 0;
  let afterRun = false;
  const close = (beforeRun: boolean): void => {
    if (stretch === 0) return;
    const neighbours = (afterRun ? 1 : 0) + (beforeRun ? 1 : 0);
    words += neighbours === 0 ? Math.ceil(stretch / 2) : Math.floor((stretch - (neighbours === 2 ? 1 : 0)) / 2);
    stretch = 0;
  };
  for (const char of word) {
    if (RUN_CHAR.test(char)) {
      close(true);
      if (!inRun) words += 1;
      inRun = true;
    } else if ((char.codePointAt(0) ?? 0) > 0x7f) {
      if (stretch === 0) afterRun = inRun;
      stretch += 1;
      inRun = false;
    } else {
      close(false);
      inRun = false;
    }
  }
  close(false);
  return words;
}

/**
 * Folds text the way the match=contains indexes compare it: accents dropped (NFD, then every combining
 * mark removed, as remove_diacritics and unaccent do for Latin text), recomposed (NFC: NFD splits a
 * Hangul syllable into conjoining jamo, which are letters, so `서울` would count five characters where
 * the database sees two) and case lowered. Used to compare terms and to place highlights, never to
 * build SQL, which leaves folding to the database.
 */
export function foldSearchText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC').toLowerCase();
}

/**
 * foldSearchText for the application's own comparisons, the score and the highlight, with final sigma
 * read as sigma: lowercasing a whole body turns a word-final `Σ` into `ς`, and one character alone into
 * `σ`, so a match the score counted got no highlight. The terms sent to the database are not affected.
 */
export function foldForMatching(text: string): string {
  return foldSearchText(text).replace(/ς/g, 'σ');
}

/**
 * A match=contains query refused for its terms (none long enough for a trigram index, or more characters
 * than SEARCH_CONTAINS_TERMS_MAX_LENGTH), which a word search can still answer: the MessageSearch tool
 * runs one instead when the agent did not ask for contains.
 */
export class ContainsTermsRefusedError extends BadRequestException {}

/**
 * The whitespace-separated terms of a match=contains query, each kept as written, with a term that
 * folds to one already seen dropped (`Café cafe` is one term): it would add nothing to an AND but
 * one more predicate per matching row.
 */
export function containsTerms(q: string): string[] {
  const terms = new Map<string, string>();
  for (const term of q.trim().split(/\s+/)) {
    const folded = foldSearchText(term);
    if (folded && !terms.has(folded)) terms.set(folded, term);
  }
  return [...terms.values()];
}

/**
 * How many words a query holds: each run of letters or digits is one, so punctuation separates words as
 * whitespace does (`a.b.c` is three, and a quoted token of them is a three-word phrase to match), and a
 * symbol or emoji that stands apart counts as a word of its own. A whitespace-separated word said again
 * is run once and counts once, and a word with no letter, digit or symbol counts as one.
 */
export function searchTermCount(q: string): number {
  let count = 0;
  for (const word of new Set(q.trim().split(/\s+/))) {
    count += wordsOf(word) || 1;
  }
  return count;
}
