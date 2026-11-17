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

/** `/hola` or `/hola ` → `hola`. Anything else is not a slash shortcut. */
export function slashQuery(input: string): string | null {
  const trimmed = input.trim();
  const match = /^\/([^\s/]+)$/u.exec(trimmed);
  return match ? match[1] : null;
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

export function findTemplateBySlashName(templates: readonly SlashTemplate[], query: string): SlashTemplate | undefined {
  const needle = normalizeTemplateName(query);
  if (!needle) return undefined;
  return templates.find(t => normalizeTemplateName(t.name) === needle);
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

/** Join header / body / footer the way send-template delivers them. */
export function renderTemplateText(template: SlashTemplate): string {
  return [template.header, template.body, template.footer]
    .map(part => (part ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}

const VAR_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function templateVariables(template: SlashTemplate): string[] {
  const text = renderTemplateText(template);
  const names = new Set<string>();
  for (const match of text.matchAll(VAR_RE)) names.add(match[1]);
  return [...names];
}

export function templateNeedsVariables(template: SlashTemplate): boolean {
  return templateVariables(template).length > 0;
}
