import { MessageTypes, type Client } from 'whatsapp-web.js';
import { Channel, ChannelMessage } from '../interfaces/whatsapp-engine.interface';
import { BusinessClient, WwjsChannelData, readWid } from '../types/whatsapp-web-js.types';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { EnginePageReloadingError } from '../../common/errors/engine-page-reloading.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { ChannelNotFoundError } from '../../common/errors/channel-not-found.error';
import { type WwebjsEngineHost, withPageWrite, reportPageDeath } from './wwebjs-host';
import { type EvaluatePage, isRetryableStatus } from './wwebjs-page-writes';

/** The writes to a channel that whatsapp-web.js runs in the page and answers with a boolean. */
export type ChannelWrite = 'delete' | 'mute' | 'unmute' | 'unsubscribe';

/**
 * One write to a channel, run IN-PAGE as whatsapp-web.js runs it (`Client.deleteChannel`, `Channel.mute` and `unmute`,
 * `Client.unsubscribeFromChannel`: the same lookups, the same job and the same arguments), and answered with the status
 * WhatsApp Web reported. The library reads every rejection named `ServerStatusCodeError` as `false`, which the adapter
 * read as a refusal, so a timeout, a rate limit or a server error was a 403. The channel's jobs reject that class for
 * an error of the IQ that carries them (`MexIqError`), and its Mex subclass for the error of the query itself, which
 * the library did not catch and so was a bare 500; both carry the status. What the library answered `false` for
 * without asking WhatsApp, a channel the page does not hold and a channel the account owns when it unsubscribes, is
 * answered as the 403 it was. The jobs make up a 423 and three 500s themselves: the unsubscription job reports a
 * suspended channel as a 423 ('newsletter-suspended'), and the delete ('xwa2_newsletter_delete_v2 is null'), the
 * unsubscription ('unexpected-null-mex-response') and the mute and unmute ('unexpected_mex_mutation_response') report
 * an answer of the query that holds nothing as a 500, which is how WhatsApp can refuse an account that may not make
 * the change. None is a status WhatsApp sent or a failure to retry, so all are refusals too, matched by their exact
 * text and status. Every other status is answered as it came, and the caller reads a retryable one as an unknown
 * outcome, never as one that changed nothing: the Mex client sends a delete or a mute again on a 429 or a 500 (four
 * attempts in all) and only the error of the last attempt surfaces, it makes a 500 of its own of any send that fails
 * (a socket that dropped after the request left), and an unsubscription is one request whose reply may not have come.
 * Like the library's calls it does not look the jobs up, so a page without one rejects as the library's call did. The
 * channel is read through the helper whatsapp-web.js installs (`window.WWebJS.getChat`), which a document that has
 * `require` and not the helpers has not got: that page is reloading, and it answers `'no-helpers'` before anything is
 * asked of WhatsApp, as the group writes do. Any other rejection is rethrown. Self-contained, since Puppeteer ships it
 * to the page as source.
 */
