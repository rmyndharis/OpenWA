import { type MessageMedia } from 'whatsapp-web.js';
import { EngineRefusedError } from '../../common/errors/engine-refused.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';

/** The part of Puppeteer's page the adapter's own page functions need. */
export interface EvaluatePage {
  evaluate<A extends unknown[], R>(fn: (...args: A) => R, ...args: A): Promise<Awaited<R>>;
}

/** One write the adapter runs in the page itself, with the WhatsApp Web job that whatsapp-web.js calls for it. */
export type PageWrite =
  | { kind: 'subject'; chatId: string; subject: string }
  | { kind: 'description'; chatId: string; description: string }
  | { kind: 'picture'; chatId: string; picture: MessageMedia }
  | { kind: 'property'; chatId: string; property: 'announcement' | 'restrict' | 'member_add_mode'; value: 0 | 1 };

/**
 * What the page answers: the status WhatsApp gave, `'missing'` when the build has no job to run the write with, or
 * `'no-helpers'` when whatsapp-web.js has not installed its helpers (`window.WWebJS`) into the page, which is a page
 * that is reloading. `local` marks a refusal the page decided on its own, from what it knows of the account, before
 * anything was sent.
 */
export type PageWriteAnswer = { status: number; local?: true } | 'missing' | 'no-helpers';

/**
 * Run one group or profile write IN-PAGE through the WhatsApp Web job whatsapp-web.js calls for it, and answer the
 * status WhatsApp gave. The library reads every status as `false` (a refusal), and the adapter read `false` as missing
 * admin rights, so a rate limit (423, 429), a timeout (408) or a server error (5xx), which removed or changed nothing
 * and may pass later, was reported as a 403. The status says which it was.
 *
 * A status is answered however the build reports it: `ServerStatusCodeError` and its Mex subclass carry it as
 * `.status`, the property writes of the current build RESOLVE the response union instead (`SetPropertyResponse*`),
 * and the page refuses a write the account may not make with an `ActionError`, which is a 403 that WhatsApp was never
 * asked for (`local`). Any other answer of the
 * job is the library's own success, and any other failure is rethrown.
 *
 * Every lookup tests the answer and guards the throw: from a page.evaluate Meta's `require` answers `undefined` for a
 * module the page has not defined (its error guard swallows the `ModuleError`), and throws that error only inside a
 * guard or before the page's error setup has run. A document with no `require` at all is a page that is reloading, not
 * a build without the job, so that failure is let through. Nothing is sent when the page cannot run the write. A page without the helper whatsapp-web.js installs for it (`getChat` for
 * a description or a property, `cropAndResizeImage` for a picture, `window.WWebJS` itself for a subject) is answered
 * `'no-helpers'`, and it is told first: a page that has not been re-injected cannot be judged on its jobs. Otherwise a
 * job the build lacks, or the wid factory or random id it needs, is answered `'missing'`. The library's own call reads
 * the same modules and helpers, so it could not do better and is not run. Self-contained, since Puppeteer ships it to
 * the page as source.
 */
