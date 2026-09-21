export const ALLOWED_CHAT_ID_PATTERN = /^(?:\d{10,15}|\d{10,15}@(c\.us|s\.whatsapp\.net|lid)|[0-9-]+@g\.us)$/;
export const ALLOWED_CHAT_ID_PATTERN_SOURCE =
  '^(?:\\d{10,15}|\\d{10,15}@(c\\.us|s\\.whatsapp\\.net|lid)|[0-9-]+@g\\.us)$';

export const ALLOWED_CHAT_ID_DESCRIPTION =
  'WhatsApp chat identifier: digits-only phone, an individual @c.us/@s.whatsapp.net/@lid JID, or a group @g.us JID.';

export function normalizeAllowedChatId(value: string): { domain: string | null; local: string; digits: string } {
  const normalized = value.trim().toLowerCase();
  const separator = normalized.indexOf('@');
  const local = (separator >= 0 ? normalized.slice(0, separator) : normalized).replace(/^\+/, '');
  return {
    domain: separator >= 0 ? normalized.slice(separator + 1) : null,
    local,
    digits: local.replace(/\D/g, ''),
  };
}

export function isChatAllowedByScope(chatId: string, allowedChats: string[] | null, phone?: string | null): boolean {
  if (!allowedChats?.length) return true;
  const chat = normalizeAllowedChatId(chatId);
  const phoneCandidate = phone ? normalizeAllowedChatId(phone) : null;
  return allowedChats.some(value => {
    const allowed = normalizeAllowedChatId(value);
    if (allowed.domain) return allowed.domain === chat.domain && allowed.local === chat.local;
    return Boolean(
      allowed.digits &&
      (allowed.digits === chat.digits || (phoneCandidate && allowed.digits === phoneCandidate.digits)),
    );
  });
}
