import { type Client } from 'whatsapp-web.js';
import { CallLinkType, MediaInput } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { toMessageMedia } from './wwebjs-messaging';
import { deleteGroupPictureInPage } from './wwebjs-groups';
import { type EvaluatePage, runWriteInPage, settleWriteStatus } from './wwebjs-page-writes';
import { type WwebjsEngineHost, withPageWrite, reportPageDeath } from './wwebjs-host';
import { PAGE_RELOADING_MESSAGE } from './wwebjs-lifecycle';

/**
 * Whether the page's `WAWebContactStatusBridge` still exports `setMyStatus`, which `Client.setStatus` calls. The build
 * the gateway selects today exports only `queryStatusAll` and `sendReadStatus`: the About text is an expiring text
 * status there, set through modules the library does not call, so the call was a TypeError in the page. From a
 * page.evaluate Meta's `require` answers `undefined` for a module the page has not defined, and throws only inside a
 * guard or before the page's error setup has run, so the lookup tests the answer and guards the throw. A document with
 * no `require` at all is a page that is reloading, not a build without the setter, and that failure is let through
 * (spelled as the library spells it, which is how the reload is read).
 */
export function readStatusSetterInPage(): boolean {
  type Bridge = { setMyStatus?: unknown } | undefined;
  let bridge: Bridge;
  try {
    bridge = (window as unknown as { require: (m: string) => Bridge }).require('WAWebContactStatusBridge');
  } catch (err) {
    if (typeof (window as unknown as { require?: unknown }).require !== 'function') throw err;
  }
  return typeof bridge?.setMyStatus === 'function';
}

/**
 * Own-account profile operations extracted from WhatsAppWebJsAdapter. The adapter keeps the public
 * methods as thin forwarders and injects the shared host surface (./wwebjs-host) via closures, so
 * the delegate never touches lifecycle state directly.
 */
export class WwebjsProfile {
  constructor(private readonly host: WwebjsEngineHost) {}

  /** Post-ensureReady client handle. */
  private client(): Client {
    return this.host.getClient();
  }

  async createCallLink(type: CallLinkType, startTime: number): Promise<string> {
    this.host.ensureReady();
    // whatsapp-web.js rejects any callType outside 'voice' | 'video', so the neutral 'audio' maps
    // here. It floors the Date to seconds itself, so the epoch-milliseconds the contract takes goes
    // straight into the Date.
    // Non-idempotent: each call mints a NEW server-side link, so a client replaying a 503 would
    // create a second one. Report a dead page and keep the 500. Same rule as createChannel; see
    // reportPageDeath.
    const link = await reportPageDeath(this.host, 'createCallLink', () =>
      this.client().createCallLink(new Date(startTime), type === 'video' ? 'video' : 'voice'),
    );
    if (!link) {
      // Documented as "the link, or an empty string if a generation failed" — returning that empty
      // string would hand the caller a success with nothing in it.
      throw new EngineRefusedError('WhatsApp did not return a call link');
    }
    return link;
  }

  /**
   * The id of the account itself, which the picture writes address. A client that has not reported it yet has none,
   * and the write asks nothing of the page.
   */
  private ownAccountId(): string {
    const id = this.client().info?.wid?._serialized;
    if (!id)
      throw new EngineNotReadyError('The WhatsApp client has not reported its own account id yet. Retry shortly.');
    return id;
  }

  async deleteProfilePicture(): Promise<void> {
    this.host.ensureReady();
    const chatId = this.ownAccountId();
    // The request is sent in-page, so that WhatsApp's own status decides the answer: the library's deleteProfilePicture
    // resolves false for every status, and a rate limit or a server error, which removed nothing and may pass later,
    // read as a refusal. The request is the one that removes a group's picture, addressed by the id of the account.
    const status = await withPageWrite(this.host, 'deleteProfilePicture', () =>
      (this.client() as unknown as { pupPage: EvaluatePage }).pupPage.evaluate(deleteGroupPictureInPage, chatId),
    );
    // A build without the job: nothing was asked of WhatsApp, so this is neither a refusal nor a failure to retry.
    if (status === 'missing') {
      throw new EngineNotSupportedError('deleteProfilePicture(no picture delete job on this build)');
    }
    // A repeat is the same request, and converges while WhatsApp answers 200 for an account with no picture left, as it
    // does for a group with none.
    settleWriteStatus(status, {
      request: 'the profile picture removal',
      nothing: 'removed nothing',
      refused: refusedWith => `the engine rejected the profile picture removal (WhatsApp answered ${refusedWith})`,
    });
    this.host.logger.log('Deleted profile picture');
  }

  async setProfileName(name: string): Promise<void> {
    this.host.ensureReady();
    // setDisplayName resolves false (rather than throwing) when WhatsApp refuses the rename.
    const ok = await withPageWrite(this.host, 'setProfileName', () => this.client().setDisplayName(name));
    if (!ok) {
      throw new EngineRefusedError('the engine rejected the profile name change');
    }
    this.host.logger.log('Updated profile name');
  }

  async setProfileStatus(status: string): Promise<void> {
    this.host.ensureReady();
    const client = this.client();
    const page = (client as unknown as { pupPage: { evaluate: <T>(fn: () => T) => Promise<T> } }).pupPage;
    await withPageWrite(this.host, 'setProfileStatus', async () => {
      // A build with no setter: nothing is asked of WhatsApp, so this is neither a refusal nor a failure to retry.
      if (!(await page.evaluate(readStatusSetterInPage))) {
        throw new EngineNotSupportedError('setProfileStatus(no status setter on this build)');
      }
      await client.setStatus(status);
    });
    this.host.logger.log('Updated profile status');
  }

  async setProfilePicture(media: MediaInput): Promise<void> {
    this.host.ensureReady();
    const messageMedia = await toMessageMedia(media, this.host.config.proxy?.url);
    const client = this.client();
    // The picture is sent in-page, so that WhatsApp's own status decides the answer: the library's setProfilePicture
    // resolves false for every status, and a rate limit or a server error, which changed nothing and may pass later,
    // read as a refusal. It is addressed by the id of the account itself.
    const chatId = this.ownAccountId();
    const answer = await withPageWrite(this.host, 'setProfilePicture', () =>
      (client as unknown as { pupPage: EvaluatePage }).pupPage.evaluate(runWriteInPage, {
        kind: 'picture',
        chatId,
        picture: messageMedia,
      }),
    );
    // Nothing was sent when the page cannot run the write: a page without whatsapp-web.js's helpers is reloading, and
    // a build without the job has none to run. The library's own call needs the same modules, so it is not tried.
    if (answer === 'no-helpers') throw new EngineNotReadyError(PAGE_RELOADING_MESSAGE);
    if (answer === 'missing') throw new EngineNotSupportedError('setProfilePicture(no write job on this build)');
    const refusal = 'the engine rejected the profile picture change';
    settleWriteStatus(
      answer.status,
      {
        request: 'the profile picture change',
        nothing: 'changed nothing',
        refused: (status, local) =>
          local
            ? `${refusal} (the page says this account may not change it, nothing was sent)`
            : `${refusal} (WhatsApp answered ${status})`,
      },
      answer.local,
    );
    this.host.logger.log('Updated profile picture');
  }
}
