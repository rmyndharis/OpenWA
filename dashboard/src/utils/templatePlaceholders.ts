/**
 * The gateway's renderer pattern (PLACEHOLDER_PATTERN in src/common/utils/template-render.ts), kept verbatim.
 * One copy for the Templates page and the chat composer: a send fills `{{customer.name}}`, `{{order-id}}`
 * and the legacy `{name}` form, so neither place may keep a narrower pattern of its own.
 */
export const PLACEHOLDER_PATTERN = /\{\{\s*([\w.-]+)\s*\}\}|\{(\w+)\}/g;

export interface PlaceholderSource {
  header?: string | null;
  body?: string | null;
  footer?: string | null;
}

/** The variables a send fills, each once, with the form it is written in: `{{key}}`, or `{key}` for the legacy form. */
export function extractPlaceholders(template: PlaceholderSource): Array<{ key: string; token: string }> {
  const source = [template.header, template.body, template.footer].filter(Boolean).join('\n');
  const tokens = new Map<string, string>();
  for (const [, doubleKey, singleKey] of source.matchAll(PLACEHOLDER_PATTERN)) {
    const key = doubleKey ?? singleKey;
    if (!tokens.has(key)) tokens.set(key, doubleKey !== undefined ? `{{${key}}}` : `{${key}}`);
  }
  return [...tokens.keys()].sort().map(key => ({ key, token: tokens.get(key)! }));
}
