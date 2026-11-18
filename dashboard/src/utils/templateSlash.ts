import { PLACEHOLDER_PATTERN } from './templatePlaceholders.ts';

/**
 * Slash shortcuts in the chat composer map `/name` onto a session Template.
 * Templates already hold the canned copy; this is only the composer UX.
 */

export interface SlashTemplate {
  id: string;
  name: string;
  body: string;
  header?: string | null;
  footer?: string | null;
}

/** True while the operator is typing a slash command (`/`, `/ho`, …). */
export function isSlashDraft(input: string): boolean {
  return /^\/[^\s]*$/u.test(input);
}

/** The filter token after `/` while drafting (`/ho` → `ho`). */
export function slashDraftFilter(input: string): string {
  if (!isSlashDraft(input)) return '';
  return input.slice(1);
}

export function normalizeTemplateName(name: string): string {
  return name.trim().replace(/^\//, '').toLowerCase();
}

export function filterTemplatesBySlash(
  templates: readonly SlashTemplate[],
  filter: string,
  limit = 8,
): SlashTemplate[] {
  const needle = normalizeTemplateName(filter);
  const ranked = templates
    .map(t => ({ t, key: normalizeTemplateName(t.name) }))
    .filter(({ key }) => (needle ? key.startsWith(needle) || key.includes(needle) : true))
    .sort((a, b) => {
      const aPrefix = needle && a.key.startsWith(needle) ? 0 : 1;
      const bPrefix = needle && b.key.startsWith(needle) ? 0 : 1;
      if (aPrefix !== bPrefix) return aPrefix - bPrefix;
      return a.key.localeCompare(b.key);
    });
  return ranked.slice(0, limit).map(r => r.t);
}

/** Join header / body / footer the way a sent template reads, blank line between parts. */
export function renderTemplateText(template: SlashTemplate): string {
  return [template.header, template.body, template.footer]
    .map(part => (part ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** The placeholders a template send fills, as `text` writes them. */
export function placeholderTokens(text: string): string[] {
  return Array.from(text.matchAll(PLACEHOLDER_PATTERN), match => match[0]);
}

/** Where the first placeholder a template send fills sits in `text`, or null when it holds none. */
export function firstPlaceholder(text: string): { start: number; end: number } | null {
  const match = text.matchAll(PLACEHOLDER_PATTERN).next().value;
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}
