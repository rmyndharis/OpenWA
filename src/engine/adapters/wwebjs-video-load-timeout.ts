import { EnginePageError } from '../../common/errors/engine-page.error';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * Page-side read of two facts worth having when WhatsApp Web's video load times out: whether the page
 * is hidden (a hidden page reproduced the timeout in a test) and what the browser answers for an
 * H.264/AAC MP4.
 */
function readVideoLoadConditions(): { visibility: string; h264Aac: string } {
  return {
    visibility: document.visibilityState,
    h264Aac: document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'),
  };
}

/** Read the page and the browser, then log them; a page or session that cannot answer logs nothing. */
async function logVideoLoadConditions(host: WwebjsEngineHost): Promise<void> {
  try {
    const client = host.getClient() as unknown as {
      pupPage: { evaluate<T>(fn: () => T): Promise<T> };
      pupBrowser: { version(): Promise<string> };
    };
    const [page, browser] = await Promise.all([
      client.pupPage.evaluate(readVideoLoadConditions),
      client.pupBrowser.version(),
    ]);
    host.logger.warn('WhatsApp Web timed out loading a video. See docs/12-troubleshooting-faq.md.', {
      sessionId: host.config.sessionId,
      action: 'video_load_timeout',
      pageVisibility: page.visibility,
      h264Aac: page.h264Aac,
      browser,
    });
  } catch {
    // Nothing to add: the failed send already carries its own error and log line.
  }
}

/**
 * Before WhatsApp Web uploads a video it loads it into a `<video>` element, and gives up after 20 s
 * with a bare `TimeoutError` (`WAWebMediaLoad`). A file the browser cannot decode fails in under a
 * second with a named error instead, so this timeout means the element neither loaded nor failed,
 * and the page has to say why (#1902).
 *
 * Called from the catch of a media send or status post, with the error already mapped. Never throws
 * and is not awaited: the send has already failed, and a wedged page must not hold its response.
 */
export function noteVideoLoadTimeout(host: WwebjsEngineHost, error: unknown, mimetype: string): void {
  // An EnginePageError always carries pageError (engine-page.error.ts). The regex cannot throw on a
  // missing mimetype, so the caller's rethrow is never replaced.
  if (
    error instanceof EnginePageError &&
    (error.getResponse() as { pageError: { name: string } }).pageError.name === 'TimeoutError' &&
    /^video\//.test(mimetype)
  ) {
    void logVideoLoadConditions(host);
  }
}
