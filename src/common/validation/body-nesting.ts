/**
 * How many levels of objects and arrays a request body may nest. The recursive readers of a parsed body
 * (class-transformer in the validation pipe, the send idempotency fingerprint, the cluster proxy's
 * JSON.stringify) overflow the stack a couple of thousand levels down and answered 500 with a stack trace
 * in the log. A real payload nests a handful of levels; nothing in the API takes one near this.
 */
export const MAX_BODY_NESTING = 100;

/** The 400 text, the same whether the depth was read from the raw bytes or from the parsed body. */
export const BODY_NESTING_MESSAGE = `Request body must not nest objects or arrays more than ${MAX_BODY_NESTING} levels deep`;

/**
 * Whether a charset label names UTF-8 the way the body decoder reads it. body-parser passes the label to
 * iconv-lite, which lower-cases it and drops every character that is not a letter or digit, and a trailing
 * ':NNNN' year, so 'utf-8.', 'utf-_8', 'utf--8' and 'utf-8:1993' all decode as UTF-8. Comparing the label
 * with 'utf-8' would let a client pick the slower path by spelling it differently. The only other labels the
 * parser lets through (it requires the prefix 'utf-') are UTF-16, UTF-32 and UTF-7.
 */
export const isUtf8Charset = (charset: string): boolean =>
  charset.toLowerCase().replace(/:\d{4}$|[^0-9a-z]/g, '') === 'utf8';

const QUOTE = 0x22; // "
const BACKSLASH = 0x5c;
const OPEN_BRACKET = 0x5b; // [
const CLOSE_BRACKET = 0x5d; // ]
const OPEN_BRACE = 0x7b; // {
const CLOSE_BRACE = 0x7d; // }

/**
 * Whether UTF-8 JSON text nests deeper than the cap, read from the raw bytes BEFORE it is parsed. This runs on
 * every JSON body ahead of authentication, so it has to cost a single cheap pass: allocating a value for every
 * container of a parsed copy, as the walk below does, cost 0.4 to 1.8 times the JSON.parse it followed on a
 * body of many small containers or many keys.
 *
 * It skips each string, and a backslash skips the byte it escapes, which is all valid JSON needs; UTF-8 never
 * encodes one of these ASCII bytes inside a multi-byte character. Text that is not valid JSON may be judged
 * either way, and the parse refuses it anyway. It stops at the first level past the cap.
 */
export function exceedsJsonNesting(text: Uint8Array): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const byte = text[i];
    if (byte === QUOTE) {
      // Skip the string. A backslash escapes the byte after it, so an escaped quote does not end the string.
      for (i++; i < text.length && text[i] !== QUOTE; i++) {
        if (text[i] === BACKSLASH) i++;
      }
    } else if (byte === OPEN_BRACKET || byte === OPEN_BRACE) {
      if (++depth > MAX_BODY_NESTING) return true;
    } else if (byte === CLOSE_BRACKET || byte === CLOSE_BRACE) {
      depth--;
    }
  }
  return false;
}

/**
 * Whether a parsed request body nests deeper than the cap. It stops descending at the cap, so the walk cannot
 * overflow. Used for a body the raw scan above cannot read, which is JSON in a charset other than UTF-8.
 */
export const exceedsBodyNesting = (value: unknown, depth = 1): boolean =>
  typeof value === 'object' &&
  value !== null &&
  (depth > MAX_BODY_NESTING || Object.values(value).some(child => exceedsBodyNesting(child, depth + 1)));
