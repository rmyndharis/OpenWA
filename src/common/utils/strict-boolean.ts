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
 * (`src/main.ts`), whose scalars are always strings.
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
