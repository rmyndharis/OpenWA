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
 * - script-src is deliberately ABSENT: scripts remain governed by the inherited parent policy
 *   (nonce-based in production) together with the existing nonce-stamping pass — adding a
 *   second script rule here would risk double-policy surprises for zero egress gain (script
 *   URLs are already host-allow-listed by the parent).
 *
 * Known trade-off: a config UI that hot-links remote imagery (previously allowed via the
 * parent's `https:`) now renders without it and must inline media as data: URIs instead.
 */
export const CONFIG_UI_CSP = [
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
