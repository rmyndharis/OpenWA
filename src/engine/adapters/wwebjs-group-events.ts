import { type Client, type GroupNotification } from 'whatsapp-web.js';
import { type EngineEventCallbacks, GroupEvent } from '../interfaces/whatsapp-engine.interface';
import { type createLogger } from '../../common/services/logger.service';
import { SerializedWid, readWid } from '../types/whatsapp-web-js.types';

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
      return readWid(wid) ?? '';
    })
    .filter(id => id.length > 0);
}

/** Host surface for {@link registerWwebjsGroupEvents}. */
export interface WwebjsGroupEventsHost {
  readonly logger: ReturnType<typeof createLogger>;
  /** Live callbacks bag — read per event, since initialize() installs it after delegates are built. */
  getCallbacks(): EngineEventCallbacks;
}

/**
 * Group-notification client events (group_join / group_leave / group_update /
 * group_membership_request) extracted from the adapter's setupEventHandlers: pure mapping from
 * wwebjs GroupNotifications to neutral GroupEvents fired through the engine callbacks. Like
 * ./wwebjs-message-events, this file never touches connection-state or lifecycle latches.
 */
export function registerWwebjsGroupEvents(client: Client, host: WwebjsGroupEventsHost): void {
  client.on('group_join', notification => handleGroupNotification(host, 'join', notification));
  client.on('group_leave', notification => handleGroupNotification(host, 'leave', notification));
  client.on('group_update', notification => handleGroupNotification(host, 'update', notification));
  client.on('group_membership_request', notification => handleGroupNotification(host, 'join_request', notification));
}

/**
 * Map a whatsapp-web.js GroupNotification (`group_join` / `group_leave` / `group_update`) to the
 * neutral GroupEvent and forward it. wwebjs ids are already in the neutral dialect (@c.us/@g.us),
 * so no jid translation is needed here. The try/catch mirrors message_edit: a malformed
 * notification is logged and dropped, never thrown back into the client's emitter.
 */
function handleGroupNotification(
  host: WwebjsGroupEventsHost,
  kind: GroupEvent['kind'],
  notification: GroupNotification,
): void {
  try {
    // A notification without a chat id carries no usable target — drop it before payload building.
    if (!notification.chatId) {
      return;
    }
    const payload: GroupEvent = {
      kind,
      groupId: notification.chatId,
      actorId: notification.author || undefined,
      participantIds: wwebjsGroupRecipientIds(notification),
      // The notification's own timestamp IS the occurrence time (unlike message_edit, where
      // wwebjs keeps the original creation time). Fall back to receipt time when absent.
      timestamp:
        typeof notification.timestamp === 'number' && notification.timestamp > 0
          ? Math.floor(notification.timestamp)
          : Math.floor(Date.now() / 1000),
    };
    if (kind === 'join_request' && payload.participantIds.length === 0) {
      // A self-request carries no recipients: the author IS the user asking to join
      // (Client.js:633-641 documents chatId/author/timestamp for this event). A request naming
      // nobody at all is unactionable and dropped.
      if (!payload.actorId) {
        return;
      }
      payload.participantIds = [payload.actorId];
    }
    if (kind === 'update') {
      // Join/leave carry no metadata delta. An update whose subtype/body cannot be interpreted
      // still emits with empty changes rather than being dropped silently.
      payload.changes = wwebjsGroupUpdateChanges(notification);
    }
    host.getCallbacks().onGroupEvent?.(payload);
  } catch (error) {
    host.logger.error(`Error processing group_${kind} notification`, String(error));
  }
}
