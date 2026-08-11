import type { WASocket } from '@whiskeysockets/baileys';
import { Channel } from '../interfaces/whatsapp-engine.interface';
import { ChannelNotFoundError } from '../../common/errors/channel-not-found.error';
import { mapServerRefusal } from './baileys-groups';
import { BAILEYS_QUERY_BUDGET_MS, withQueryDeadline } from './baileys-query-deadline';

/**
 * Channel-domain operations extracted from BaileysAdapter. The adapter keeps the public
 * methods as thin forwarders and injects this narrow host surface via closures, so the
 * delegate never touches lifecycle state directly.
 */
export interface BaileysChannelsHost {
  ensureReady(): void;
  /** Post-ensureReady socket handle — call host.ensureReady() first. */
  getSocket(): WASocket;
  /**
   * Neutral → engine jid dialect. Channel ids need no mapping (`@newsletter` in both), but the
   * admin writes take a USER jid, which does.
   */
  toEngineJid(jid: string): string;
}

/**
 * WA error code of a w:mex refusal, or undefined for anything else.
 *
 * executeWMexQuery (lib/Socket/mex.js) parses a GraphQL payload out of a SUCCESSFUL iq, so a
 * refusal never reaches assertNodeErrorFree and never carries the numeric `data` refusedStatusCode
 * reads. It throws `Boom(msg, { statusCode: errorCode, data: firstError })` instead — the code on
 * the Boom, the error node as `data`.
 *
 * A non-null OBJECT `data` is the discriminator, and it is safe here specifically: Boom defaults
 * `data` to null, so every transport failure carries null, and so does executeWMexQuery's OTHER
 * throw for an unanswered query (`data: result` with result undefined). Kept local to this file
 * rather than folded into refusedStatusCode, because promiseTimeout's Boom also carries an object
 * `data` with a 4xx code and must never be read as a refusal.
 */
export function wmexRefusalCode(error: unknown): number | undefined {
  const err = error as { data?: unknown; output?: { statusCode?: unknown } } | null | undefined;
  if (typeof err?.data === 'number') {
    return err.data;
  }
  if (err?.data !== null && typeof err?.data === 'object' && typeof err.output?.statusCode === 'number') {
    return err.output.statusCode;
  }
  return undefined;
}

export class BaileysChannels {
  constructor(
    private readonly host: BaileysChannelsHost,
    private readonly queryBudgetMs: number = BAILEYS_QUERY_BUDGET_MS,
  ) {}

  /**
   * Bound a channel call. executeWMexQuery throws Boom(..., { statusCode: 400, data: result }) when
   * nothing came back, and with result undefined Boom normalises data to null — so the refusal
   * classifier cannot place it and the raw Boom escapes as a bare 500.
   */
  private bounded<T>(work: Promise<T>, operation: string): Promise<T> {
    return withQueryDeadline(work, this.queryBudgetMs, `WhatsApp did not answer ${operation} in time`);
  }

  /** Post-ensureReady socket handle. */
  private sock(): WASocket {
    return this.host.getSocket();
  }

  async getChannelById(channelId: string): Promise<Channel | null> {
    this.host.ensureReady();
    // newsletterMetadata resolves ANY channel by jid (richer than the wwjs subscribed-list lookup).
    const meta = await this.bounded(this.sock().newsletterMetadata('jid', channelId), 'the channel lookup');
    return meta ? this.toChannel(meta) : null;
  }

  async subscribeToChannel(inviteCode: string): Promise<Channel> {
    this.host.ensureReady();
    const meta = await this.bounded(this.sock().newsletterMetadata('invite', inviteCode), 'the invite lookup');
    if (!meta) {
      throw new ChannelNotFoundError(inviteCode);
    }
    await this.bounded(this.sock().newsletterFollow(meta.id), 'the channel subscribe');
    return this.toChannel(meta);
  }

