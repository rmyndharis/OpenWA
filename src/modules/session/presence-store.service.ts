import { Injectable } from '@nestjs/common';
import type { ParticipantPresence, PresenceUpdateEvent } from '../../engine/interfaces/whatsapp-engine.interface';

/** What `GET /presence/:chatId` serves: the last report, with when it arrived. */
export interface ChatPresence {
  chatId: string;
  participants: ParticipantPresence[];
  groupOnlineCount?: number;
  /** Unix ms this gateway received the report — NOT a WhatsApp timestamp. */
  observedAt: number;
}

/**
 * Bound on how many chats one session keeps presence for. Presence is only reported for chats that
 * were explicitly subscribed, so this is already caller-bounded; the cap exists so a client that
 * subscribes in a loop cannot grow the map without limit. Eviction is oldest-observed-first.
 */
const MAX_CHATS_PER_SESSION = 500;

/**
 * The last presence WhatsApp reported for each subscribed chat.
 *
 * In memory because presence IS ephemeral — "typing, three seconds ago" has no meaning after a
 * restart, and persisting it would serve confident answers about a state that expired long before.
 * It is also the only thing that can answer a read at all: presence cannot be queried from either
 * library, only received after a subscription, so a `GET` has nothing to fetch and everything to
 * remember.
 */
@Injectable()
export class PresenceStore {
  private readonly bySession = new Map<string, Map<string, ChatPresence>>();

  /**
   * Record a report. Returns whether it CHANGED anything a consumer would care about — WhatsApp
   * re-sends the same state freely, and dispatching a webhook per repeat would make presence the
   * loudest event in the system by a wide margin for no added information.
   *
   * `lastSeen` and `groupOnlineCount` drifting on their own do not count as a change: they move
   * continuously while nothing observable happens, and treating them as news would defeat the
   * suppression entirely.
   */
  record(sessionId: string, event: PresenceUpdateEvent, at = Date.now()): boolean {
    const chats = this.bySession.get(sessionId) ?? new Map<string, ChatPresence>();
    this.bySession.set(sessionId, chats);

    const previous = chats.get(event.chatId);
    const next: ChatPresence = {
      chatId: event.chatId,
      participants: event.participants,
      ...(event.groupOnlineCount === undefined ? {} : { groupOnlineCount: event.groupOnlineCount }),
      observedAt: at,
    };
    // Re-insert so the map stays ordered by recency and the eviction below drops the stalest chat.
    chats.delete(event.chatId);
    chats.set(event.chatId, next);
    while (chats.size > MAX_CHATS_PER_SESSION) {
      const oldest = chats.keys().next().value;
      if (oldest === undefined) break;
      chats.delete(oldest);
    }
    return !samePresence(previous?.participants, event.participants);
  }

  /** The last known presence for a chat, or null if none was ever reported. */
  get(sessionId: string, chatId: string): ChatPresence | null {
    return this.bySession.get(sessionId)?.get(chatId) ?? null;
  }

  /** Drop everything for a session — it stopped, was deleted, or its engine was replaced. */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

/**
 * Whether two participant lists say the same thing. Order is not significant — the engines build the
 * list by iterating an object, so a reordering is not a presence change and must not read as one.
 */
function samePresence(before: ParticipantPresence[] | undefined, after: ParticipantPresence[]): boolean {
  if (!before || before.length !== after.length) return false;
  const previous = new Map(before.map(participant => [participant.id, participant.state]));
  return after.every(participant => previous.get(participant.id) === participant.state);
}
