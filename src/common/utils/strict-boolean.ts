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