export async function runChannelWriteInPage(
  write: ChannelWrite,
  channelId: string,
): Promise<{ status: number } | 'no-helpers'> {
  type NewsletterChat = { newsletterMetadata?: { membershipType?: unknown } } | null;
  const w = window as unknown as {
    require(m: 'WAWebNewsletterDeleteAction'): { deleteNewsletterAction: (channel: unknown) => Promise<unknown> };
    require(m: 'WAWebNewsletterUpdateUserSettingJob'): {
      updateNewsletterUserSetting: (options: unknown) => Promise<unknown>;
    };
    require(m: 'WAWebNewsletterUnsubscribeAction'): {
      unsubscribeFromNewsletterAction: (channel: unknown, options: unknown) => Promise<unknown>;
    };
    require(m: 'WAJids'): { toNewsletterJid: (id: string) => unknown };
    require(m: 'WAWebNewsletterModelUtils'): {
      ADMIN_NOTIFICATIONS: unknown;
      MUTED_STATE: unknown;
      UNMUTED_STATE: unknown;
    };
    WWebJS?: { getChat?: (id: string, options: { getAsModel: boolean }) => Promise<NewsletterChat> };
  };
  try {
    if (write === 'mute' || write === 'unmute') {
      const utils = w.require('WAWebNewsletterModelUtils');
      await w.require('WAWebNewsletterUpdateUserSettingJob').updateNewsletterUserSetting({
        newsletterJid: w.require('WAJids').toNewsletterJid(channelId),
        type: utils.ADMIN_NOTIFICATIONS,
        muteExpirationValue: write === 'mute' ? utils.MUTED_STATE : utils.UNMUTED_STATE,
      });
      return { status: 200 };
    }
    // The job is read before the channel, so that a document with no `require` yet fails on it, the text that is read as a
    // reload, and not on the helper the library installs.
    const deleter = write === 'delete' ? w.require('WAWebNewsletterDeleteAction') : undefined;
    const leaver = write === 'unsubscribe' ? w.require('WAWebNewsletterUnsubscribeAction') : undefined;
    const helpers = w.WWebJS;
    if (typeof helpers?.getChat !== 'function') return 'no-helpers';
    const channel = await helpers.getChat(channelId, { getAsModel: false });
    if (!channel) return { status: 403 };
    // Dispatched on the write, so that a page without the job dies on it, as the library's call did, and never answers 200.
    if (write === 'delete') {
      await deleter!.deleteNewsletterAction(channel);
    } else {
      if (channel.newsletterMetadata?.membershipType === 'owner') return { status: 403 };
      await leaver!.unsubscribeFromNewsletterAction(channel, { eventSurface: 3, deleteLocalModels: true });
    }
    return { status: 200 };
  } catch (err) {
    const failure = err as { name?: unknown; status?: unknown; message?: unknown } | undefined;
    if (typeof failure?.name === 'string' && failure.name.endsWith('ServerStatusCodeError')) {
      // The 423 and the three 500s that the jobs made up themselves (a suspended channel, an answer that holds nothing:
      // how WhatsApp can refuse a change by an account that may not make it) are no status WhatsApp sent and no failure
      // to retry, so they stay the refusal they were.
      const text = String(failure.message);
      if (failure.status === 423 && text === 'newsletter-suspended') return { status: 403 };
      if (
        failure.status === 500 &&
        [
          'xwa2_newsletter_delete_v2 is null',
          'unexpected-null-mex-response',
          'unexpected_mex_mutation_response',
        ].includes(text)
      ) {
        return { status: 403 };
      }
      return { status: typeof failure.status === 'number' ? failure.status : 403 };
    }
    throw err;
  }
}

/**
 * Channel/Newsletter operations extracted from WhatsAppWebJsAdapter. The adapter keeps the public
 * methods as thin forwarders and injects the shared host surface (./wwebjs-host) via closures, so
 * the delegate never touches lifecycle state directly.
 */
export class WwebjsChannels {
  constructor(private readonly host: WwebjsEngineHost) {}

  /** Post-ensureReady client handle. */
  private client(): Client {
    return this.host.getClient();
  }

  /** The reads of this delegate: {@link withPageWrite} says what a dead page and an expired timeout answer. */
  private withPage<T>(context: string, op: () => Promise<T>): Promise<T> {
    return withPageWrite(this.host, context, op);
  }

  async getSubscribedChannels(): Promise<Channel[]> {
    this.host.ensureReady();
    const channels = await this.withPage('getSubscribedChannels', () =>
      (this.client() as unknown as BusinessClient).getChannels(),
    );
    if (!channels) {
      return [];
    }
    return channels.map((ch: WwjsChannelData) => ({
      // Read `$1` before giving up (#747: WA Web's minifier renamed the serialized property), and
      // never String() the object branch — that manufactures the literal "undefined" as an id.
      id: readWid(ch.id) || '',
      name: String(ch.name || ''),
      description: ch.description ? String(ch.description) : undefined,
      inviteCode: ch.inviteCode ? String(ch.inviteCode) : undefined,
      subscriberCount: ch.subscriberCount ? Number(ch.subscriberCount) : undefined,
      verified: ch.verified ? Boolean(ch.verified) : undefined,
    }));
  }

