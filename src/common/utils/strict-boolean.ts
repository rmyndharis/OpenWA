import { Transform, TransformFnParams } from 'class-transformer';

/**
 * Accept a boolean only when the caller spelled one unambiguously, and leave anything else
 * untouched so `@IsBoolean()` rejects it.
 *
 * The global `ValidationPipe` runs with `transformOptions.enableImplicitConversion: true`
 * (`src/config/app-validation.ts`). For a `boolean`-typed property that makes class-transformer
 * cast *any* non-empty string to `true` — `'false'`, `'0'` and `'no'` all become `true` — and it
 * happens before `@IsBoolean()` ever runs, so the validator can never reject it. Requests reach a
 * DTO as strings whenever the body arrives through the global `express.urlencoded` parser
 * (`src/configure-app.ts`), whose leaf values are always strings.
 *
 * The callback deliberately reads `obj[key]` (the untouched plain source) instead of `value`:
 * implicit conversion has already run by the time a `@Transform` callback is invoked, so `value`
 * is the coerced `true` and the caller's original spelling is only still recoverable from `obj`.
 *
 * Only exact `'true'` / `'false'` are mapped. Anything else keeps its original value and fails
 * validation — for a permission flag, an ambiguous spelling is safer refused than guessed.
 *
 * Because it reads `obj` and never `value`, it does NOT compose: class-transformer threads each
 * `@Transform` result into the next, and this one discards whatever a previously-registered
 * transform produced. Do not stack another `@Transform` on a property that uses it.
 */
export function coerceStrictBoolean({ obj, key }: Pick<TransformFnParams, 'obj' | 'key'>): unknown {
  const raw = (obj as Record<string, unknown> | undefined)?.[key];
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

/** Property decorator form of {@link coerceStrictBoolean}. Pair it with `@IsBoolean()`. */
export const ToStrictBoolean = (): PropertyDecorator => Transform(coerceStrictBoolean);

/**
 * The numeric counterpart, for the same reason and with the same `obj[key]` trick.
 *
 * Implicit conversion applies `Number(value)` to a `number`-typed property, and `Number('')` and
 * `Number('  ')` are both `0` — so an empty form field arrives as a real, valid zero rather than
 * being rejected as missing. On a field where `0` is itself meaningful (a disappearing-message
 * timer, where `0` means "off") that silently performs an action the caller never asked for.
 *
 * Only a genuine number or a string that is entirely a finite number is converted. Everything else
 * keeps its original value and fails `@IsInt()`/`@IsNumber()`.
 */
export function coerceStrictNumber({ obj, key }: Pick<TransformFnParams, 'obj' | 'key'>): unknown {
  const raw = (obj as Record<string, unknown> | undefined)?.[key];
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string' || raw.trim() === '') return raw;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : raw;
}

/** Property decorator form of {@link coerceStrictNumber}. Pair it with `@IsInt()` / `@IsNumber()`. */
export const ToStrictNumber = (): PropertyDecorator => Transform(coerceStrictNumber);

/**
 * The string counterpart, for the same reason and with the same `obj[key]` trick.
 *
 * Implicit conversion applies `String(value)` to a `string`-typed property, so a boolean or an object is
 * rewritten into its string form (`true`, `[object Object]`) before `@IsString()` runs, and the route
 * accepts it. An integration whose expression yields an object then sent the customer the literal text
 * `[object Object]`. An array is the one value left alone, so the same field already answered 400 for it.
 *
 * A number keeps the conversion: clients that hold a phone number or a chat id as a number post it as one,
 * and every release has read it as its decimal string. Every other value is kept as the caller sent it,
 * so `@IsString()` and the other string validators refuse it. A string is never altered, so a
 * form-encoded body is unaffected.
 */
export function coerceStrictString({ obj, key }: Pick<TransformFnParams, 'obj' | 'key'>): unknown {
  const raw = (obj as Record<string, unknown> | undefined)?.[key];
  return typeof raw === 'number' ? String(raw) : raw;
}

/** Property decorator form of {@link coerceStrictString}. Pair it with `@IsString()`. */
export const ToStrictString = (): PropertyDecorator => Transform(coerceStrictString);

/**
 * The array counterpart. For an `Array`-typed property class-transformer builds `new Array()` and copies
 * the keys of an object onto it, so `{"628111@c.us":true}` arrives as an EMPTY array that `@IsArray()`
 * accepts. Where an empty list means "no restriction" (the key lists `allowedChats`, `allowedSessions` and
 * `allowedIps`), a map sent by mistake created a key with no restriction at all.
 *
 * A JSON array keeps the converted value class-transformer built, element types and all, so it reads
 * exactly as before. Anything else is kept as the caller sent it, so `@IsArray()` refuses it.
 */
export function coerceStrictArray({ value, obj, key }: Pick<TransformFnParams, 'value' | 'obj' | 'key'>): unknown {
  const raw = (obj as Record<string, unknown> | undefined)?.[key];
  return Array.isArray(raw) ? value : raw;
}

/** Property decorator form of {@link coerceStrictArray}. Pair it with `@IsArray()`. */
export const ToStrictArray = (): PropertyDecorator => Transform(coerceStrictArray);
