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

/**
 * Render a template body by replacing `{{key}}` (canonical) or `{key}` (legacy) placeholders with
 * `vars[key]`.
 *
 * @param body Template text containing `{{key}}` and/or `{key}` placeholders.
 * @param vars Map of placeholder keys to substitution values.
 * @returns The rendered text with known placeholders substituted and unknown placeholders left
 *          literal.
 */
export function renderTemplate(body: string, vars: Record<string, string> = {}): string {
  if (!body) {
    return body;
  }

  return body.replace(PLACEHOLDER_PATTERN, (match, doubleKey: string | undefined, singleKey: string | undefined) => {
    const key = doubleKey ?? singleKey;
    if (key !== undefined && Object.prototype.hasOwnProperty.call(vars, key) && vars[key] != null) {
      return String(vars[key]);
    }
    // Leave unmatched placeholders literal so missing variables stay visible.
    return match;
  });
}