  /**
   * Create a channel.
   *
   * whatsapp-web.js signals failure by RETURNING A STRING ('CreateChannelError: …') rather than
   * throwing — both when channel creation is disabled for the account and when the server refuses
   * (Client.js:2474-2510). Left unchecked that string would be treated as a successful result and
   * mapped into a Channel with undefined everything, so it is turned into a refusal here.
   */
  async createChannel(name: string, description?: string): Promise<Channel> {
    this.host.ensureReady();
    // Non-idempotent, matching ./baileys-channels, which leaves this unbounded for the same
    // reason: a replayed create leaves a duplicate channel behind. See reportPageDeath.
    const result = await reportPageDeath(this.host, 'createChannel', () =>
      (this.client() as unknown as BusinessClient).createChannel(
        name,
        description === undefined ? {} : { description },
      ),
    );
    if (typeof result === 'string' || !result?.nid) {
      throw new EngineRefusedError(typeof result === 'string' ? result : `Failed to create the channel '${name}'`);
    }
    // The nid crosses the puppeteer boundary as a raw page-context Wid, exactly the object class
    // WA Web's minifier rename hits (#747): read `$1` before giving up, and never String() an
    // absent id — a channel with the literal id "undefined" is unusable for every follow-up call.
    const channelId = readWid(result.nid);
    if (!channelId) {
      throw new EngineRefusedError(`Channel '${name}' was created but its id was unreadable — refusing to return it`);
    }
    return {
      id: String(channelId),
      name: String(result.title ?? name),
      ...(description === undefined ? {} : { description }),
      // The library hands back a full invite LINK; the neutral shape carries the code, which is what
      // subscribeToChannel takes.
      ...(result.inviteLink ? { inviteCode: result.inviteLink.split('/').pop() } : {}),
    };
  }

