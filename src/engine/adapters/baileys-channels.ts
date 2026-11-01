import type { NewsletterMetadata, WASocket } from '@whiskeysockets/baileys';
import { Channel } from '../interfaces/whatsapp-engine.interface';
import { ChannelNotFoundError } from '../../common/errors/channel-not-found.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
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
 * The discriminator is a `data` that is a GraphQL error node, one carrying `message` or
 * `extensions`. Any object is not enough: promiseTimeout (Utils/generics.js) rejects a stalled send
 * or an unanswered query with `Boom('Timed Out', { statusCode: 408, data: { stack } })`, and
 * executeWMexQuery's OTHER throw carries the raw result node as `data`. Both are transport
 * failures, and reading their 4xx code as a refusal would turn a stalled socket into a 403 or 404.
 */
export function wmexRefusalCode(error: unknown): number | undefined {
  const err = error as { data?: unknown; output?: { statusCode?: unknown } } | null | undefined;
  if (typeof err?.data === 'number') {
    return err.data;
  }
  const node = err?.data as { message?: unknown; extensions?: unknown } | null | undefined;
  const isGraphQlError = typeof node === 'object' && node !== null && ('message' in node || 'extensions' in node);
  if (isGraphQlError && typeof err?.output?.statusCode === 'number') {
    return err.output.statusCode;
  }
  return undefined;
}

/**
 * `thread_metadata` as newsletterMetadata actually returns it (recorded live in
 * scripts/patch-baileys-newsletter-create.spec.js). The .d.ts types it as the flattened create shape.
 */
interface RawNewsletterThread {
  name?: { text?: string } | null;
  description?: { text?: string } | null;
  invite?: string;
  subscribers_count?: string;
  verification?: 'VERIFIED' | 'UNVERIFIED';
  creation_time?: string;
}

/** A wire number that may come as a string, or as NaN from the create parser; undefined unless finite. */
function finiteNumber(value: number | string | undefined): number | undefined {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  return n !== undefined && Number.isFinite(n) ? n : undefined;
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
    const meta = await this.lookup('jid', channelId, 'the channel lookup');
    return meta ? this.toChannel(meta) : null;
  }

  async subscribeToChannel(inviteCode: string): Promise<Channel> {
    this.host.ensureReady();
    const meta = await this.lookup('invite', inviteCode, 'the invite lookup');
    if (!meta) {
      throw new ChannelNotFoundError(inviteCode);
    }
    await mapServerRefusal(
      'Subscribing to the channel',
      () => this.bounded(this.sock().newsletterFollow(meta.id), 'the channel subscribe'),
      wmexRefusalCode,
    );
    return this.toChannel(meta);
  }

  /**
   * A channel lookup that WhatsApp refuses (an unknown id, a bad invite code) comes back as a w:mex
   * GraphQL error rather than an empty node, so a 4xx refusal is read as "no such channel", the same
   * way the group invite lookup reads one. A rate limit (429) or a timeout (408) says nothing about
   * the channel, so it answers 503, as the deadline does.
   */
  private async lookup(type: 'jid' | 'invite', key: string, operation: string) {
    try {
      return await this.bounded(this.sock().newsletterMetadata(type, key), operation);
    } catch (error) {
      const code = wmexRefusalCode(error);
      if (code === 408 || code === 429) {
        throw new EngineTransportError(`WhatsApp rate-limited or timed out ${operation} (code ${code})`);
      }
      if (code !== undefined && code >= 400 && code < 500) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Deliberately NOT bounded, unlike every other call here: creating a channel is non-idempotent,
   * and 503 is a backpressure status the Go SDK retries three times for POST (sdk/go/retry.go).
   * A deadline abandons without cancelling, so a slow-but-succeeding create could leave duplicates.
   * An unanswered query therefore still surfaces opaquely rather than as something retryable, and so
   * does WA code 408: a server timeout does not say whether the channel was created.
   */
  async createChannel(name: string, description?: string): Promise<Channel> {
    this.host.ensureReady();
    const meta = await mapServerRefusal(
      'Creating the channel',
      () => this.sock().newsletterCreate(name, description),
      error => {
        const code = wmexRefusalCode(error);
        return code === 408 ? undefined : code;
      },
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
    // Unfollowing a channel the account no longer follows is refused like the other channel writes,
    // on either refusal channel, and answers the documented 403 as whatsapp-web.js does.
    await mapServerRefusal(
      'Unsubscribing from the channel',
      () => this.bounded(this.sock().newsletterUnfollow(channelId), 'the channel unsubscribe'),
      wmexRefusalCode,
    );
  }

  /**
   * Map a channel to the neutral Channel shape (optionals only when present).
   *
   * Two shapes arrive here. newsletterCreate flattens its response (parseNewsletterCreateResponse),
   * but newsletterMetadata returns the raw GraphQL node untouched: fields nested under
   * `thread_metadata`, name and description as `{ text }`, counts and timestamps as strings. The
   * flat fields are read first and the nested ones fill the gaps. The flat parse uses parseInt, so
   * a missing number arrives as NaN and is dropped rather than serialized as null.
   *
   * No `picture`: neither shape carries a URL, only a CDN direct path.
   */
  private toChannel(meta: NewsletterMetadata): Channel {
    const thread = meta.thread_metadata as RawNewsletterThread | undefined;
    const description = meta.description ?? thread?.description?.text;
    const invite = meta.invite ?? thread?.invite;
    const subscriberCount = finiteNumber(meta.subscribers) ?? finiteNumber(thread?.subscribers_count);
    const verification = meta.verification ?? thread?.verification;
    const createdAt = finiteNumber(meta.creation_time) ?? finiteNumber(thread?.creation_time);
    return {
      id: meta.id,
      name: meta.name ?? thread?.name?.text ?? '',
      ...(description ? { description } : {}),
      ...(invite ? { inviteCode: invite } : {}),
      ...(subscriberCount !== undefined ? { subscriberCount } : {}),
      ...(verification ? { verified: verification === 'VERIFIED' } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
    };
  }
}
