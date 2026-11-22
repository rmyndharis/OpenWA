/**
 * Content-Security-Policy injected as a <meta> tag into a plugin's sandboxed config-UI
 * document (the srcdoc iframe rendered by the Plugins page).
 *
 * Why it exists: a srcdoc iframe inherits the embedding page's CSP, and the dashboard's policy
 * allows `img-src`/`media-src` from any `https:` origin (chat bubbles render remote media). A
 * plugin-supplied config UI could therefore load `<img src="https://tracker.example/…">` from
 * inside the sandbox — silent third-party egress/tracking with the operator's session open.
 * The `sandbox="allow-scripts"` attribute restricts capabilities (origin, popups, forms
 * submission is unaffected) but does NOT restrict where subresources load from, so the sandbox
 * alone cannot close this; a per-document CSP can. Multiple CSPs intersect — a resource must
 * pass every policy — so this meta tag can only tighten the inherited policy, never loosen it.
 *
 * Shape of the policy:
 * - img/media/font only from 'self' or data:. Config UIs are required to be self-contained
 *   (their HTML is fetched through the API and inlined), so inline data: media is the intended
 *   way to ship imagery. The frame's origin is opaque (sandboxed), which makes 'self' match
 *   nothing today; it is kept so the rule stays correct if the frame ever becomes same-origin.
 * - connect-src/form-action 'none': the host postMessage bridge (config:get/config:save) is
 *   the only sanctioned channel — the frame never needs fetch/XHR/WebSocket or form posts, and
 *   'none' keeps it that way (no beacons, no exfiltration of the redacted config).
 * - object/frame/worker/manifest 'none' and base-uri 'none': no nested browsing contexts,
 *   plugin content, or base-tag URL hijacks.
 * - style-src 'unsafe-inline': inline <style> blocks stay working (self-contained contract);
 *   external stylesheets/@import stay blocked, and any url() inside CSS is still gated by the
 *   img/font/media directives above.
 * - script-src 'unsafe-inline': no 'self', no remote hosts, no schemes, and no nonce. Multiple CSP
 *   policies intersect independently: in production an inline script must satisfy BOTH the parent
 *   policy (valid CSP nonce) and this policy ('unsafe-inline'), so un-nonced inline scripts stay
 *   blocked by the parent while ALL external script loads (static <script src>, SVG href/xlink:href,
 *   and dynamically inserted scripts that copy document.currentScript.nonce) are blocked here in both
 *   production and Vite dev mode.
 *
 * Known trade-off: a config UI that hot-links remote imagery (previously allowed via the
 * parent's `https:`) now renders without it and must inline media as data: URIs instead.
 */
export const CONFIG_UI_CSP = [
  "script-src 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' data:",
  "font-src 'self' data:",
  "style-src 'unsafe-inline'",
  "connect-src 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
].join('; ');

const XLINK_NS = 'http://www.w3.org/1999/xlink';
const NONCE_PLACEHOLDER = '__OPENWA_CSP_NONCE__';

/**
 * Inject CONFIG_UI_CSP into a parsed config-UI document, as the FIRST element of <head>: a CSP
 * delivered via <meta> only governs markup that follows it in document order, so it must
 * precede any plugin element capable of requesting a subresource. Called from the same
 * DOMParser pass that stamps script nonces, so the document is normalized (head always exists)
 * by the time we get here.
 */
export function injectConfigUiCsp(doc: Document): void {
  const meta = doc.createElement('meta');
  meta.httpEquiv = 'Content-Security-Policy';
  meta.content = CONFIG_UI_CSP;
  doc.head.prepend(meta);
}

/**
 * Whether a <script> element references an external script source (HTML `src`, or SVG `href` /
 * `xlink:href`). Only inline scripts may receive the CSP nonce; external script elements remain
 * blocked by CONFIG_UI_CSP (script-src 'unsafe-inline') as well as the parent policy.
 */
function isExternalScript(script: Element): boolean {
  return (
    script.hasAttribute('src') ||
    script.hasAttribute('href') ||
    script.hasAttribute('xlink:href') ||
    script.hasAttributeNS(XLINK_NS, 'href')
  );
}

/**
 * Harden a plugin config-UI HTML document before rendering it as an iframe `srcdoc`: stamp the
 * CSP nonce onto inline `<script>` elements only (skipping external HTML `src` and SVG `href` /
 * `xlink:href` scripts) and prepend CONFIG_UI_CSP into `<head>`.
 *
 * When `nonce` is omitted, reads `<meta name="openwa-csp-nonce">` from the current document.
 */
export function hardenConfigUiHtml(source: string, nonce?: string): string {
  const resolvedNonce =
    nonce ??
    (typeof document !== 'undefined'
      ? (document.querySelector<HTMLMetaElement>('meta[name="openwa-csp-nonce"]')?.content ?? '')
      : '');
  const doc = new DOMParser().parseFromString(source, 'text/html');
  if (resolvedNonce && resolvedNonce !== NONCE_PLACEHOLDER) {
    // Vite development has no production CSP, so there is nothing to stamp. Config UIs are
    // required to be self-contained. Nonce only inline scripts; external script references are
    // blocked by CONFIG_UI_CSP directly alongside the parent policy rather than bypassing via nonce.
    for (const script of doc.querySelectorAll('script')) {
      if (isExternalScript(script)) continue;
      script.setAttribute('nonce', resolvedNonce);
    }
  }
  // Lock down media/connection egress for the frame's document independent of the parent CSP,
  // so it protects Vite dev sessions too.
  injectConfigUiCsp(doc);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}
