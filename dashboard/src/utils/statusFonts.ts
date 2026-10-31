// WhatsApp's text-status font ids as the protocol names them (ExtendedTextMessage.FontType): 0 SYSTEM, 1 SYSTEM_TEXT,
// 2 FB_SCRIPT, 6 SYSTEM_BOLD, 7 MORNINGBREEZE_REGULAR, 8 CALISTOGA_REGULAR, 9 EXO2_EXTRABOLD, 10 COURIERPRIME_BOLD.
// 3 to 5 are not part of the enum and the gateway rejects them; older clients still emit them on a received status,
// so the preview below keeps a face for them. The faces are approximations with generic families and weights, since
// the real ones are proprietary.
interface Face {
  family?: string;
  weight?: number;
}

interface StatusFont extends Face {
  id: number;
  // The picker label in plain language; the product names stay as the protocol has them.
  labelKey: string;
}

export const STATUS_FONTS: readonly StatusFont[] = [
  { id: 0, labelKey: 'chats.status.fonts.system' },
  { id: 1, labelKey: 'chats.status.fonts.systemText', family: 'system-ui, sans-serif' },
  { id: 2, labelKey: 'chats.status.fonts.script', family: 'cursive' },
  { id: 6, labelKey: 'chats.status.fonts.bold', weight: 700 },
  { id: 7, labelKey: 'chats.status.fonts.morningBreeze', family: 'cursive' },
  { id: 8, labelKey: 'chats.status.fonts.calistoga', family: 'serif' },
  { id: 9, labelKey: 'chats.status.fonts.exo2', family: 'sans-serif', weight: 800 },
  { id: 10, labelKey: 'chats.status.fonts.courierPrime', family: 'monospace', weight: 700 },
];

// Legacy ids 3 to 5 of an older client's status: shown, never offered.
const LEGACY_FONT_FACES: Record<number, Face> = {
  3: { family: 'fantasy' },
  4: { family: 'serif' },
  5: { family: 'ui-rounded, system-ui, sans-serif' },
};

// whatsapp-web.js posts an id above this one in the default font (Utils.js clamps fontStyle to 0 to 7).
export const WWEBJS_STATUS_FONT_MAX = 7;

/** The fonts the composer offers for an engine: whatsapp-web.js ignores 8 to 10, so it is not offered them. */
export const statusFontsFor = (engineType: string | null): readonly StatusFont[] =>
  engineType === 'whatsapp-web.js' ? STATUS_FONTS.filter(f => f.id <= WWEBJS_STATUS_FONT_MAX) : STATUS_FONTS;

/** Inline style for a status item's font id; {} when unstyled/unknown. */
export const statusFontStyle = (font?: number): { fontFamily?: string; fontWeight?: number } => {
  if (font === undefined) return {};
  const slot: Face | undefined = STATUS_FONTS.find(f => f.id === font) ?? LEGACY_FONT_FACES[font];
  if (!slot) return {};
  return {
    ...(slot.family ? { fontFamily: slot.family } : {}),
    ...(slot.weight ? { fontWeight: slot.weight } : {}),
  };
};
