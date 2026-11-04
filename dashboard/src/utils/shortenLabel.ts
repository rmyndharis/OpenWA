// Graphemes, not code points: a flag, a family emoji or a letter with combining marks is several code points
// and must not be cut inside. A browser without Segmenter (Firefox before 125) counts code points instead.
const segmenter =
  typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

function graphemes(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), part => part.segment) : Array.from(text);
}

/**
 * Fit a chart axis label into a fixed width. An id with no name (a run of digits, or a legacy group id, which
 * is two runs joined by a hyphen) keeps both ends, because the tail is what tells two ids apart; any other
 * label keeps its start. Visible characters are counted, not UTF-16 units, so an emoji at the cut is never
 * split in half.
 */
export function shortenLabel(label: string, max = 16): string {
  const chars = graphemes(label);
  if (chars.length <= max) return label;
  if (/^\d+(?:-\d+)*$/.test(label)) {
    const head = Math.ceil((max - 1) / 2);
    const tail = max - 1 - head;
    return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`;
  }
  return `${chars.slice(0, max - 1).join('')}…`;
}

const FIRST_STRONG_ISOLATE = String.fromCodePoint(0x2068);
const POP_ISOLATE = String.fromCodePoint(0x2069);

/**
 * Wrap a label in a first-strong isolate. The ellipsis has no direction of its own, so beside a label written
 * the other way round from its page it would be laid out on the wrong side ("8904778…12036325" for an id).
 * The isolate gives the label its own direction from its own characters.
 */
export function isolate(label: string): string {
  return `${FIRST_STRONG_ISOLATE}${label}${POP_ISOLATE}`;
}