  /**
   * Not available on this engine, despite `Client.demoteChannelAdmin` existing and being typed
   * `Promise<boolean>` (`index.d.ts:35`).
   *
   * The page body calls `window.require('WAWebDemoteNewsletterAdminAction').demoteNewsletterAdmin`
   * (`Client.js:1907-1925`), and WhatsApp Web no longer provides that function. Measured against a
   * live session on Web `2.3000.1044824727-alpha` with no version pin: the call rejects with
   * `TypeError: window.require(...).demoteNewsletterAdmin is not a function`, which reached the
   * caller as a bare 500.
   *
   * A module-existence probe run in the same page narrows it further — **the module still resolves;
   * the function is gone**: `WAWebDemoteNewsletterAdminAction` → `demoteNewsletterAdmin: undefined`,
   * and the second demote path whatsapp-web.js uses elsewhere is equally dead
   * (`WAWebNewsletterDemoteAdminJob` → `demoteNewsletterAdminAction: undefined`). So there is no
   * sibling module to retarget, and `muteChannel` answered 200 twice on that session, so the page
   * and its registry were healthy throughout.
   *
   * Wiring it anyway would be a phantom-support row: the matrix would claim the capability while
   * every call failed. A 501 states the truth. Re-enable by restoring the call here and flipping
   * the matrix cell once whatsapp-web.js targets a module WhatsApp Web actually exports; the
   * Baileys engine serves this capability in the meantime.
   */
  /* eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
  async demoteChannelAdmin(_channelId: string, _userId: string): Promise<void> {
    this.host.ensureReady();
    throw new EngineNotSupportedError('demoteChannelAdmin');
  }

  /**
   * Not available on this engine, despite `Client.transferChannelOwnership` existing and being typed
   * `Promise<boolean>` (`index.d.ts:375`).
   *
   * `WAWebChangeNewsletterOwnerAction.changeNewsletterOwnerAction` is present — unlike the demote
   * path — but on WhatsApp Web `2.3000.1044824727-alpha` it rejects every call with
   * `contact-not-found-in-newsletter-subscriber-list` **without contacting the server**. Measured in
   * the page against a known-server call taken at the same moment: the transfer threw in **4-9ms**
   * while `requestProfilePicFromServer` on the same chat took **352-531ms**. So it is a local check
   * against a subscriber list the page holds, not a WhatsApp business rule we could satisfy.
   *
   * It is not a stale cache either: the target had subscribed (`subscribeToChannel` → 201), the
   * operator could promote it to admin from the app, and a full session restart — a fresh page, a
   * fresh cache — produced the identical 4ms refusal. The one path that could repopulate that list,
   * `WAWebCollections.NewsletterMetadataCollection.update`, is `undefined` in this Web version, and
   * it is the same line `Client.transferChannelOwnership` itself calls when a channel has no cached
   * metadata — so an uncached channel throws there before the transfer is even attempted.
   *
   * Wiring it would be a phantom-support row: a claimed capability whose every call fails, locally,
   * with a reason the library then discards into a bare `false`. A 501 states the truth. Baileys
   * serves this capability — its refusal is a genuine server round trip (418ms, WhatsApp code named).
   */
  /* eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
  async transferChannelOwnership(_channelId: string, _newOwnerId: string): Promise<void> {
    this.host.ensureReady();
    throw new EngineNotSupportedError('transferChannelOwnership');
  }

  /**
   * One write to a channel, sent IN-PAGE ({@link runChannelWriteInPage}) so that WhatsApp's own status decides the
   * answer: whatsapp-web.js reads every status as `false`, which this adapter read as a refusal, so a timeout, a rate
   * limit or a server error was a 403. Those statuses cannot promise that nothing was changed, since the page sends a
   * delete or a mute up to four times and only the last error surfaces, and an unsubscription is one request whose reply
   * may not have come: each is the 503 that says the operation may or may not have been applied, and any other status
   * is the refusal, worded by `refusal`, which keeps the words it always had.
   */
  private async writeToChannel(
    op: string,
    write: ChannelWrite,
    channelId: string,
    request: string,
    refusal: string,
  ): Promise<void> {
    const answer = await withPageWrite(this.host, op, () =>
      (this.client() as unknown as { pupPage: EvaluatePage }).pupPage.evaluate(runChannelWriteInPage, write, channelId),
    );
    // A page without whatsapp-web.js's helpers is reloading, and nothing was asked of WhatsApp: the retryable 409.
    if (answer === 'no-helpers') throw new EnginePageReloadingError();
    const { status } = answer;
    if (status >= 200 && status < 300) return;
    if (isRetryableStatus(status)) {
      throw new EngineTransportError(
        `WhatsApp Web reported ${status} for ${request}, and it may or may not have been applied. ` +
          'Check before repeating it.',
      );
    }
    throw new EngineRefusedError(refusal);
  }

  /** Delete a channel. A channel the page does not hold, and a refusal of WhatsApp, are the 403. */
  async deleteChannel(channelId: string): Promise<void> {
    this.host.ensureReady();
    await this.writeToChannel(
      'deleteChannel',
      'delete',
      channelId,
      `the delete of channel ${channelId}`,
      `Failed to delete channel ${channelId}`,
    );
  }

  /**
   * Mute or unmute a channel. The channel is looked up through the Chat model rather than the client: whatsapp-web.js
   * puts mute on the Channel structure, and `getChatById` yields one for a `@newsletter` id
   * (ChatFactory.create → isChannel). The write itself is the one the structure sends, run in the page.
   */
  async muteChannel(channelId: string, mute: boolean): Promise<void> {
    this.host.ensureReady();
    // getChatById resolves — and will happily CREATE — an ordinary 1:1/group chat for a non-channel
    // id, and Chat carries mute()/unmute() too: without this check a mistyped id muted a real
    // conversation forever (an undefined expiry means "no end date" upstream) and reported success.
    if (!channelId.endsWith('@newsletter')) {
      throw new ChannelNotFoundError(channelId);
    }
    const chat = (await withPageWrite(this.host, 'muteChannel', () =>
      this.client().getChatById(channelId),
    )) as unknown as {
      mute?: () => Promise<boolean>;
      unmute?: () => Promise<boolean>;
    } | null;
    const act = mute ? chat?.mute : chat?.unmute;
    if (!act) {
      throw new ChannelNotFoundError(channelId);
    }
    // The write goes out on the client that found the channel, which getClient's readiness check never sees again.
    this.host.ensureReady();
    const verb = mute ? 'mute' : 'unmute';
    await this.writeToChannel(
      'muteChannel',
      verb,
      channelId,
      `the ${verb} of channel ${channelId}`,
      `Failed to ${verb} channel ${channelId}`,
    );
  }

