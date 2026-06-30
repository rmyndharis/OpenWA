/**
 * Engine-neutral WhatsApp identity handling.
 *
 * WhatsApp addresses the same entity through several dialects:
 *   - `<phone>@c.us`           a user, addressed by phone (whatsapp-web.js dialect)
 *   - `<phone>@s.whatsapp.net`  the SAME user, in the raw protocol dialect (Baileys)
 *   - `<lid>@lid`               a user addressed by a privacy id (LID); the number is NOT a phone
 *   - `<id>@g.us`               a group
 *   - `status@broadcast`        the status/stories pseudo-JID
 *   - `<id>@newsletter`         a channel; `<id>@broadcast` a broadcast list
 *   - any of the above may carry a `:<device>` multi-device suffix
 *
 * The engine boundary is an anti-corruption layer: adapters reduce all of that to the NEUTRAL dialect
 * the application layer sees, so app code never has to know which engine produced an id. The neutral
 * dialect is intentionally small:
 *   - `<phone>@c.us`  a user known by phone        (the common case; @s.whatsapp.net folds into this)
 *   - `<id>@g.us`     a group
 *   - `<lid>@lid`     a user known ONLY by privacy id - phone genuinely unknown (a first-class state)
 *   - `status@broadcast` / `<id>@newsletter` / `<id>@broadcast`  special channels
 *   - never `@s.whatsapp.net`, never a `:device` suffix
 *
 * Resolution rule: prefer `@c.us` (resolve a lid to its phone when the mapping is known); fall back to
 * `@lid` only when it can't be resolved. An unresolved lid is NOT pretended to be a phone.
 */

export type WaIdKind = 'user' | 'group' | 'lid' | 'status' | 'newsletter' | 'broadcast' | 'unknown';

/** Domains that denote a phone-addressed user (the two are the same entity, different dialects). */
const USER_DOMAINS = new Set(['c.us', 's.whatsapp.net']);

export interface ParsedWaId {
  kind: WaIdKind;
  /** The local part with the device suffix and domain stripped (phone digits, lid number, or group id). */
  userPart: string;
  /** The multi-device suffix (`:N`), when present. */
  device?: string;
  /** The original JID, verbatim. */
  raw: string;
}

/** The local part of a JID: domain and `:device` suffix stripped (`628:12@s.whatsapp.net` -> `628`). */
export function userPart(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

/** Classify any WhatsApp JID into its neutral kind + parts, without resolving anything. */
export function parseWaId(jid: string): ParsedWaId {
  const raw = jid;
  const lower = jid.trim().toLowerCase();
  if (lower === 'status@broadcast') {
    return { kind: 'status', userPart: 'status', raw };
  }
  const at = lower.lastIndexOf('@');
  if (at === -1) {
    return { kind: 'unknown', userPart: lower, raw };
  }
  const domain = lower.slice(at + 1);
  const [local, device] = lower.slice(0, at).split(':');
  const kind: WaIdKind = USER_DOMAINS.has(domain)
    ? 'user'
    : domain === 'g.us'
      ? 'group'
      : domain === 'lid'
        ? 'lid'
        : domain === 'newsletter'
          ? 'newsletter'
          : domain === 'broadcast'
            ? 'broadcast'
            : 'unknown';
  return { kind, userPart: local, device, raw };
}

/**
 * Reduce any WhatsApp JID to the neutral dialect (see the module contract above). `resolvePhone` maps a
 * lid to its phone user-part when the engine knows the mapping; an unresolvable lid is kept as
 * `<lid>@lid`. Idempotent on an already-neutral id. An unrecognized format is passed through unchanged.
 */
export function toNeutralJid(jid: string, resolvePhone?: (jid: string) => string | null): string {
  if (!jid) {
    return jid;
  }
  const parsed = parseWaId(jid);
  switch (parsed.kind) {
    case 'user':
      return `${parsed.userPart}@c.us`;
    case 'group':
      return `${parsed.userPart}@g.us`;
    case 'lid': {
      const phone = resolvePhone?.(jid);
      return phone ? `${phone}@c.us` : `${parsed.userPart}@lid`;
    }
    case 'status':
      return 'status@broadcast';
    case 'newsletter':
      return `${parsed.userPart}@newsletter`;
    case 'broadcast':
      return `${parsed.userPart}@broadcast`;
    default:
      return jid;
  }
}

/**
 * True for a channel/newsletter JID (`<id>@newsletter`). whatsapp-web.js resolves these to a `Channel`,
 * which — unlike a `Chat` — has no per-chat presence (`sendStateTyping`/`sendStateRecording`/`clearState`),
 * `markUnread`, `delete`, or `getLabels`. The wwebjs adapter uses this to skip those Chat-only operations
 * instead of letting `getChatById` hand back a `Channel` that throws `TypeError`. Broadcast lists and
 * `status@broadcast` resolve to a real `Chat` and are intentionally NOT matched here.
 */
export function isChannelJid(jid: string): boolean {
  return parseWaId(jid).kind === 'newsletter';
}
