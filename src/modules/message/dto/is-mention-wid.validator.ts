import { ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { isIndividualWid } from '../../../engine/identity/wa-id';

/**
 * Whether a string can address an individual in a `mentions` array.
 *
 * A mention names a person, so only the two individual dialects are accepted: `<phone>@c.us` (and
 * its raw-protocol twin `<phone>@s.whatsapp.net`) and `<lid>@lid`, each with a numeric user-part.
 * A `:<device>` suffix is fine — {@link isIndividualWid} strips it.
 *
 * Rejecting the rest is what keeps a malformed entry out of the engine. Nothing validated the shape
 * before, so a bare number or any other junk string reached WhatsApp Web's `createWid` inside
 * `window.WWebJS.sendMessage`, where the unguarded `mentionedJidList.map(createWid)` threw. The page
 * bundle is minified, so the throw arrived as `Error: t: t` and the caller received
 * `500 Internal server error` — undiagnosable from either end (#1068).
 *
 * The first version of this check tested only the DOMAIN, so `NOT A USER@c.us` still satisfied it and
 * still reached `createWid`. Sharing {@link isIndividualWid} with the group-participant guard closes
 * that in both places at once.
 *
 * Group ids are rejected too: `mentions` is the participant list, and mentioning a group is a
 * separate WhatsApp feature (`groupMentions`) that this API does not expose. A `@g.us` here was
 * never honoured — it just failed later and less clearly.
 */
export function isMentionWid(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return isIndividualWid(value);
}

@ValidatorConstraint({ name: 'isMentionWid', async: false })
export class IsMentionWidConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isMentionWid(value);
  }
  defaultMessage(): string {
    return 'each mentions entry must be an individual WID — <phone>@c.us or <lid>@lid';
  }
}
