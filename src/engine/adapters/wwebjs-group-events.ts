import { type GroupNotification } from 'whatsapp-web.js';
import { GroupEvent } from '../interfaces/whatsapp-engine.interface';
import { SerializedWid } from '../types/whatsapp-web-js.types';

/**
 * Interpret the on/off value a group settings notification carries in `body` ('on'/'true' → true,
 * 'off'/'false' → false). Undefined when the body holds anything else (e.g. a rendered template
 * string), in which case the caller emits the update without that change rather than guess.
 */
function parseWwebjsOnOff(body: string): boolean | undefined {
  const v = body.trim().toLowerCase();
  if (v === 'on' || v === 'true') return true;
  if (v === 'off' || v === 'false') return false;
  return undefined;
}

/**
 * Reduce a `group_update` GroupNotification to the neutral `changes` delta. `subject`/`description`
 * carry the new value in `body`; `announce`/`restrict` encode the new setting as on/off text (the
 * latter maps to the neutral `locked`). Anything uninterpretable — a `picture` change, or a WA Web
 * build that stops putting the value in `body` — yields an empty delta: the occurrence is still
 * emitted, just without fields we would be guessing at. Compared as strings because the runtime
 * gp2 subtypes can exceed the GroupNotificationTypes enum (e.g. a 'locked' rename of 'restrict').
 */
export function wwebjsGroupUpdateChanges(notification: GroupNotification): NonNullable<GroupEvent['changes']> {
  const body = typeof notification.body === 'string' ? notification.body : '';
  switch (String(notification.type)) {
    case 'subject':
      return { subject: body };
    case 'description':
      return { description: body };
    case 'announce': {
      const on = parseWwebjsOnOff(body);
      return on === undefined ? {} : { announce: on };
    }
    case 'restrict':
    case 'locked': {
      const on = parseWwebjsOnOff(body);
      return on === undefined ? {} : { locked: on };
    }
    default:
      return {};
  }
}

/**
 * A GroupNotification's `recipientIds` are assigned straight through from the wire
 * (`this.recipientIds = data.recipients`), outside upstream's id normalization — so on a WA Web
 * build that renamed `_serialized` to `$1` (#747) an entry can arrive as a raw id object instead
 * of a string. Coerce both shapes to the neutral (already @c.us/@g.us) string form; entries that
 * resolve to nothing are dropped rather than forwarded as "undefined".
 */
export function wwebjsGroupRecipientIds(notification: GroupNotification): string[] {
  const raw = notification.recipientIds as unknown;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(entry => {
      if (typeof entry === 'string') return entry;
      const wid = entry as SerializedWid | undefined;
      return wid?._serialized ?? wid?.$1 ?? '';
    })
    .filter(id => id.length > 0);
}
