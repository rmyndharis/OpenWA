import type { GroupMetadata } from '@whiskeysockets/baileys';
import { Group, GroupInfo, GroupParticipant } from '../interfaces/whatsapp-engine.interface';
import { userPart } from '../identity/wa-id';

/**
 * Canonicalizes participant/owner JIDs to the neutral dialect (see wa-id.ts). Defaults to identity so
 * the pure-shape behaviour is unchanged; the adapter supplies the session-store-backed normalizer so
 * group ids share the dialect of inbound message authors (admin/controller recognition relies on this).
 */
type NormalizeJid = (jid: string) => string;
const identity: NormalizeJid = jid => jid;

function isSelfAdmin(metadata: GroupMetadata, selfJid: string, normalizeJid: NormalizeJid): boolean {
  const self = userPart(normalizeJid(selfJid));
  return metadata.participants.some(
    p => userPart(normalizeJid(p.id)) === self && (p.admin === 'admin' || p.admin === 'superadmin'),
  );
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
export function mapBaileysGroupInfo(metadata: GroupMetadata, normalizeJid: NormalizeJid = identity): GroupInfo {
  const participants: GroupParticipant[] = metadata.participants.map(p => {
    const id = normalizeJid(p.id);
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
    owner: metadata.owner ? normalizeJid(metadata.owner) : metadata.owner,
    createdAt: metadata.creation,
    participants,
    // WhatsApp "announce" = only admins can post; surface as both isAnnounce and (members') isReadOnly (best-effort).
    isAnnounce: metadata.announce,
    isReadOnly: metadata.announce,
    announce: metadata.announce,
    locked: metadata.restrict,
    ephemeralSeconds: metadata.ephemeralDuration,
    linkedParentJID: metadata.linkedParent ?? null,
  };
}
