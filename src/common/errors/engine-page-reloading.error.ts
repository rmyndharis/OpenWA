import { EngineNotReadyError } from './engine-not-ready.error';

/** What a request answers 409 while WhatsApp Web reloads its page, whichever side of the window stamp it lands. */
export const PAGE_RELOADING_MESSAGE =
  'WhatsApp Web is reloading its page and the session is re-injecting. Retry every few seconds: ' +
  'this can last a few minutes.';

/** The stable `code` of {@link EnginePageReloadingError}. */
export const ENGINE_PAGE_RELOADING = 'ENGINE_PAGE_RELOADING';

/** The interval a client is told to ask again at: the window ends without an event, so it can only be polled. */
export const PAGE_RELOADING_RETRY_AFTER_SECONDS = 5;

/**
 * The not-ready 409 of a whatsapp-web.js session whose page WhatsApp Web is reloading. The session still reads
 * `ready` and no event marks the end of the window, so the body carries what a client cannot otherwise know: a
 * stable `code` that tells this conflict from every other 409, and `retryAfterSeconds`, the interval to ask again
 * at.
 *
 * Only for a request that is safe to repeat: one refused before it reached the page, or a read or a write that
 * converges when repeated. A send whose first attempt may have left the page answers a plain
 * {@link EngineNotReadyError} instead, which tells nobody to send it again.
 */
export class EnginePageReloadingError extends EngineNotReadyError {
  constructor() {
    super({
      statusCode: 409,
      error: 'Conflict',
      message: PAGE_RELOADING_MESSAGE,
      code: ENGINE_PAGE_RELOADING,
      retryAfterSeconds: PAGE_RELOADING_RETRY_AFTER_SECONDS,
    });
  }
}
