import { type Client } from 'whatsapp-web.js';
import { CallLinkType, MediaInput } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';
import { toMessageMedia } from './wwebjs-messaging';
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

  async deleteProfilePicture(): Promise<void> {
    this.host.ensureReady();
    // `Promise<boolean>` understates this. `WWebJS.deletePicture` has three exits
    // (Injected/Utils.js:1404-1418): `undefined` when `canDelete()` was false and nothing was
    // attempted, `true` on an HTTP 200, `false` on a ServerStatusCodeError. `undefined` is falsy, so
    // the usual `if (!ok) throw` would report "there was nothing to delete" as a refusal and turn a
    // repeat delete into a 403. Only an explicit `false` is WhatsApp saying no.
    const result = await withPageWrite(this.host, 'deleteProfilePicture', () => this.client().deleteProfilePicture());
    if (result === false) {
      throw new EngineRefusedError('the engine rejected the profile picture removal');
    }
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
    // read as a refusal. It is addressed by the id of the account itself, which a client that has not reported it yet
    // does not have.
    const chatId = client.info?.wid?._serialized;
    if (!chatId)
      throw new EngineNotReadyError('The WhatsApp client has not reported its own account id yet. Retry shortly.');
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
