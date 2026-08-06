import type { Response } from 'undici';
import { withSafeFetch } from '../../common/security/ssrf-guard';

/**
 * The link-preview payload WhatsApp accepts, in Baileys' own field names.
 *
 * `matched-text` is the URL as it appeared in the message: WhatsApp uses it to decide which part of
 * the text to render as the preview's anchor, so it must be the text that was matched, not the
 * normalised URL that was fetched.
 */
export interface SafeUrlInfo {
  'matched-text': string;
  'canonical-url': string;
  /** Required by WhatsApp. Falls back to the hostname, which is a fact about the URL, not a guess. */
  title: string;
  description?: string;
}

/**
 * Generate a link preview WITHOUT the library's own generator.
 *
 * Baileys ships one, but it delegates to `link-preview-js`, which carries an unfixed SSRF advisory
 * (GHSA-4gp8-rjrq-ch6q — "IPv6 and internal loopback attacks", CWE-918, no patched release). The
 * input here is attacker-influenced — a URL pasted into a message causes this server to make a
 * request — so that generator is never reached: Baileys spreads the caller's send options last
 * (messages-send.js:1086), so passing this as `getUrlInfo` there wins over its hardcoded one.
 *
 * `withSafeFetch` validates the destination and then PINS the connection to the vetted addresses, so
 * a hostname that resolves publicly once and to `127.0.0.1` a moment later cannot be used to reach
 * the loopback interface — the rebinding window that a validate-then-hand-off approach would leave
 * open. It also honours the deployment's own `WEBHOOK_SSRF_PROTECT` / `SSRF_ALLOWED_HOSTS` settings,
 * so an operator who intentionally allows an internal host keeps that behaviour here too.
 *
 * Returns undefined rather than throwing on any failure: a preview is decoration, and a site that is
 * slow, unreachable, or refused must never turn into a failed message send.
 */
export async function generateSafeLinkPreview(
  matchedText: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<SafeUrlInfo | undefined> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const maxBytes = opts.maxBytes ?? 512 * 1024;

  const url = normaliseUrl(matchedText);
  if (!url) return undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await withSafeFetch(
      url,
      {
        signal: controller.signal,
        // Only a document is useful here, and asking for it keeps a server from streaming back
        // something enormous that would be read and discarded.
        headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'WhatsApp/2' },
      },
      async response => {
        if (!response.ok) return undefined;
        const type = response.headers.get('content-type') ?? '';
        // Anything that is not markup has no metadata to read, and reading it would mean pulling an
        // arbitrary binary into memory for nothing.
        if (!type.includes('html') && !type.includes('xml')) return undefined;

        const html = await readCapped(response, maxBytes);
        const title = firstMatch(html, [
          /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i,
          /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i,
          /<title[^>]*>([^<]*)<\/title>/i,
        ]);
        const description = firstMatch(html, [
          /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i,
          /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i,
          /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
        ]);

        // A page with neither says nothing the raw link does not, so there is no point attaching a
        // preview at all.
        if (!title && !description) return undefined;

        return {
          'matched-text': matchedText,
          'canonical-url': url,
          // WhatsApp requires a title. When the page has none, the hostname is used — it is a fact
          // about the URL rather than an invention, and it is what a reader would call the site.
          title: title ? decodeEntities(title) : new URL(url).hostname,
          ...(description ? { description: decodeEntities(description) } : {}),
        };
      },
    );
  } catch {
    // Blocked destination, DNS failure, timeout, malformed response — all the same to a caller who
    // just wants their message sent.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Accept only http(s), and add a scheme to a bare `example.com` the way a reader would.
 *
 * Rejecting other schemes here matters: `file:`, `ftp:` and friends are not previewable and are the
 * shapes an attacker reaches for, and the fetch layer should never be asked about them at all.
 */
function normaliseUrl(matchedText: string): string | undefined {
  // Anything that ALREADY carries a scheme is judged on that scheme alone. Prefixing `https://` onto
  // it instead would turn `file:///etc/passwd` into `https://file:///etc/passwd`, which parses
  // happily as an https URL and would be handed to the fetch layer — a scheme filter that admits the
  // very schemes it exists to exclude.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(matchedText);
  if (hasScheme && !/^https?:\/\//i.test(matchedText)) return undefined;

  try {
    const parsed = new URL(hasScheme ? matchedText : `https://${matchedText}`);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read at most `maxBytes` of the body. A preview needs the `<head>`, which arrives first, so there is
 * no reason to accept a multi-gigabyte response from a host chosen by a stranger.
 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (!reader) return (await response.text()).slice(0, maxBytes);

  const decoder = new TextDecoder();
  let out = '';
  let read = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const value: Uint8Array = chunk.value;
    read += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (read >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  return out;
}

function firstMatch(html: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const value = pattern.exec(html)?.[1]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** The handful of entities that actually show up in title/description text. */
function decodeEntities(value: string): string {
  return (
    value
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      // Ampersand last: decoding it first would let `&amp;lt;` become `<`.
      .replace(/&amp;/g, '&')
  );
}
