/** A word of a PascalCase name: a run of capitals (an acronym, kept as written) or a capital with its lowercase tail. */
const NAME_WORD = /[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g;

/**
 * A human title for a tool name, used when the tool sets none: the PascalCase name split into words, in
 * sentence case. `MessageSendText` becomes `Message send text`; an acronym stays as written
 * (`SessionGetQRCode` becomes `Session get QR code`).
 */
export function deriveToolTitle(name: string): string {
  const words = name.match(NAME_WORD) ?? [];
  return words
    .map((word, index) => {
      const acronym = word.length > 1 && word === word.toUpperCase() && /[A-Z]{2}/.test(word);
      if (acronym) return word;
      return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word.toLowerCase();
    })
    .join(' ');
}
