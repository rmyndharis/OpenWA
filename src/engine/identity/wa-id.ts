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

/**
 * Domain to kind. `c.us` and `s.whatsapp.net` are one entity in two dialects.
 *
 * `hosted` and `hosted.lid` are two more dialects of the same two entities, not entities of their
 * own: they are the Meta-hosted forms WhatsApp issues and Baileys decodes off the wire
 * (`WAJIDDomains.HOSTED` = 128, `HOSTED_LID` = 129). The user-part is the SAME account either way,
 * which the library states by folding them itself on every inbound message (`cleanMessage`:
 * `<n>@hosted` becomes `<n>@s.whatsapp.net`, `<lid>@hosted.lid` becomes `<lid>@lid`) and by treating
 * `isHostedPnUser` as `isPnUser` throughout its history handling.
 *
 * So they fold here too. A separate kind would split one person's history in two: rows arrive under
 * the plain dialect (Baileys already rewrote them) while a caller filtering by the hosted id we
 * published would match none of them.
 */
const DOMAIN_KINDS = new Map<string, WaIdKind>([
  ['c.us', 'user'],
  ['s.whatsapp.net', 'user'],
  ['lid', 'lid'],
  ['hosted', 'user'],
  ['hosted.lid', 'lid'],
  ['g.us', 'group'],
  ['newsletter', 'newsletter'],
  ['broadcast', 'broadcast'],
]);

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
  if (lower.indexOf('@') !== at || !local) {
    return { kind: 'unknown', userPart: '', raw };
  }
  const kind: WaIdKind = DOMAIN_KINDS.get(domain) ?? 'unknown';
  return { kind, userPart: local, device, raw };
}

/**
 * The user-part of every id that names a person: a phone number or a lid, both digits-only. The
 * floor rules out `0`, `-1` and the empty string, none of which is a WhatsApp id.
 */
const NUMERIC_ID = /^\d{5,}$/;

/**
 * Whether a string names an individual in a qualified dialect: `<phone>@c.us` (and its raw-protocol
 * twin `@s.whatsapp.net`), `<lid>@lid`, or the Meta-hosted dialect of either. A `:<device>` suffix is fine — {@link parseWaId} strips it.
 *
 * **The domain alone is not enough.** `parseWaId` classifies anything ending in `@c.us` as a user, so
 * a check that stops at the kind accepts `NOT A USER@c.us` and `@c.us`. Those still reach WhatsApp
 * Web's page-side `createWid`, which throws an error the minified bundle reports without a name, and
 * the caller gets the undiagnosable 500 this check exists to prevent — reproduced against a live
 * session. The user-part has to look like a WhatsApp id too (#1220, and #1068 before it).
 */
export function isIndividualWid(value: string): boolean {
  const { kind, userPart } = parseWaId(value.trim());
  return (kind === 'user' || kind === 'lid') && NUMERIC_ID.test(userPart);
}

/**
 * Whether a string can address an individual participant of a group: an individual WID, or a bare
 * phone number accepted for convenience and qualified by {@link toParticipantWid}. A group id is
 * rejected — a group cannot be a member of a group — as is anything else.
 */
export function isAddressableParticipant(value: string): boolean {
  const trimmed = value.trim();
  return isIndividualWid(trimmed) || NUMERIC_ID.test(trimmed);
}

/**
 * Qualify a bare number to the neutral `@c.us` dialect, and reduce an individual id to its neutral
 * form (`<phone>@c.us` or `<lid>@lid`: lowercased, `:device` suffix dropped, the `s.whatsapp.net`
 * and hosted dialects folded). {@link isIndividualWid} accepts every one of those variants, so the id
 * handed to the engine has to be the one a group's participant list is keyed by, or a real member is
 * reported as not a member. A lid is not resolved: it stays a lid. Anything else passes through verbatim.
 *
 * Deliberately keyed on the bare-number shape rather than on the absence of `@`: the old rule
 * (`p.includes('@') ? p : p + '@c.us'`) minted an id out of ANY un-domained string, so `abc` became
 * `abc@c.us` — a well-formed id naming nobody.
 */
export function toParticipantWid(value: string): string {
  const trimmed = value.trim();
  if (NUMERIC_ID.test(trimmed)) return `${trimmed}@c.us`;
  return isIndividualWid(trimmed) ? toNeutralJid(trimmed) : trimmed;
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

/** User-facing chat kind. The engine-neutral, consumer-visible vocabulary (never raw WaIdKind). */
export type ChatKind = 'individual' | 'group' | 'channel' | 'status' | 'broadcast' | 'unknown';

/**
 * Map any WhatsApp JID to its user-facing chat kind. `lid` folds into `individual` (a lid is a
 * privacy dialect of a user); `newsletter` surfaces as `channel`. Pure wrapper over {@link parseWaId}.
 */
export function chatKind(jid: string): ChatKind {
  switch (parseWaId(jid).kind) {
    case 'user':
    case 'lid':
      return 'individual';
    case 'group':
      return 'group';
    case 'newsletter':
      return 'channel';
    case 'status':
      return 'status';
    case 'broadcast':
      return 'broadcast';
    default:
      return 'unknown';
  }
}
