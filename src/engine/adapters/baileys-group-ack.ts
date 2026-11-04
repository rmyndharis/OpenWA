import { chatKind, parseWaId, userPart } from '../identity/wa-id';
import type { MessageReceiptEvent } from '../interfaces/whatsapp-engine.interface';

/** The statuses a group message reaches from the receipts of its members. */
export type GroupAckStatus = 'delivered' | 'read';

/** Most group messages followed at once; past that, the one heard from longest ago is dropped. */
export const GROUP_ACK_MAX_MESSAGES = 500;
/**
 * Most member ids and member marks held across the followed messages. A message to a group of a thousand holds
 * thousands of them, so the message count alone would not bound the memory: past this budget the messages heard
 * from longest ago are dropped too, which keeps about a hundred messages of the largest groups.
 */
export const GROUP_ACK_MAX_KEYS = 300_000;
/** How long a message is followed: a member's phone can stay offline for days before it reports. */
export const GROUP_ACK_FOLLOW_MS = 7 * 24 * 60 * 60 * 1000;
/** After a roster read fails, the message is not read again for this long, so a burst of receipts makes one try. */
export const GROUP_ACK_RETRY_MS = 30_000;

export interface GroupAckHost {
  /**
   * The members of a group other than this account, one list per member holding every id form that names them
   * (a lid, a phone number), or null when the roster cannot be read.
   */
  readRoster(groupId: string): Promise<string[][] | null>;
  /** The phone user part the session knows for a lid, or null. */
  resolvePhone?(jid: string): string | null;
  /** Hands the aggregate status of a message to the engine's ack callback. */
  report(messageId: string, status: GroupAckStatus, chatId: string): void;
  warn(message: string, context: Record<string, unknown>): void;
}

interface Following {
  state: 'following';
  chatId: string;
  /** The number of a member, by every identity key that names them. */
  members: Map<string, number>;
  size: number;
  delivered: Set<number>;
  read: Set<number>;
  reported: 0 | 1 | 2;
  heardAt: number;
}

/** A message with nothing left to report, kept so a late receipt does not start it over. */
interface Finished {
  state: 'finished';
  heardAt: number;
}

/** A message whose group roster could not be read, tried again after `retryAt`. */
interface Unreadable {
  state: 'unreadable';
  retryAt: number;
  heardAt: number;
}

type Entry = Following | Finished | Unreadable;

/** What an entry can hold at most: the ids of its roster, plus a delivered and a read mark per member. */
function weightOf(entry: Entry): number {
  return entry.state === 'following' ? entry.members.size + 2 * entry.size : 1;
}

/** `user:<phone>` or `lid:<lid>`: the device suffix and the dialect of the domain are folded away. */
function identityKey(jid: string): string | undefined {
  const { kind, userPart: user } = parseWaId(jid);
  return kind === 'user' || kind === 'lid' ? `${kind}:${user}` : undefined;
}

/**
 * Turns the per-member receipts Baileys raises for a group message into the aggregate status WhatsApp shows on
 * the phone: `delivered` once every member other than this account has received the message, `read` once every
 * member has read it. Baileys reports a group message only member by member (a member's devices each report, so
 * one member can report the same status several times), and its 1:1 status update never fires for it, so
 * without this the message stays at `sent`.
 *
 * The members are the roster read at the first receipt, so a member added later is not waited for. A member
 * whose device never reports keeps the message at the lower status. The state is in memory and bounded: a
 * restart forgets the receipts of earlier messages, which then advance no further.
 */
export class GroupAckAggregator {
  /** Followed messages, oldest first: a message that is heard from again moves to the end. */
  private readonly entries = new Map<string, Entry>();
  /** Roster reads under way, so a burst of receipts for one message shares a single query. */
  private readonly loading = new Map<string, Promise<Following | null>>();
  /** The sum of {@link weightOf} over the entries. */
  private weight = 0;

  constructor(
    private readonly host: GroupAckHost,
    private readonly now: () => number = Date.now,
    private readonly maxMessages: number = GROUP_ACK_MAX_MESSAGES,
    private readonly maxKeys: number = GROUP_ACK_MAX_KEYS,
  ) {}

