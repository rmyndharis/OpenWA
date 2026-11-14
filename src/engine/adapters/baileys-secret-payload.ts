import { createDecipheriv, hkdfSync } from 'node:crypto';

/**
 * WhatsApp sends a contact's message edit, and a reaction in some chats, encrypted under the secret the
 * original message carries (`messageContextInfo.messageSecret`) instead of as the plain protocol or
 * reaction message the library understands. The library decrypts event RSVPs on its own and exports
 * `decryptPollVote` for poll updates, leaving edits and reactions to reach the adapter as an opaque
 * `secretEncryptedMessage` and `encReactionMessage`.
 *
 * The key is derived as the library derives a poll vote's or an RSVP's: HKDF-SHA256 over the secret
 * with an all-zero salt and `<target id><target author><modifier><label>` as the info. The payload is
 * AES-256-GCM, and unlike those two it carries no additional data. Edit and reaction payloads decrypt
 * to a `Message` holding the protocol message and a `ReactionMessage` respectively.
 */
export type SecretPayloadKind = 'edit' | 'reaction';

const LABELS: Record<SecretPayloadKind, string> = { edit: 'Message Edit', reaction: 'Enc Reaction' };
const SECRET_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** A message holds at most a text of about 64 KiB, and the largest sample payloads are a few KiB. */
const MAX_PAYLOAD_BYTES = 256 * 1024;
/** Ids one party can be written as (phone and lid, with the account's own forms); a few at most. */
const MAX_FORMS = 4;

export interface SecretPayloadInput {
  kind: SecretPayloadKind;
  /** The `messageSecret` of the message being changed. */
  secret: Uint8Array;
  iv: Uint8Array;
  /** Ciphertext followed by its 16-byte authentication tag. */
  payload: Uint8Array;
  /** Id of the message being changed. */
  targetId: string;
  /** The forms (`user@server`, no device) the target's author may be written as. */
  targetAuthors: readonly string[];
  /** The forms the sender of the edit or reaction may be written as. */
  modifiers: readonly string[];
}

/**
 * The plaintext of an edit or reaction payload, or undefined when no pair of the candidate ids
 * authenticates it. Never throws: a payload that is not for this message, or has been altered, is
 * simply not readable.
 */
export function decryptSecretPayload(input: SecretPayloadInput): Buffer | undefined {
  const { kind, secret, iv, payload, targetId } = input;
  if (!targetId || secret.length !== SECRET_BYTES || iv.length !== IV_BYTES) return undefined;
  if (payload.length <= TAG_BYTES || payload.length > MAX_PAYLOAD_BYTES) return undefined;
  const authors = [...new Set(input.targetAuthors)].slice(0, MAX_FORMS);
  const modifiers = [...new Set(input.modifiers)].slice(0, MAX_FORMS);
  const salt = Buffer.alloc(32);
  const tag = Buffer.from(payload.subarray(payload.length - TAG_BYTES));
  const body = Buffer.from(payload.subarray(0, payload.length - TAG_BYTES));
  for (const author of authors) {
    for (const modifier of modifiers) {
      const info = Buffer.from(`${targetId}${author}${modifier}${LABELS[kind]}`);
      try {
        const key = Buffer.from(hkdfSync('sha256', secret, salt, info, 32));
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]);
      } catch {
        // Not this pair of ids: the authentication tag did not verify.
      }
    }
  }
  return undefined;
}

/**
 * Bytes of a proto field in either shape the adapter meets: a live message carries a `Uint8Array`,
 * and a message read back from the store carries its base64 text (or a `{ type: 'Buffer', data }`
 * pair from an older row).
 */
export function bytesOf(value: unknown): Buffer | undefined {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return value ? Buffer.from(value, 'base64') : undefined;
  if (value && typeof value === 'object') {
    const { type, data } = value as { type?: unknown; data?: unknown };
    if (type === 'Buffer') {
      if (Array.isArray(data)) return Buffer.from(data as number[]);
      if (typeof data === 'string') return Buffer.from(data, 'base64');
    }
  }
  return undefined;
}

const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
  'associatedChildMessage',
  'groupStatusMessage',
  'groupStatusMessageV2',
] as const;

/** The secret a message carries, at the top level or inside the wrappers a disappearing chat adds. */
export function messageSecretOf(message: unknown): Buffer | undefined {
  let current = message as Record<string, unknown> | null | undefined;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth++) {
    const context = current.messageContextInfo as { messageSecret?: unknown } | null | undefined;
    const secret = bytesOf(context?.messageSecret);
    if (secret) return secret;
    const wrapper = WRAPPERS.find(name => current?.[name]);
    current = wrapper ? (current[wrapper] as { message?: Record<string, unknown> | null }).message : undefined;
  }
  return undefined;
}

/** `user@server` with any device suffix (`:12`) removed: the form a message secret is keyed by. */
export function withoutDevice(jid: string): string {
  return jid.replace(/:\d+(?=@)/, '');
}

/**
 * The forms a message's sender may be written as in its key: the account's own ids for a message it
 * sent, else the group participant (and its phone or lid twin), else the 1:1 chat and its twin.
 */
export function senderForms(
  key: {
    remoteJid?: string | null;
    remoteJidAlt?: string | null;
    participant?: string | null;
    participantAlt?: string | null;
    fromMe?: boolean | null;
  },
  own: readonly string[],
): string[] {
  const forms =
    key.fromMe === true
      ? [...own]
      : key.participant
        ? [key.participant, key.participantAlt]
        : [key.remoteJid, key.remoteJidAlt];
  const named = forms.filter((jid): jid is string => !!jid && !jid.endsWith('@g.us') && !jid.endsWith('@broadcast'));
  return [...new Set(named.map(withoutDevice))].slice(0, MAX_FORMS);
}
