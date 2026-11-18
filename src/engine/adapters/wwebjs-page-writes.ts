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

/** What the page answers: the status WhatsApp gave, or `'missing'` when it has no job to run the write with. */
export type PageWriteAnswer = { status: number } | 'missing';

/**
 * Run one group or profile write IN-PAGE through the WhatsApp Web job whatsapp-web.js calls for it, and answer the
 * status WhatsApp gave. The library reads every status as `false` (a refusal), and the adapter read `false` as missing
 * admin rights, so a rate limit (423, 429) or a server error (5xx), which removed or changed nothing and may pass
 * later, was reported as a 403. The status says which it was.
 *
 * A status is answered however the build reports it: `ServerStatusCodeError` and its Mex subclass carry it as
 * `.status`, the property writes of the current build RESOLVE the response union instead (`SetPropertyResponse*`),
 * and the page refuses a write the account may not make with an `ActionError`, which is a 403. Any other answer of the
 * job is the library's own success, and any other failure is rethrown.
 *
 * Every lookup is guarded, since `require` throws for a module a build does not define, and a document with no
 * `require` at all is a page that is reloading, not a build without the job, so that failure is let through. A job or
 * helper the page lacks is answered `'missing'` before anything was sent, so the caller can run the library's own call
 * instead without a write going out twice. Self-contained, since Puppeteer ships it to the page as source.
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
  let run: (() => Promise<number>) | undefined;
  if (createWid) {
    switch (write.kind) {
      case 'subject': {
        const set = call(find('WAWebGroupModifyInfoJob'), 'setGroupSubject');
        if (set) {
          run = async () => {
            await set(createWid(write.chatId), write.subject);
            return 200;
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
            return 200;
          };
        }
        break;
      }
      case 'picture': {
        const thumbs = (find('WAWebCollections') as { ProfilePicThumb?: Module } | undefined)?.ProfilePicThumb;
        const known = call(thumbs, 'get');
        const lookup = call(thumbs, 'find');
        const send = call(find('WAWebContactProfilePicThumbBridge'), 'sendSetPicture');
        const crop = call(w.WWebJS, 'cropAndResizeImage');
        if (known && lookup && send && crop) {
          run = async () => {
            const thumbnail = await crop(write.picture, { asDataUrl: true, mimetype: 'image/jpeg', size: 96 });
            const profilePic = await crop(write.picture, { asDataUrl: true, mimetype: 'image/jpeg', size: 640 });
            const entry = (known(write.chatId) || (await lookup(write.chatId))) as
              { canSet: () => boolean } | undefined;
            // The page's own copy of the picture says the account may not set it: a refusal, as the library reads it.
            if (!entry?.canSet()) return 403;
            const res = (await send(createWid(write.chatId), thumbnail, profilePic)) as
              { status?: unknown } | undefined;
            return typeof res?.status === 'number' ? res.status : 403;
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
              return Number(response.value?.errorSetPropertyClientErrors?.value?.code) || 403;
            }
            if (response?.name === 'SetPropertyResponseServerError') {
              return Number(response.value?.errorServerErrors?.value?.code) || 500;
            }
            return 200;
          };
        }
        break;
      }
    }
  }
  if (!run) return 'missing';
  try {
    return { status: await run() };
  } catch (err) {
    const failure = err as { name?: unknown; status?: unknown } | undefined;
    if (failure?.name === 'ActionError') return { status: 403 };
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
  /** The refusal, given the status WhatsApp refused with. */
  refused: (status: number) => string;
}

/**
 * Settle the status WhatsApp answered to a write the adapter sent itself: 2xx is done; 423, 429 and 5xx are a
 * retryable failure (a 503), since a rate limit or a server error means nothing was applied and the same request may
 * pass a moment later; any other code is the refusal (a 403).
 */
export function settleWriteStatus(status: number, outcome: WriteOutcome): void {
  if (status >= 200 && status < 300) return;
  if (status === 423 || status === 429 || status >= 500) {
    throw new EngineTransportError(
      `WhatsApp answered ${status} to ${outcome.request} and ${outcome.nothing}. Retry after a pause.`,
    );
  }
  throw new EngineRefusedError(outcome.refused(status));
}
