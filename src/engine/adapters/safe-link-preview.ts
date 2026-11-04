import type { Response } from 'undici';
import { withSafeFetch } from '../../common/security/ssrf-guard';
import { urlFetchProxy } from '../../common/security/proxy-dispatcher';

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
 * `withSafeFetch` validates the destination and then PINS a direct or SOCKS-proxied connection to the
 * vetted addresses, so a hostname that resolves publicly once and to `127.0.0.1` a moment later cannot
 * be used to reach the loopback interface, the rebinding window that a validate-then-hand-off
 * approach would leave open. Behind an HTTP/HTTPS session proxy the proxy resolves the name itself,
 * so that window stays open there (SESSION_PROXY_URL_FETCH=false or a SOCKS proxy closes it).
 * Like media-by-URL fetches, it is always guarded: `WEBHOOK_SSRF_PROTECT` does not turn it off, and
 * an operator who intentionally allows an internal host lists it in `SSRF_ALLOWED_HOSTS`.
 *
 * Returns undefined rather than throwing on any failure: a preview is decoration, and a site that is
 * slow, unreachable, or refused must never turn into a failed message send. That includes an
 * unusable session proxy: no preview is attached, and the fetch never falls back to a direct one.
 */
export async function generateSafeLinkPreview(
  matchedText: string,
  opts: { timeoutMs?: number; maxBytes?: number; sessionProxyUrl?: string } = {},
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
        // One pass over the <meta> tags, each read only up to the next '<', then one attribute at a
        // time. Matching attribute pairs across the whole body backtracks from every '<meta' to the
        // end of the text: a crafted page of unclosed tags held the event loop for minutes.
        const metas = new Map<string, string>();
        for (const [, attrs] of html.matchAll(/<meta\b([^<]*)/gi)) {
          const key = (attribute(attrs, 'property') ?? attribute(attrs, 'name'))?.toLowerCase();
          const content = attribute(attrs, 'content');
          if (key && content && !metas.has(key)) metas.set(key, content);
        }
        const title = metas.get('og:title') ?? /<title\b[^<>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
        const description = metas.get('og:description') ?? metas.get('description');

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
      // The fetched URL comes from the message text, so it is caller-supplied the same way a media
      // URL is: on a proxied session it leaves through the session proxy (#1626). A bare domain, an
      // http link and a short link all answer with a redirect; the guard vets every hop it follows.
      { proxyUrl: urlFetchProxy(opts.sessionProxyUrl), followRedirects: true },
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
    // The chunk that reaches the cap may run past it: only the bytes up to the cap are kept.
    const value: Uint8Array = chunk.value.subarray(0, Math.max(0, maxBytes - read));
    read += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (read >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  return out;
}

/**
 * A quoted attribute's trimmed value from one tag's attribute text. The value ends at the quote that
 * opened it, so an apostrophe inside a double-quoted title stays part of it.
 */
function attribute(attrs: string, name: 'property' | 'name' | 'content'): string | undefined {
  const m = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  return (m?.[1] ?? m?.[2])?.trim();
}

/**
 * The Latin-1 named references (HTML 2), in code point order from U+00A0. `nbsp` is then replaced by a
 * plain space, as it always was here.
 */
const LATIN1_NAMES =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute ' +
  'micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring ' +
  'AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml ' +
  'times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil ' +
  'egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ' +
  'ugrave uacute ucirc uuml yacute thorn yuml';

/** Named references, as code points: the five markup ones, the typographic punctuation, and Latin-1. */
const NAMED_ENTITIES = new Map<string, number>([
  ...LATIN1_NAMES.split(' ').map((name, index): [string, number] => [name, 0xa0 + index]),
  ['nbsp', 0x20],
  ['quot', 0x22],
  ['amp', 0x26],
  ['apos', 0x27],
  ['lt', 0x3c],
  ['gt', 0x3e],
  ['ndash', 0x2013],
  ['mdash', 0x2014],
  ['lsquo', 0x2018],
  ['rsquo', 0x2019],
  ['ldquo', 0x201c],
  ['rdquo', 0x201d],
  ['bull', 0x2022],
  ['hellip', 0x2026],
  ['euro', 0x20ac],
  ['trade', 0x2122],
]);

/**
 * Decode character references in title/description text: decimal and hexadecimal ones generally, named
 * ones from {@link NAMED_ENTITIES}. One pass, so `&amp;#39;` stays `&#39;`. A reference that names no
 * character (a control, a surrogate, past U+10FFFF) or no known name is left as written.
 */
function decodeEntities(value: string): string {
  return value.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g,
    (whole, decimal?: string, hex?: string, name?: string) => {
      const code = name ? NAMED_ENTITIES.get(name) : decimal ? Number(decimal) : parseInt(hex ?? '', 16);
      if (code === undefined || code < 0x20 || (code >= 0x7f && code <= 0x9f)) return whole;
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    },
  );
}
