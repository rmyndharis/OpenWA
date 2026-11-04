import { types } from 'node:util';
import { isSecretName, REDACTED, writtenForm } from '../../common/services/logger.service';

/**
 * Counts what JSON.stringify would write for a worker's log metadata, and stops once the count passes `limit`: one
 * for every value, one per character of a string, a String wrapper or a typed array element, and one per character
 * of a property name. What the logger writes where JSON.stringify would write {} is counted too: the name, message and
 * stack of an Error, and one per entry of a Map or a Set plus the entries themselves, as the arrays it writes for them.
 *
 * JSON.stringify cannot be stopped part way: it lists every key of an object or typed array before it calls a
 * replacer for the first one, and it writes a shared reference out again at every use. So the size of the text has
 * to be bounded before it runs. A shared reference is counted at every use, and so is a property name, which is
 * written at every use of its object.
 *
 * The count can be higher than the length of the text. A property that JSON.stringify skips (undefined, a function,
 * a symbol) is counted as if it were written, and so is the value under a credential key, which is written as the
 * marker. A metadata whose count passes `limit` is replaced by the size marker whatever its text would measure; for
 * data that is plain JSON without a credential key the count never exceeds the length of the text, so a count past
 * `limit` means a longer text.
 */
export function countMetaValues(meta: unknown, limit: number): number {
  let count = 0;
  const open = new Set<object>();
  // An object is walked by its own enumerable keys, an array by its elements, a Map or a Set by the list of its entries.
  const frames: Array<{ node: object; keys: string[] | null; list: unknown[] | null; length: number; next: number }> =
    [];
  const visit = (value: unknown): void => {
    count++;
    if (typeof value === 'string') count += value.length;
    if (typeof value !== 'object' || value === null) return;
    // A cycle: JSON.stringify refuses it, so there is nothing more to count.
    if (open.has(value)) return;
    if (ArrayBuffer.isView(value)) {
      count += (value as { length?: number }).length ?? 0;
      return;
    }
    let list = Array.isArray(value) ? (value as unknown[]) : null;
    // Brand checks, like the String wrapper's below, so a value made in another realm counts too.
    if (types.isMap(value) || types.isSet(value)) {
      count += value.size;
      // Listed only once the number of its entries fits.
      if (count > limit) return;
      list = Array.from(value as Iterable<unknown>);
    }
    // A String wrapper is written as its text, and its own properties are its characters, one per index. Its brand
    // is checked rather than instanceof, so a wrapper made in another realm counts too.
    if (Object.prototype.toString.call(value) === '[object String]') {
      count += (value as { length: number }).length;
      return;
    }
    open.add(value);
    const keys = list
      ? null
      : types.isNativeError(value)
        ? [...new Set(['name', 'message', 'stack', ...Object.keys(value)])]
        : Object.keys(value);
    frames.push({ node: value, keys, list, length: (keys ?? list ?? []).length, next: 0 });
  };
  visit(meta);
  while (frames.length > 0 && count <= limit) {
    const frame = frames[frames.length - 1];
    if (frame.next < frame.length) {
      const index = frame.next++;
      if (frame.keys) {
        count += frame.keys[index].length;
        visit((frame.node as Record<string, unknown>)[frame.keys[index]]);
      } else {
        visit((frame.list as unknown[])[index]);
      }
    } else {
      open.delete(frame.node);
      frames.pop();
    }
  }
  return count;
}

/**
 * The JSON text the logger writes for a worker's log metadata: every object in the form the logger's copy writes it
 * (writtenForm), and the value of a credential key as the marker. Each object is rendered once, so one that holds
 * itself is a cycle JSON.stringify refuses like any other, and a BigInt, boxed or not, is refused wherever it is: its
 * text is never built on the host. Run only on a meta whose count fits the limit.
 */
export function metaText(meta: unknown): string | undefined {
  const rendered = new Map<object, unknown>();
  return JSON.stringify(meta, function (this: Record<string, unknown>, key: string, value: unknown): unknown {
    // Read from the holder: JSON.stringify has already put what a Date's toJSON returns (null for an invalid one) in
    // its place.
    const raw: unknown = this[key];
    if (!Array.isArray(this) && isSecretName(key)) return REDACTED;
    if (typeof raw !== 'object' || raw === null) return value;
    if (!rendered.has(raw)) rendered.set(raw, writtenForm(raw));
    return rendered.get(raw);
  });
}