  /**
   * Deliberately NOT bounded, unlike every other call here: creating a channel is non-idempotent,
   * and 503 is a backpressure status the Go SDK retries three times for POST (sdk/go/retry.go).
   * A deadline abandons without cancelling, so a slow-but-succeeding create could leave duplicates.
   */
  async createChannel(name: string, description?: string): Promise<Channel> {
    this.host.ensureReady();
    const meta = await mapServerRefusal(
      'Creating the channel',
      () => this.sock().newsletterCreate(name, description),
      wmexRefusalCode,
    );
    return this.toChannel(meta);
  }

  /**
   * Demote a channel admin back to a plain subscriber. `userId` arrives in the NEUTRAL dialect and
   * is mapped here, the way the contact and messaging delegates map theirs.
   *
   * There is no promote counterpart to pair this with, and that is upstream rather than ours:
   * Baileys exposes `newsletterDemote`, `newsletterChangeOwner` and `newsletterAdminCount` but no
   * promote, and whatsapp-web.js has no `promoteChannelAdmin` at all. An admin is promoted from the
   * WhatsApp app and can then be demoted through this API.
   */
  async demoteChannelAdmin(channelId: string, userId: string): Promise<void> {
    this.host.ensureReady();
    const userJid = this.host.toEngineJid(userId);
    await mapServerRefusal(
      'Demoting the channel admin',
      () => this.bounded(this.sock().newsletterDemote(channelId, userJid), 'the channel admin demotion'),
      wmexRefusalCode,
    );
  }

  /**
   * Hand the channel to a new owner. IRREVERSIBLE: the account stops being the owner and cannot
   * take it back through this API.
   *
   * Bounded, unlike `createChannel` above. That one stays unbounded because a retried create leaves
   * a duplicate channel behind; here a retry after a transfer that actually landed is refused, since
   * the account no longer owns the channel. So the deadline costs an ambiguous 503 ("may or may not
   * have applied") and buys a request that ends.
   */
  async transferChannelOwnership(channelId: string, newOwnerId: string): Promise<void> {
    this.host.ensureReady();
    const newOwnerJid = this.host.toEngineJid(newOwnerId);
    await mapServerRefusal(
      'Transferring the channel ownership',
      () => this.bounded(this.sock().newsletterChangeOwner(channelId, newOwnerJid), 'the channel ownership transfer'),
      wmexRefusalCode,
    );
  }

  async deleteChannel(channelId: string): Promise<void> {
    this.host.ensureReady();
    await mapServerRefusal(
      'Deleting the channel',
      () => this.bounded(this.sock().newsletterDelete(channelId), 'the channel delete'),
      wmexRefusalCode,
    );
  }

  async muteChannel(channelId: string, mute: boolean): Promise<void> {
    this.host.ensureReady();
    await mapServerRefusal(
      mute ? 'Muting the channel' : 'Unmuting the channel',
      () =>
        this.bounded(
          mute ? this.sock().newsletterMute(channelId) : this.sock().newsletterUnmute(channelId),
          mute ? 'the channel mute' : 'the channel unmute',
        ),
      wmexRefusalCode,
    );
  }

  async unsubscribeFromChannel(channelId: string): Promise<void> {
    this.host.ensureReady();
    await this.bounded(this.sock().newsletterUnfollow(channelId), 'the channel unsubscribe');
  }

  /** Map a Baileys NewsletterMetadata to the neutral Channel shape (optionals only when present). */
  private toChannel(meta: {
    id: string;
    name: string;
    description?: string;
    invite?: string;
    creation_time?: number;
    subscribers?: number;
    picture?: { url?: string };
    verification?: string;
    thread_metadata?: { creation_time?: number };
  }): Channel {
    const createdAt = meta.creation_time ?? meta.thread_metadata?.creation_time;
    return {
      id: meta.id,
      name: meta.name,
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.invite ? { inviteCode: meta.invite } : {}),
      ...(meta.subscribers !== undefined ? { subscriberCount: meta.subscribers } : {}),
      ...(meta.picture?.url ? { picture: meta.picture.url } : {}),
      ...(meta.verification ? { verified: meta.verification === 'VERIFIED' } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
    };
  }
}
