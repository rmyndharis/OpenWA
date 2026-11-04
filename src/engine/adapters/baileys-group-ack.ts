import { chatKind, parseWaId, userPart } from '../identity/wa-id';
import type { MessageReceiptEvent } from '../interfaces/whatsapp-engine.interface';

/** The statuses a group message reaches from the receipts of its members. */
export type GroupAckStatus = 'delivered' | 'read';

/** Most group messages followed at once; past that, the one heard from longest ago is dropped. */
export const GROUP_ACK_MAX_MESSAGES = 500;
/**
 * Most member ids and member marks held across the followed messages. A message to a group of a thousand holds
 * thousands of them, so the message count alone would not bound the memory: past this budget the messages heard
 * from longest ago are dropped too, which keeps about seventy messages of the largest groups.
 */
export const GROUP_ACK_MAX_KEYS = 300_000;
/** How long a message is followed after its last receipt: a member's phone can stay offline for days. */
export const GROUP_ACK_FOLLOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * After a group's roster could not be read, it is not read again for this long, for any of its messages, so a
 * burst of receipts for a group the account has left makes one query, not one per message.
 */
export const GROUP_ACK_RETRY_MS = 30_000;
/** Most receipts held back, across all messages, while the roster of their group cannot be read. */
export const GROUP_ACK_MAX_HELD = 5_000;
/** Most groups remembered as unreadable at once. */
const MAX_UNREADABLE_GROUPS = 256;
/** How often a roster read that a member change overtook is repeated, so a group in constant flux still settles. */
const MAX_ROSTER_RETRIES = 4;

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
  messageId: string;
  chatId: string;
  /** The number of a member, by every identity key that names them. */
  members: Map<string, number>;
  /** How many members are waited for. */
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

type Entry = Following | Finished;

/** What `follow` found for a message: the state to count its receipts in, or why there is none. */
type Followed = Following | 'finished' | 'unreadable';

/** What an entry can hold at most: the ids of its roster, plus a delivered and a read mark per member. */
function weightOf(entry: Entry): number {
  return entry.state === 'following' ? entry.members.size + 2 * entry.size : 1;
}

/**
 * A message is named by its chat and its id together: a receipt that carries an id of a message in another chat
 * (a member of both can relay one) is not another receipt of that message.
 */
