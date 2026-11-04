/**
 * Shared server-side text template renderer — the single templating helper for the gateway.
 *
 * Substitutes `{{name}}` placeholders (the canonical, Handlebars-style convention) with values from
 * the provided `vars` map. Placeholders whose key is absent from `vars` are left untouched (the
 * literal placeholder is preserved) so missing variables stay visible rather than silently blanked.
 *
 * Legacy single-brace `{name}` placeholders are ALSO substituted, for backward compatibility with
 * the bulk-message API that historically used them. Single-brace is deprecated — prefer `{{name}}`.
 */

// Ordered alternation: the double-brace branch is tried first at each position, so `{{name}}` is
// consumed as a unit and the single-brace branch never sees its interior (no `{{name}}` -> `{value}`
// mangling). The legacy branch keeps the historical shape exactly: `{name}`, word chars only, no
// surrounding whitespace — so existing single-brace bulk content renders bit-for-bit as before.
const PLACEHOLDER_PATTERN = /\{\{\s*([\w.-]+)\s*\}\}|\{(\w+)\}/g;

/** The variable names a template mentions, in order of appearance, read with the syntax the renderer substitutes. */
export function templateVariableNames(body: string): string[] {
  return Array.from(body.matchAll(PLACEHOLDER_PATTERN), match => match[1] ?? match[2]);
}

/** A template that cannot be rendered for a reason the caller can report, such as a value with no text form. */
export class TemplateRenderError extends Error {}

/**
 * The text a placeholder is replaced with, or undefined when it stays literal (key absent or null). A value
 * is turned into text once per render, kept in `seen`: a request may carry an array or object as a variable,
 * and converting a large one for every repeat of its placeholder would cost its size times the repeats.
 */
function substitution(
  vars: Record<string, string>,
  key: string | undefined,
  seen: Map<string, string | undefined>,
): string | undefined {
  if (key === undefined) return undefined;
  if (seen.has(key)) return seen.get(key);
  let text: string | undefined;
  if (Object.prototype.hasOwnProperty.call(vars, key) && vars[key] != null) {
    try {
      text = String(vars[key]);
    } catch {
      // An object without a usable toString, such as `{ toString: 1 }` or a null-prototype object.
      throw new TemplateRenderError(`Variable '${key}' cannot be rendered as text`);
    }
  }
  seen.set(key, text);
  return text;
}

/**
 * Render a template body by replacing `{{key}}` (canonical) or `{key}` (legacy) placeholders with
 * `vars[key]`.
 *
 * @param body Template text containing `{{key}}` and/or `{key}` placeholders.
 * @param vars Map of placeholder keys to substitution values.
 * @returns The rendered text with known placeholders substituted and unknown placeholders left
 *          literal.
 * @throws TemplateRenderError when a value has no text form.
 */
export function renderTemplate(body: string, vars: Record<string, string> = {}): string {
  if (!body || !body.includes('{')) {
    return body;
  }

  // Unmatched placeholders stay literal so missing variables stay visible.
  const seen = new Map<string, string | undefined>();
  return body.replace(
    PLACEHOLDER_PATTERN,
    (match, doubleKey: string | undefined, singleKey: string | undefined) =>
      substitution(vars, doubleKey ?? singleKey, seen) ?? match,
  );
}

/**
 * The exact length of `renderTemplate(body, vars)`, computed without building the result.
 *
 * One placeholder repeated through a small body multiplies a large value (1365 `{a}` fit in a 4 KiB body,
 * and one 393 KB value then renders to half a gigabyte), so a caller with a size limit measures first and
 * refuses an oversized render instead of allocating it and checking afterwards.
 *
 * @throws TemplateRenderError when a value has no text form.
 */
export function renderedLength(body: string, vars: Record<string, string> = {}): number {
  if (!body || !body.includes('{')) {
    return body ? body.length : 0;
  }
  let length = body.length;
  const seen = new Map<string, string | undefined>();
  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) {
    const text = substitution(vars, match[1] ?? match[2], seen);
    if (text !== undefined) length += text.length - match[0].length;
  }
  return length;
}
