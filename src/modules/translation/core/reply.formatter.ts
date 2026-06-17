// src/modules/translation/core/reply.formatter.ts
import { Translation, GroupState } from './ports';

const FLAGS: Record<string, string> = {
  en: '🇬🇧',
  es: '🇪🇸',
  fr: '🇫🇷',
  de: '🇩🇪',
  pt: '🇵🇹',
  it: '🇮🇹',
  nl: '🇳🇱',
  ru: '🇷🇺',
  ar: '🇸🇦',
  zh: '🇨🇳',
  ja: '🇯🇵',
};

function label(lang: string): string {
  const flag = FLAGS[lang];
  return flag ? `${flag} ${lang.toUpperCase()}` : lang.toUpperCase();
}

export function formatCombinedReply(translations: Translation[]): string {
  return translations.map(t => `${label(t.lang)}: ${t.text}`).join('\n');
}

export function buildHelpText(prefix: string): string {
  return [
    '👋 Translation bot. I am OFF in this group until an admin runs `' + prefix + ' on`.',
    'Commands:',
    `${prefix} on / ${prefix} off — enable/disable translation here`,
    `${prefix} setlang <code> [me|@user|number] — pin a language (default: you)`,
    `${prefix} auto [me|@user|number] — go back to auto-detect`,
    `${prefix} ignore <@user|number> / ${prefix} unignore <@user|number>`,
    `${prefix} grant <@user|number> / ${prefix} revoke <@user|number> — delegate control (admins)`,
    `${prefix} status — show settings`,
    `${prefix} help — this message`,
  ].join('\n');
}

export function formatStatus(state: GroupState, translatorHealthy: boolean): string {
  const lines: string[] = [];
  lines.push(`Translation: ${state.active ? 'ACTIVE' : 'inactive'}`);
  lines.push(`Translator: ${translatorHealthy ? 'ok' : 'unreachable'}`);
  const entries = Object.entries(state.participants);
  if (entries.length === 0) {
    lines.push('No participants learned yet.');
  } else {
    lines.push('Participants:');
    for (const [wid, p] of entries) {
      const lang = p.lang ?? 'unknown';
      const flags = `${p.source}${p.enabled ? '' : ', ignored'}`;
      lines.push(`• ${wid}: ${lang} (${flags})`);
    }
  }
  if (state.delegatedControllers.length > 0) {
    lines.push(`Delegated controllers: ${state.delegatedControllers.join(', ')}`);
  }
  return lines.join('\n');
}
