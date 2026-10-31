import { foldForMatching } from './search-terms';

/**
 * Relevance of a match=contains candidate, computed in the application so both dialects rank alike
 * (see BuiltInFtsProvider.searchContains for why ranking left the database).
 *
 * Each term scores by its best occurrence in the body, compared folded (case and accents dropped):
 *  - 3 as a whole word (`invoice` in "pay the invoice today"),
 *  - 2 at the start of a word (`invoice` in "invoiced"),
 *  - 1 inside a word (`voic` in "invoice"),
 *  - 0 when the folded body does not contain it (a short term SQLite's ASCII-only LIKE matched).
 * The score is the sum over the terms, so a message matching more terms as words ranks higher. It
 * reads only the one body, never statistics of other messages, so it reveals nothing outside the
 * caller's scope.
 */
export function containsScore(body: string, terms: string[]): number {
  const folded = foldForMatching(body);
  let score = 0;
  for (const term of terms.map(foldForMatching)) {
    let best = 0;
    for (let at = folded.indexOf(term); at !== -1 && best < 3; at = folded.indexOf(term, at + 1)) {
      const startsWord = !isWordChar(folded[at - 1]);
      const endsWord = !isWordChar(folded[at + term.length]);
      best = Math.max(best, startsWord && endsWord ? 3 : startsWord ? 2 : 1);
    }
    score += best;
  }
  return score;
}

/** A letter or a digit in any script; anything else (space, punctuation, start or end) bounds a word. */
function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}