  async record(event: MessageReceiptEvent): Promise<void> {
    if (chatKind(event.chatId) !== 'group') return;
    const following = await this.follow(event.messageId, event.chatId);
    if (!following) return;
    const member = this.memberOf(following, event.participant);
    if (member === undefined) return;
    following.delivered.add(member);
    if (event.status !== 'delivered') following.read.add(member);
    const reached = following.read.size === following.size ? 2 : following.delivered.size === following.size ? 1 : 0;
    while (following.reported < reached) {
      following.reported = following.reported === 0 ? 1 : 2;
      this.report(event.messageId, following.reported === 1 ? 'delivered' : 'read', following.chatId);
    }
    if (following.reported === 2) this.remember(event.messageId, { state: 'finished', heardAt: this.now() });
  }

  private report(messageId: string, status: GroupAckStatus, chatId: string): void {
    try {
      this.host.report(messageId, status, chatId);
    } catch (error) {
      this.host.warn('Reporting the aggregate ack of a group message failed', {
        messageId,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private follow(messageId: string, chatId: string): Promise<Following | null> {
    const now = this.now();
    const known = this.entries.get(messageId);
    if (known && now - known.heardAt < GROUP_ACK_FOLLOW_MS) {
      if (known.state === 'finished') return Promise.resolve(null);
      if (known.state === 'following') {
        known.heardAt = now;
        this.entries.delete(messageId);
        this.entries.set(messageId, known);
        return Promise.resolve(known);
      }
      if (now < known.retryAt) return Promise.resolve(null);
    }
    const joined = this.loading.get(messageId);
    if (joined) return joined;
    const pending = this.load(messageId, chatId, now).finally(() => this.loading.delete(messageId));
    this.loading.set(messageId, pending);
    return pending;
  }

  private async load(messageId: string, chatId: string, now: number): Promise<Following | null> {
    let roster: string[][] | null = null;
    try {
      roster = await this.host.readRoster(chatId);
    } catch (error) {
      this.host.warn('Reading a group roster to follow the acks of its message failed', {
        chatId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!roster) {
      this.remember(messageId, { state: 'unreadable', retryAt: now + GROUP_ACK_RETRY_MS, heardAt: now });
      return null;
    }
    const members = new Map<string, number>();
    let size = 0;
    for (const forms of roster) {
      const keys = forms.map(identityKey).filter((key): key is string => key !== undefined);
      if (keys.length === 0) continue;
      const number = keys.map(key => members.get(key)).find(known => known !== undefined) ?? size++;
      for (const key of keys) members.set(key, number);
    }
    if (size === 0) {
      // Nobody but this account is in the group: there is no one to wait for.
      this.remember(messageId, { state: 'finished', heardAt: now });
      return null;
    }
    const following: Following = {
      state: 'following',
      chatId,
      members,
      size,
      delivered: new Set(),
      read: new Set(),
      reported: 0,
      heardAt: now,
    };
    this.remember(messageId, following);
    return following;
  }

  /** The number of the member a receipt names, in whichever dialect the group addresses its members. */
  private memberOf(following: Following, participant: string): number | undefined {
    const key = identityKey(participant);
    if (!key) return undefined;
    const direct = following.members.get(key);
    if (direct !== undefined || parseWaId(participant).kind !== 'lid') return direct;
    const phone = this.host.resolvePhone?.(participant);
    return phone ? following.members.get(`user:${userPart(phone)}`) : undefined;
  }

  /** Keeps an entry as the newest, then drops the oldest ones that are expired or beyond a limit. */
  private remember(messageId: string, entry: Entry): void {
    this.drop(messageId);
    this.entries.set(messageId, entry);
    this.weight += weightOf(entry);
    const now = this.now();
    for (const [id, oldest] of this.entries) {
      if (id === messageId) break;
      const withinLimits = this.entries.size <= this.maxMessages && this.weight <= this.maxKeys;
      if (withinLimits && now - oldest.heardAt < GROUP_ACK_FOLLOW_MS) break;
      this.drop(id);
    }
  }

  private drop(messageId: string): void {
    const entry = this.entries.get(messageId);
    if (!entry) return;
    this.weight -= weightOf(entry);
    this.entries.delete(messageId);
  }
}