function entryKey(chatId: string, messageId: string): string {
  return `${chatId}|${messageId}`;
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
 * The members are the roster read at the first receipt, less any member who leaves afterwards ({@link forget}):
 * a member who joined after the send but before that first receipt is waited for although the message never
 * reached them, and keeps the message at the lower status. So does a member whose device never reports. The
 * receipts of a message whose roster cannot be read are held back (a bounded number) and counted once it can.
 * The state is in memory and bounded: a restart forgets the receipts of earlier messages, so one that has not
 * completed by then completes only if the rest of its receipts arrive afterwards.
 */
export class GroupAckAggregator {
  /** Followed messages by chat and id, oldest first: a message that is heard from again moves to the end. */
  private readonly entries = new Map<string, Entry>();
  /** Message loads under way, so a burst of receipts for one message shares a single load. */
  private readonly loading = new Map<string, Promise<Followed>>();
  /** Roster reads under way, one per group, so the messages of a group share a single query. */
  private readonly reading = new Map<string, Promise<string[][] | null>>();
  /** Groups whose roster could not be read, with the time they may be read again. */
  private readonly unreadable = new Map<string, number>();
  /** Roster reads that a change of members overtook while they were under way: their answer is read again. */
  private readonly outdated = new WeakSet<Promise<string[][] | null>>();
  /** Receipts waiting for the roster of their group, by message, oldest message first. */
  private readonly held = new Map<string, MessageReceiptEvent[]>();
  private heldCount = 0;
  /** The sum of {@link weightOf} over the entries. */
  private weight = 0;

  constructor(
    private readonly host: GroupAckHost,
    private readonly now: () => number = () => performance.now(),
    private readonly maxMessages: number = GROUP_ACK_MAX_MESSAGES,
    private readonly maxKeys: number = GROUP_ACK_MAX_KEYS,
    private readonly maxHeld: number = GROUP_ACK_MAX_HELD,
  ) {}

  async record(event: MessageReceiptEvent): Promise<void> {
    if (chatKind(event.chatId) !== 'group') return;
    const key = entryKey(event.chatId, event.messageId);
    const followed = await this.follow(key, event);
    if (followed === 'unreadable') {
      this.hold(key, event);
      return;
    }
    const waiting = this.release(key);
    if (followed === 'finished') return;
    for (const receipt of waiting) this.count(key, followed, receipt);
    this.count(key, followed, event);
  }

  /**
   * A member joined or left the group. A roster read under way began before the change and may not show it, so
   * the messages waiting for it read the roster again, and a message that starts now does not join that read.
   */
  membershipChanged(groupId: string): void {
    const current = this.reading.get(groupId);
    if (!current) return;
    this.outdated.add(current);
    this.reading.delete(groupId);
  }

  /**
   * A member left the group: it is no longer waited for, which can complete the messages it was the last to
   * hold up. `participants` holds every id form that names the members who left.
   */
  forget(chatId: string, participants: string[]): void {
    for (const [key, entry] of [...this.entries]) {
      // Settling one message can drop expired ones from the map, so an entry of the snapshot may be gone by now.
      if (entry.state !== 'following' || entry.chatId !== chatId || this.entries.get(key) !== entry) continue;
      const gone = new Set<number>();
      for (const jid of participants) {
        const member = this.memberOf(entry, jid);
        if (member !== undefined) gone.add(member);
      }
      if (gone.size === 0) continue;
      const before = weightOf(entry);
      for (const [identity, member] of entry.members) {
        if (gone.has(member)) entry.members.delete(identity);
      }
      for (const member of gone) {
        entry.delivered.delete(member);
        entry.read.delete(member);
      }
      entry.size -= gone.size;
      this.weight += weightOf(entry) - before;
      if (entry.size === 0) this.remember(key, { state: 'finished', heardAt: this.now() });
      else this.settle(key, entry);
    }
  }

  /** Counts one receipt for a followed message, and reports what it completes. */
  private count(key: string, following: Following, event: MessageReceiptEvent): void {
    if (following.reported === 2) return;
    const member = this.memberOf(following, event.participant);
    if (member === undefined) return;
    following.delivered.add(member);
    if (event.status !== 'delivered') following.read.add(member);
    this.settle(key, following);
  }

  /** Reports the statuses a followed message has reached and not yet reported, `delivered` before `read`. */
  private settle(key: string, following: Following): void {
    const reached = following.read.size === following.size ? 2 : following.delivered.size === following.size ? 1 : 0;
    while (following.reported < reached) {
      following.reported = following.reported === 0 ? 1 : 2;
      this.report(following.messageId, following.reported === 1 ? 'delivered' : 'read', following.chatId);
    }
    if (following.reported === 2) this.remember(key, { state: 'finished', heardAt: this.now() });
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

  private follow(key: string, event: MessageReceiptEvent): Promise<Followed> {
    const now = this.now();
    const known = this.entries.get(key);
    if (known && now - known.heardAt < GROUP_ACK_FOLLOW_MS) {
      // A finished message is remembered for as long after its latest receipt as one that is still followed.
      known.heardAt = now;
      this.entries.delete(key);
      this.entries.set(key, known);
      return Promise.resolve(known.state === 'finished' ? 'finished' : known);
    }
    const joined = this.loading.get(key);
    if (joined) return joined;
    const retryAt = this.unreadable.get(event.chatId);
    if (retryAt !== undefined) {
      if (now < retryAt) return Promise.resolve('unreadable');
      this.unreadable.delete(event.chatId);
    }
    const pending = this.load(key, event, now).finally(() => this.loading.delete(key));
    this.loading.set(key, pending);
    return pending;
  }

  private async load(key: string, event: MessageReceiptEvent, now: number): Promise<Followed> {
    const roster = await this.readCurrentRoster(event.chatId);
    if (!roster) return 'unreadable';
    const members = new Map<string, number>();
    let size = 0;
    for (const forms of roster) {
      const keys = forms.map(identityKey).filter((identity): identity is string => identity !== undefined);
      if (keys.length === 0) continue;
      const number = keys.map(identity => members.get(identity)).find(known => known !== undefined) ?? size++;
      for (const identity of keys) members.set(identity, number);
    }
    if (size === 0) {
      // Nobody but this account is in the group: there is no one to wait for.
      this.remember(key, { state: 'finished', heardAt: now });
      return 'finished';
    }
    const following: Following = {
      state: 'following',
      messageId: event.messageId,
      chatId: event.chatId,
      members,
      size,
      delivered: new Set(),
      read: new Set(),
      reported: 0,
      heardAt: now,
    };
    this.remember(key, following);
    return following;
  }

  /**
   * The roster of a group as it stands after the last change of its members that was reported before the read
   * ended: a read that a change overtook did not see it, and is repeated (a bounded number of times).
   */
  private async readCurrentRoster(chatId: string): Promise<string[][] | null> {
    let roster: string[][] | null = null;
    for (let attempt = 0; attempt <= MAX_ROSTER_RETRIES; attempt++) {
      const read = this.readRoster(chatId);
      roster = await read;
      if (!roster || !this.outdated.has(read)) break;
    }
    return roster;
  }

  /** The roster of a group, read once however many of its messages ask at the same time. */
  private readRoster(chatId: string): Promise<string[][] | null> {
    const joined = this.reading.get(chatId);
    if (joined) return joined;
    const pending: Promise<string[][] | null> = (async (): Promise<string[][] | null> => {
      try {
        return await this.host.readRoster(chatId);
      } catch (error) {
        this.host.warn('Reading a group roster to follow the acks of its messages failed', {
          chatId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })()
      .then(roster => {
        // A read that a member change replaced says nothing about the group's next one.
        if (!roster && this.reading.get(chatId) === pending) this.markUnreadable(chatId);
        return roster;
      })
      .finally(() => {
        if (this.reading.get(chatId) === pending) this.reading.delete(chatId);
      });
    this.reading.set(chatId, pending);
    return pending;
  }

  private markUnreadable(chatId: string): void {
    this.unreadable.delete(chatId);
    this.unreadable.set(chatId, this.now() + GROUP_ACK_RETRY_MS);
    if (this.unreadable.size > MAX_UNREADABLE_GROUPS) {
      const oldest = this.unreadable.keys().next().value;
      if (oldest !== undefined) this.unreadable.delete(oldest);
    }
  }

  /** Holds a receipt back until the roster of its group can be read; the oldest messages' receipts go first. */
  private hold(key: string, event: MessageReceiptEvent): void {
    const waiting = this.held.get(key);
    if (waiting) waiting.push(event);
    else this.held.set(key, [event]);
    this.heldCount++;
    while (this.heldCount > this.maxHeld) {
      const oldest = this.held.keys().next().value;
      if (oldest === undefined) break;
      this.release(oldest);
    }
  }

  /** Takes the receipts held back for a message. */
  private release(key: string): MessageReceiptEvent[] {
    const waiting = this.held.get(key);
    if (!waiting) return [];
    this.held.delete(key);
    this.heldCount -= waiting.length;
    return waiting;
  }

  /** The number of the member a receipt names, in whichever dialect the group addresses its members. */
  private memberOf(following: Following, participant: string): number | undefined {
    const identity = identityKey(participant);
    if (!identity) return undefined;
    const direct = following.members.get(identity);
    if (direct !== undefined || parseWaId(participant).kind !== 'lid') return direct;
    const phone = this.host.resolvePhone?.(participant);
    return phone ? following.members.get(`user:${userPart(phone)}`) : undefined;
  }

  /** Keeps an entry as the newest, then drops the oldest ones that are expired or beyond a limit. */
  private remember(key: string, entry: Entry): void {
    this.drop(key);
    this.entries.set(key, entry);
    this.weight += weightOf(entry);
    const now = this.now();
    for (const [id, oldest] of this.entries) {
      if (id === key) break;
      const withinLimits = this.entries.size <= this.maxMessages && this.weight <= this.maxKeys;
      if (withinLimits && now - oldest.heardAt < GROUP_ACK_FOLLOW_MS) break;
      this.drop(id);
    }
  }

  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.weight -= weightOf(entry);
    this.entries.delete(key);
  }
}
