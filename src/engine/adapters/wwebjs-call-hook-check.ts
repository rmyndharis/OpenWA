import { type createLogger } from '../../common/services/logger.service';

/** The narrow slice of the Puppeteer page this check needs, so nothing here depends on puppeteer. */
export interface EvaluatablePage {
  evaluate<T>(fn: () => T): Promise<T>;
}

/**
 * Page-side probe: is whatsapp-web.js' incoming-call hook installed on this page?
 *
 * The library detects a call by replacing ONE function, the call collection's internal `Map.set`
 * (`Client.js`, attachEventListeners). A patched `set` is a JS function; an untouched one stringifies
 * with `[native code]`. Returns `null` when the collection is not in the page's module graph at all,
 * which is not the same answer as "the hook is missing".
 */
function readCallHookState(): boolean | null {
  const w = window as unknown as { require?: (name: string) => Record<string, unknown> | undefined };
  if (typeof w.require !== 'function') return null;
  let collection: Record<string, unknown> | undefined;
  try {
    collection = w.require('WAWebCallCollection');
  } catch {
    return null;
  }
  if (!collection) return null;
  const owned = collection;
  const mapKey = Object.keys(owned).find(key => owned[key] instanceof Map);
  if (!mapKey) return null;
  const setter = (owned[mapKey] as { set: unknown }).set;
  return !String(setter).includes('[native code]');
}

/**
 * Warn when a ready session's page carries no call hook.
 *
 * whatsapp-web.js patches the call collection only when the page's module for it exposes an `.on`
 * function. That is the one failure this check can actually see: a WhatsApp Web build that keeps
 * the module and its internal Map but drops or renames `.on` makes the library skip the hook while
 * the rest of the evaluate completes, so the session looks completely healthy, keeps delivering
 * messages, and never reports a single incoming call. Operators have no way to see that from the
 * outside, so say it in the log.
 *
 * The neighbouring failures are NOT this one and are deliberately not reported. A build that
 * removes or renames the module makes the library's own `require` for it throw, which aborts the
 * whole evaluate and takes the inbound message bridge registered after it, so that session is
 * loudly broken for messages too. A build that restructures the collection past recognition leaves
 * {@link readCallHookState} with nothing to compare and it answers `null`. Both read as
 * inconclusive here, and inconclusive stays silent.
 *
 * Deliberately advisory: it never changes the session's status. Detection is the only thing lost,
 * and a false alarm on an inconclusive read would send operators after a problem they do not have.
 */
export async function reportMissingCallHook(
  page: EvaluatablePage | undefined,
  logger: ReturnType<typeof createLogger>,
  sessionId: string,
): Promise<void> {
  if (!page) return;
  let installed: boolean | null;
  try {
    installed = await page.evaluate(readCallHookState);
  } catch {
    return; // a page that died mid-read says nothing about the hook
  }
  if (installed !== false) return;
  logger.warn(
    'Incoming calls cannot be detected on this session: the page-side call hook is not installed. ' +
      'Messages are unaffected. This is a mismatch between whatsapp-web.js and the WhatsApp Web ' +
      'build it loaded, so a restart only helps if the page was in a transient state; if it repeats, ' +
      'the library needs an update. Switch the session to the Baileys engine to keep call events.',
    { sessionId, action: 'call_hook_missing' },
  );
}
