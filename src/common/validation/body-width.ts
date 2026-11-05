/**
 * How wide a request body may be. class-transformer copies every array element and every object key of a body
 * before a validator can refuse it, and de-duplicates the keys of each object with a scan per key (quadratic), so a
 * body padded with either holds the event loop for seconds to minutes. Measured on a loaded development machine, with
 * the validation pipe the API uses: an array of a million short strings took 2 to 10 seconds, one object of 200,000
 * keys (a 2 MB body) 77 seconds and one of a million keys (12 MB) 19 minutes. A real request is far below all three
 * bounds, and the walk that applies them costs one pass over what a valid body holds.
 */

/**
 * The longest array a body may hold: the largest ArrayMaxSize any request DTO declares (2,000, on the allowed chats
 * of an API key) rounded up to the next power of ten, and never below 10,000. A spec derives it from the DTOs and
 * fails when a new maximum no longer fits.
 */
export const MAX_BODY_ARRAY_LENGTH = 10_000;

/**
 * The most keys one object in a body may hold. Lower than the array bound because the scan per key makes an object
 * quadratic in its keys: this bound, more than the total, keeps one request near a second. No request field comes
 * near it: the free-form maps are a message's template variables (limited by the 4,096 characters of its text), a
 * webhook's headers (50) and the config objects, where those of plugins and integration instances have the keys their
 * schema declares and a session's is held to 16 KiB with three recognised keys.
 */
export const MAX_BODY_OBJECT_KEYS = 1_000;

/**
 * Array elements and object keys counted across the whole body, so a body split into many small containers is
 * bounded too. About 2.4 times the largest documented request, a bulk send of 100 messages that each tag 1,024
 * mentions (about 104,000), so no documented request comes near it.
 */
export const MAX_BODY_ENTRIES = 250_000;

export type BodyWidthLimit = 'array' | 'object' | 'total';

/** The 400 text, naming the limit that was exceeded. */
export const BODY_WIDTH_MESSAGES: Record<BodyWidthLimit, string> = {
  array: `Request body must not hold an array of more than ${MAX_BODY_ARRAY_LENGTH} items`,
  object: `Request body must not hold an object of more than ${MAX_BODY_OBJECT_KEYS} keys`,
  total: `Request body must not hold more than ${MAX_BODY_ENTRIES} array items and object keys in all`,
};

/**
 * The first width limit a parsed request body exceeds, if any. An oversized array is refused from its length and an
 * oversized object from its key list, before a single element or value is read, so a padded body is refused for
 * about the cost of reading it. The walk recurses once per level, which the nesting bound that runs ahead of it holds
 * to 100.
 */
export function exceededBodyWidth(value: unknown): BodyWidthLimit | undefined {
  let entries = 0;
  const walk = (node: unknown): BodyWidthLimit | undefined => {
    if (typeof node !== 'object' || node === null) return undefined;
    if (Array.isArray(node)) {
      if (node.length > MAX_BODY_ARRAY_LENGTH) return 'array';
      entries += node.length;
      if (entries > MAX_BODY_ENTRIES) return 'total';
      for (const child of node) {
        const exceeded = walk(child);
        if (exceeded) return exceeded;
      }
      return undefined;
    }
    const keys = Object.keys(node);
    if (keys.length > MAX_BODY_OBJECT_KEYS) return 'object';
    entries += keys.length;
    if (entries > MAX_BODY_ENTRIES) return 'total';
    for (const key of keys) {
      const exceeded = walk((node as Record<string, unknown>)[key]);
      if (exceeded) return exceeded;
    }
    return undefined;
  };
  return walk(value);
}
