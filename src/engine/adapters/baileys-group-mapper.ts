import type { GroupMetadata } from '@whiskeysockets/baileys';
import { Group, GroupInfo, GroupParticipant } from '../interfaces/whatsapp-engine.interface';
import { parseWaId, userPart } from '../identity/wa-id';

/**
 * Canonicalizes participant/owner JIDs to the neutral dialect (see wa-id.ts). Defaults to identity so
 * the pure-shape behaviour is unchanged; the adapter supplies the session-store-backed normalizer so
 * group ids share the dialect of inbound message authors (admin/controller recognition relies on this).
 */
type NormalizeJid = (jid: string) => string;
const identity: NormalizeJid = jid => jid;

/**
 * The phone-dialect identity for a participant or owner.
 *
 * A LID-addressed group hands us `<lid>@lid` in `id`/`owner`, and the SAME payload carries the phone
 * twin alongside it (`participant.phoneNumber`, `metadata.ownerPn`). Reading only the lid left the
 * neutral output correct ONLY once the lid→pn mapping had been learned — before that, ids did not
 * match the `@c.us` the session's own contacts and message webhooks emit for the same person, and
 * `number` presented LID digits as an MSISDN. Prefer the twin the server already sent; fall back to
 * the normalizer, which still resolves a learned mapping. WhatsApp withholds `phone_number` for
 * non-contacts, so the fallback is the ordinary case, not an error path.
 */
function preferPhoneDialect(jid: string, phoneTwin: string | undefined, normalizeJid: NormalizeJid): string {
  return normalizeJid(phoneTwin ?? jid);
}

/** The account's own participant row, or undefined when no row can be identified as the account. */
export function findSelfParticipant(
  metadata: GroupMetadata,
  selfJid: string,
  normalizeJid: NormalizeJid,
): GroupMetadata['participants'][number] | undefined {
  // Digits only identify a member within one kind: a lid and a phone number can read the same.
  const self = parseWaId(normalizeJid(selfJid));
  if (!self.userPart || (self.kind !== 'user' && self.kind !== 'lid')) return undefined;
  return metadata.participants.find(p => {
    const participant = parseWaId(preferPhoneDialect(p.id, p.phoneNumber, normalizeJid));
    return participant.kind === self.kind && participant.userPart === self.userPart;
  });
}

function isSelfAdmin(metadata: GroupMetadata, selfJid: string, normalizeJid: NormalizeJid): boolean {
  const admin = findSelfParticipant(metadata, selfJid, normalizeJid)?.admin;
  return admin === 'admin' || admin === 'superadmin';
}

/** Map a Baileys GroupMetadata to the neutral summary {@link Group}. `selfJid` flags whether WE are an admin. */
export function mapBaileysGroup(
  metadata: GroupMetadata,
  selfJid: string,
  normalizeJid: NormalizeJid = identity,
): Group {
  return {
    id: metadata.id,
    name: metadata.subject,
    participantsCount: metadata.participants.length,
    isAdmin: isSelfAdmin(metadata, selfJid, normalizeJid),
    linkedParentJID: metadata.linkedParent ?? null,
  };
}

/** Map a Baileys GroupMetadata to the neutral {@link GroupInfo} (full participant list). */
export function mapBaileysGroupInfo(
  metadata: GroupMetadata,
  normalizeJid: NormalizeJid = identity,
  selfJid?: string,
): GroupInfo {
  const participants: GroupParticipant[] = metadata.participants.map(p => {
    const id = preferPhoneDialect(p.id, p.phoneNumber, normalizeJid);
    return {
      id,
      number: userPart(id),
      name: p.name,
      isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
      isSuperAdmin: p.admin === 'superadmin',
    };
  });
  return {
    id: metadata.id,
    name: metadata.subject,
    description: metadata.desc,
    owner: metadata.owner ? preferPhoneDialect(metadata.owner, metadata.ownerPn, normalizeJid) : metadata.owner,
    createdAt: metadata.creation,
    participants,
    // WhatsApp "announce" = only admins can post. isAnnounce reports the group SETTING; isReadOnly
    // reports what it means for THIS account. Copying announce into both told an admin of an
    // announce-only group that they could not post, in the one field a client uses to disable its
    // composer.
    isAnnounce: metadata.announce,
    isReadOnly: selfJid
      ? Boolean(metadata.announce) && !isSelfAdmin(metadata, selfJid, normalizeJid)
      : metadata.announce,
    announce: metadata.announce,
    locked: metadata.restrict,
    ephemeralSeconds: metadata.ephemeralDuration,
    // Baileys decodes member_add_mode to a boolean where TRUE means all_member_add — the opposite
    // sense to the boolean whatsapp-web.js's types describe, hence the explicit mapping here.
    memberAddMode:
      metadata.memberAddMode === undefined
        ? undefined
        : metadata.memberAddMode
          ? ('all' as const)
          : ('admins' as const),
    linkedParentJID: metadata.linkedParent ?? null,
  };
}
