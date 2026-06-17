// src/modules/translation/core/command.parser.ts
import { ParsedCommand, CommandName, CommandTarget } from './ports';

const COMMANDS: ReadonlySet<string> = new Set<CommandName>([
  'help',
  'status',
  'on',
  'off',
  'setlang',
  'auto',
  'ignore',
  'unignore',
  'grant',
  'revoke',
]);

const NEEDS_TARGET: ReadonlySet<string> = new Set(['setlang', 'auto', 'ignore', 'unignore', 'grant', 'revoke']);

/**
 * Parse a chat message into a control command, or null if it isn't one.
 * Accepts the configured prefix and the `/translate` alias.
 */
export function parseCommand(body: string, prefix: string): ParsedCommand | null {
  const trimmed = body.trim();
  const lower = trimmed.toLowerCase();
  // Check the '/translate' alias BEFORE the configured prefix: a short prefix like
  // '/tr' is a leading substring of '/translate', so testing the prefix first would
  // match '/translate' against '/tr' and strip only two chars. Alias-first avoids that.
  const matched = lower.startsWith('/translate')
    ? '/translate'
    : lower.startsWith(prefix.toLowerCase())
      ? prefix
      : null;
  if (!matched) return null;

  const rest = trimmed.slice(matched.length).trim();
  if (!rest) return null;

  const tokens = rest.split(/\s+/);
  const verb = tokens[0].toLowerCase();
  if (!COMMANDS.has(verb)) return null;

  const name = verb as CommandName;
  const args = tokens.slice(1);

  if (name === 'setlang') {
    const lang = args[0]?.toLowerCase();
    if (!lang) return null;
    return { name, lang, target: parseTarget(args.slice(1)) };
  }

  if (NEEDS_TARGET.has(name)) {
    return { name, target: parseTarget(args) };
  }

  return { name };
}

function parseTarget(args: string[]): CommandTarget {
  const raw = args[0];
  if (!raw || raw.toLowerCase() === 'me') return { kind: 'me' };
  if (raw.startsWith('@')) return { kind: 'mention' };
  return { kind: 'number', number: raw.replace(/[^0-9]/g, '') };
}