export async function runWriteInPage(write: PageWrite): Promise<PageWriteAnswer> {
  type Module = Record<string, unknown> | undefined;
  type Call = (...args: unknown[]) => unknown;
  type Union = {
    name?: unknown;
    value?: {
      errorSetPropertyClientErrors?: { value?: { code?: unknown } };
      errorServerErrors?: { value?: { code?: unknown } };
    };
  };
  const w = window as unknown as { require: (m: string) => unknown; WWebJS?: Record<string, unknown> };
  const find = (name: string): Module => {
    try {
      return w.require(name) as Module;
    } catch (err) {
      if (typeof w.require !== 'function') throw err;
      return undefined;
    }
  };
  const call = (mod: Module, name: string): Call | undefined =>
    typeof mod?.[name] === 'function' ? (mod[name] as Call).bind(mod) : undefined;

  const createWid = call(find('WAWebWidFactory'), 'createWid');
  const getChat = call(w.WWebJS, 'getChat');
  const crop = call(w.WWebJS, 'cropAndResizeImage');
  let run: (() => Promise<{ status: number; local?: true }>) | undefined;
  if (createWid) {
    switch (write.kind) {
      case 'subject': {
        const set = call(find('WAWebGroupModifyInfoJob'), 'setGroupSubject');
        if (set) {
          run = async () => {
            await set(createWid(write.chatId), write.subject);
            return { status: 200 };
          };
        }
        break;
      }
      case 'description': {
        const set = call(find('WAWebGroupModifyInfoJob'), 'setGroupDescription');
        const randomHex = call(find('WARandomHex'), 'randomHex');
        if (set && randomHex && getChat) {
          run = async () => {
            const chat = (await getChat(write.chatId, { getAsModel: false })) as { groupMetadata: { descId: unknown } };
            await set({
              desc: write.description === '' ? null : write.description,
              groupWid: createWid(write.chatId),
              newDescId: randomHex(8),
              prevDescId: chat.groupMetadata.descId,
            });
            return { status: 200 };
          };
        }
        break;
      }
      case 'picture': {
        const thumbs = (find('WAWebCollections') as { ProfilePicThumb?: Module } | undefined)?.ProfilePicThumb;
        const known = call(thumbs, 'get');
        const lookup = call(thumbs, 'find');
        const send = call(find('WAWebContactProfilePicThumbBridge'), 'sendSetPicture');
        if (known && lookup && send && crop) {
          run = async () => {
            const thumbnail = await crop(write.picture, { asDataUrl: true, mimetype: 'image/jpeg', size: 96 });
            const profilePic = await crop(write.picture, { asDataUrl: true, mimetype: 'image/jpeg', size: 640 });
            const entry = (known(write.chatId) || (await lookup(write.chatId))) as
              { canSet: () => boolean } | undefined;
            // The page's own copy of the picture says the account may not set it: a refusal, as the library reads it.
            if (!entry?.canSet()) return { status: 403, local: true };
            const res = (await send(createWid(write.chatId), thumbnail, profilePic)) as
              { status?: unknown } | undefined;
            return { status: typeof res?.status === 'number' ? res.status : 403 };
          };
        }
        break;
      }
      case 'property': {
        const set = call(find('WAWebSetPropertyGroupAction'), 'setGroupProperty');
        if (set && getChat) {
          run = async () => {
            const chat = await getChat(write.chatId, { getAsModel: false });
            const response = (await set(chat, write.property, write.value)) as Union | undefined;
            if (response?.name === 'SetPropertyResponseClientError') {
              return { status: Number(response.value?.errorSetPropertyClientErrors?.value?.code) || 403 };
            }
            if (response?.name === 'SetPropertyResponseServerError') {
              return { status: Number(response.value?.errorServerErrors?.value?.code) || 500 };
            }
            return { status: 200 };
          };
        }
        break;
      }
    }
  }
  if (!run) {
    const helper = write.kind === 'picture' ? crop : write.kind === 'subject' ? w.WWebJS : getChat;
    return helper ? 'missing' : 'no-helpers';
  }
  try {
    return await run();
  } catch (err) {
    const failure = err as { name?: unknown; status?: unknown } | undefined;
    if (failure?.name === 'ActionError') return { status: 403, local: true };
    if (typeof failure?.name === 'string' && failure.name.endsWith('ServerStatusCodeError')) {
      return { status: typeof failure.status === 'number' ? failure.status : 403 };
    }
    throw err;
  }
}

/**
 * What the page answers to a pin or an unpin: whether WhatsApp took it, the status the page gave instead (`local` marks
 * a refusal the page decided on its own, before anything was sent), `'legacy'` when the build's sender still takes the
 * positional arguments whatsapp-web.js passes (the caller then runs the library's own call), or `'missing'` when the
 * build has no sender this can call.
 */
export type PinAnswer = boolean | { status: number; local?: true } | 'legacy' | 'missing';

/**
 * Pin or unpin a message IN-PAGE through the page's own sender, called the way the running build takes it. whatsapp-web.js
 * calls `WAWebSendPinMessageAction.sendPinInChatMsg(message, action, duration)`, which the builds up to 2.3000.1050403604
 * declare (four positional parameters). The builds from 2.3000.1052565782 take ONE options object, `{ msg, pinType,
 * pinExpiryDurationOption }`, so the library hands the message over as the options, and the sender dies reading the
 * `id` of the undefined message before anything is sent; the library has also replaced `getPinExpiryDuration` by then
 * and puts it back only after a send that worked.
 *
 * The shape is told by the sender's arity. One parameter is the options object, called as the page's own pin dialog
 * calls it: the pin type and the option of the duration are the page's (`Message$PinInChatMessage$Type`,
 * `getPinExpiryOption`), and nothing of the page is replaced. Three or more is the positional shape and answers
 * `'legacy'`. Any other arity, or a build without the sender, the enum, the option mapper or the message collection,
 * answers `'missing'` before anything was sent. The sender resolves the send result when WhatsApp took the pin, resolves
 * nothing for a type it does not know, and throws a plain error when the send did not go through, which is the refusal
 * the library read as `false`; a duration the page has no option for is the same refusal. The sender throws that error
 * for every send the page recorded as failed, a rate limit and a timeout included, and keeps nothing of why, so those
 * cannot be told from a refusal here. Two failures come before the result of the send and carry their own: a chat with a
 * contact the account blocked is refused by the page with a `ContactBlocked` error before anything is sent (answered as
 * a refusal of the page's own), and the group's metadata is read first, which WhatsApp Web asks WhatsApp for again after
 * a reconnect, so that read can reject `ServerStatusCodeError(status)` (answered as that status, a status-less error as
 * 403).
 *
 * Every lookup tests the answer and guards the throw: from a page.evaluate Meta's `require` answers `undefined` for a
 * module the page has not defined, and throws only inside a guard or before the page's error setup has run. A document
 * with no `require` at all is a page that is reloading, not a build without the sender, so that failure is let through.
 * Self-contained, since Puppeteer ships it to the page as source.
 */