  async getChannelById(channelId: string): Promise<Channel | null> {
    this.host.ensureReady();
    // wwebjs 1.34.x exposes no client.getChannelById; resolve from the subscribed-channel list (#625).
    const channels = await this.getSubscribedChannels();
    return channels.find(c => c.id === channelId) ?? null;
  }

  // whatsapp-web.js `Client.subscribeToChannel(channelId)` takes a channel ID and resolves a
  // boolean (index.d.ts:71; Client.js:2533) — the interface contract here is subscribe-by-INVITE-CODE
  // returning the subscribed Channel. The old wiring passed the invite code straight in and mapped
  // the returned boolean as if it were a Channel, fabricating `{ id: "undefined" }`: a reported
  // success that never subscribed anything. A real wiring is the two-step
  // `getChannelByInviteCode(inviteCode)` (Client.js:1707) → `subscribeToChannel(channel.id)` flow;
  // until that is verified against a live session, an honest 501 beats a phantom success.
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
  async subscribeToChannel(_inviteCode: string): Promise<Channel> {
    this.host.ensureReady();
    throw new EngineNotSupportedError('subscribeToChannel');
  }

  async unsubscribeFromChannel(channelId: string): Promise<void> {
    this.host.ensureReady();
    // The library resolves false instead of throwing when the unsubscription did not complete, which was surfaced as a
    // refusal rather than reported as a false success; the status says whether it was one.
    await this.writeToChannel(
      'unsubscribeFromChannel',
      'unsubscribe',
      channelId,
      `the unsubscription from channel ${channelId}`,
      `Failed to unsubscribe from channel ${channelId}`,
    );
    this.host.logger.debug('Unsubscribed from channel', { channelId });
  }

  async getChannelMessages(channelId: string, limit: number = 50): Promise<ChannelMessage[]> {
    this.host.ensureReady();
    // wwebjs 1.34.x has no client.getChannelById (calling it threw and the error was swallowed into an
    // empty list, #625). The subscribed Channel instances returned by getChannels() carry fetchMessages(),
    // so resolve the channel from that list and read its messages. A missing channel surfaces as a
    // ChannelNotFoundError (→ 404, like getChannelById) so callers can tell "no messages" apart from
    // "wrong/unsubscribed channel" instead of getting a silent [].
    const channels = await this.withPage('getChannelMessages', () =>
      (this.client() as unknown as BusinessClient).getChannels(),
    );
    const channel = channels?.find(c => readWid(c.id) === channelId);
    if (!channel) {
      throw new ChannelNotFoundError(channelId);
    }
    // wwebjs Channel.fetchMessages only honors a limit > 0: its load-earlier loop AND the final
    // splice are both gated on `searchOptions.limit > 0` (Channel.js:352), so a 0/negative/NaN
    // limit fails OPEN and returns every loaded message. Substitute the default instead.
    const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.trunc(limit) : 50;
    const messages = await this.withPage('getChannelMessages', () => channel.fetchMessages({ limit: safeLimit }));
    // WhatsApp Web keeps a deleted update in the list, as a `revoked` entry with no text and no media, and
    // the response has no field that could say so: a deleted update, and any entry that carries neither
    // text nor media, is left out.
    const posts = (messages ?? []).filter(
      msg => msg.type !== MessageTypes.REVOKED && (Boolean(msg.body) || Boolean(msg.hasMedia)),
    );
    return posts.map(msg => ({
      // Read `$1` before the sentinel (#747), and don't `String()` the object branch: that turned an
      // unreadable id into the literal "undefined" rather than the empty sentinel every other path
      // uses. Read-only endpoint — never persisted, never ack-matched — so `''` carries no collision
      // risk here; it just means "id unreadable".
      id: readWid(msg.id) || '',
      body: String(msg.body || ''),
      timestamp: Number(msg.timestamp),
      hasMedia: Boolean(msg.hasMedia),
    }));
  }
}
