import { type createLogger } from '../../common/services/logger.service';
import { type EvaluatablePage } from './wwebjs-call-hook-check';

/**
 * Page-side probe: the build WhatsApp Web reports for itself, the same `window.Debug.VERSION`
 * whatsapp-web.js waits for during inject and returns from `getWWebVersion()`. Returned untyped:
 * whatever the page answers is checked on this side, see {@link reportRunningWebBuild}.
 */
function readRunningWebBuild(): unknown {
  return (window as unknown as { Debug?: { VERSION?: unknown } }).Debug?.VERSION;
}

/**
 * The numeric part of a WhatsApp Web version. A pin carries the registry's suffix
 * (`2.3000.1047787617-alpha`) while the page reports the bare build (`2.3000.1047868043`), so the
 * two only compare once the suffix is gone. `null` for a string that does not start with one.
 */
function numericBuild(version: string): string | null {
  return /^\d+(?:\.\d+)*/.exec(version.trim())?.[0] ?? null;
}

/**
 * Log the WhatsApp Web build a ready session's page actually runs, and warn when it is not the
 * pinned one.
 *
 * whatsapp-web.js applies a pin by answering the page's document request from its request
 * interceptor, so the pin holds only for a page load that goes through it. WhatsApp Web's service
 * worker can answer the document from its own cache without the request ever reaching the
 * interceptor. (A pin whose HTML could not be fetched is dropped before the Client is built: it
 * logs `web_version_html_unavailable`, no pin is requested, and the page loads the live build.) In
 * the service-worker case the startup line `Pinning WhatsApp Web version …` still names the pin,
 * and nothing read back the build that actually booted, so a session reported to be on one build
 * could be running another.
 *
 * The comparison is on the numeric build only (see {@link numericBuild}). A pin that does not parse
 * as one cannot be compared, and gets the info line rather than a warning. A read that fails or
 * answers nothing usable stays silent: a page that died mid-read, or one without `window.Debug`,
 * says nothing about which build is running.
 *
 * Deliberately advisory, like the call-hook check it sits next to: it never changes the session's
 * status, and the caller does not await it.
 */
export async function reportRunningWebBuild(
  page: EvaluatablePage | undefined,
  logger: ReturnType<typeof createLogger>,
  sessionId: string,
  pinnedVersion: string | undefined,
): Promise<void> {
  if (!page) return;
  let runningVersion: unknown;
  try {
    runningVersion = await page.evaluate(readRunningWebBuild);
  } catch {
    return; // a page that died mid-read says nothing about the build
  }
  // Checked here rather than in the page function: this promise is never awaited, so anything the
  // page answers that is not a build string must end the probe quietly instead of rejecting it.
  if (typeof runningVersion !== 'string' || runningVersion === '') return;
  const pinned = pinnedVersion ? numericBuild(pinnedVersion) : null;
  const running = numericBuild(runningVersion);
  if (pinned && running && pinned !== running) {
    logger.warn(
      `WhatsApp Web build ${runningVersion} is running on this session's page, not the pinned build ` +
        `${pinnedVersion}: the pin did not take effect for this page load. See docs/12-troubleshooting-faq.md.`,
      { sessionId, action: 'web_version_pin_not_applied', runningVersion, pinnedVersion },
    );
    return;
  }
  logger.log(`WhatsApp Web build ${runningVersion} is running on this session's page`, {
    sessionId,
    action: 'web_version_running',
    runningVersion,
    pinnedVersion: pinnedVersion ?? null,
  });
}