export async function pinInPage(messageId: string, pin: boolean, durationSeconds: number): Promise<PinAnswer> {
  type Module = Record<string, unknown> | undefined;
  type Call = (...args: unknown[]) => unknown;
  type Messages = { get?: Call; getMessagesById?: Call } | undefined;
  const w = window as unknown as { require: (m: string) => unknown };
  const find = (name: string): Module => {
    try {
      return w.require(name) as Module;
    } catch (err) {
      if (typeof w.require !== 'function') throw err;
      return undefined;
    }
  };
  const call = (mod: Module, name: string): Call | undefined =>
    typeof mod?.[name] === 'function' ? (mod[name] as Call).bind(mod) : undefined;

  const send = call(find('WAWebSendPinMessageAction'), 'sendPinInChatMsg');
  if (!send) return 'missing';
  if (send.length >= 3) return 'legacy';
  const types = find('WAWebProtobufsE2E.pb')?.Message$PinInChatMessage$Type as Record<string, unknown> | undefined;
  const pinType = types?.[pin ? 'PIN_FOR_ALL' : 'UNPIN_FOR_ALL'];
  const toOption = call(find('WAWebPinMsgConstants'), 'getPinExpiryOption');
  const messages = find('WAWebCollections')?.Msg as Messages;
  const getMessage = call(messages, 'get');
  const findMessages = call(messages, 'getMessagesById');
  if (send.length !== 1 || typeof pinType !== 'number' || (pin && !toOption) || !getMessage) return 'missing';

  // The library's own lookup of the message: the collection first, then the page's store.
  const message =
    getMessage(messageId) ??
    ((await findMessages?.([messageId])) as { messages?: unknown[] } | undefined)?.messages?.[0];
  if (!message) return false;
  try {
    const sent = (await send({
      msg: message,
      pinType,
      pinExpiryDurationOption: pin ? toOption?.(durationSeconds) : undefined,
    })) as { messageSendResult?: unknown } | null | undefined;
    return sent?.messageSendResult === 'OK';
  } catch (err) {
    const failure = err as { name?: unknown; message?: unknown; status?: unknown } | undefined;
    if (
      typeof failure?.message === 'string' &&
      /PinInChat send Error|Unexpeded pin expiry duration/.test(failure.message)
    ) {
      return false;
    }
    if (failure?.name === 'ContactBlocked') return { status: 403, local: true };
    if (typeof failure?.name === 'string' && failure.name.endsWith('ServerStatusCodeError')) {
      return { status: typeof failure.status === 'number' ? failure.status : 403 };
    }
    throw err;
  }
}

/** What a failed write says, with the wording each write gives its own refusal. */
export interface WriteOutcome {
  /** What was asked of WhatsApp, as "the subject change for group G". */
  request: string;
  /** What a rate limit or a server error leaves, as "changed nothing". */
  nothing: string;
  /** The refusal, given the status WhatsApp refused with, or `local` when the page refused it without asking WhatsApp. */
  refused: (status: number, local: boolean) => string;
}

/** The statuses a request may pass on a later try: a timeout, a rate limit and a server error. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 423 || status === 429 || status >= 500;
}

/**
 * Settle the status WhatsApp answered to a write the adapter sent itself: 2xx is done; 408, 423, 429 and 5xx are a
 * retryable failure (a 503), since a timeout, a rate limit or a server error means nothing was applied and the same
 * request may pass a moment later; any other code is the refusal (a 403).
 */
export function settleWriteStatus(status: number, outcome: WriteOutcome, local = false): void {
  if (status >= 200 && status < 300) return;
  if (isRetryableStatus(status)) {
    throw new EngineTransportError(
      `WhatsApp answered ${status} to ${outcome.request} and ${outcome.nothing}. Retry after a pause.`,
    );
  }
  throw new EngineRefusedError(outcome.refused(status, local));
}
