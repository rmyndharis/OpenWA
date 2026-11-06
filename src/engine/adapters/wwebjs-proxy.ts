/**
 * Whether a per-session proxy URL parses to a supported scheme — defense-in-depth for a stored proxy
 * that bypassed DTO validation (e.g. loaded from the DB on restart). The host is NOT SSRF-blocked: a
 * per-session proxy is operator-chosen egress, and a loopback proxy sidecar is a legitimate setup.
 */
export function isSupportedProxyUrl(url: string): boolean {
  try {
    return ['http:', 'https:', 'socks4:', 'socks5:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

export interface ProxyLaunchConfig {
  /** Credential-less `--proxy-server` value — Chromium ignores credentials embedded in this flag. */
  serverArg: string;
  /** Username/password for whatsapp-web.js's `proxyAuthentication` (→ `page.authenticate`, HTTP/HTTPS only). */
  proxyAuthentication?: { username: string; password: string };
  /** The URL carries credentials for a SOCKS proxy, which Chromium cannot authenticate at all. */
  socksAuthUnsupported: boolean;
}

/**
 * Split a proxy URL into a credential-less `--proxy-server` value plus, for an HTTP/HTTPS proxy, the
 * username/password to hand to whatsapp-web.js's `proxyAuthentication` (which calls `page.authenticate`
 * — the only way Chromium authenticates a proxy). Credentials embedded in `--proxy-server` are ignored
 * by Chromium, and SOCKS proxies cannot be authenticated at all, so SOCKS credentials are surfaced via
 * `socksAuthUnsupported` for the caller to warn about instead of failing with an opaque nav timeout (#628).
 * Call only with a URL that already passed {@link isSupportedProxyUrl}.
 */
export function buildProxyLaunchConfig(url: string): ProxyLaunchConfig {
  const parsed = new URL(url);
  const serverArg = `${parsed.protocol}//${parsed.host}`;
  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
  } catch {
    // A lone `%` in a stored URL that bypassed DTO validation; the bare `URI malformed` names nothing.
    throw new Error('The session proxy URL has malformed percent-encoded credentials');
  }
  const hasCredentials = username !== '' || password !== '';
  const isSocks = parsed.protocol === 'socks4:' || parsed.protocol === 'socks5:';
  if (hasCredentials && !isSocks) {
    return { serverArg, proxyAuthentication: { username, password }, socksAuthUnsupported: false };
  }
  return { serverArg, socksAuthUnsupported: hasCredentials && isSocks };
}

/** The part of a whatsapp-web.js auth strategy that {@link bypassServiceWorkerOnLaunch} reaches into. */
interface LaunchHookStrategy {
  client: { pupPage: { setBypassServiceWorker(bypass: boolean): Promise<void> } };
  afterBrowserInitialized(): Promise<void>;
}

/**
 * Make the session's page ignore WhatsApp Web's service worker from the first navigation on.
 * `page.authenticate()` answers a proxy's 407 only for the page's own requests. After the first link WhatsApp Web
 * registers a service worker in the persisted profile, the next launch's navigation is served through it, and
 * the worker's request meets the 407 with nobody to answer: Chromium reports `net::ERR_INVALID_AUTH_CREDENTIALS`
 * on every start after the first (#819). With the worker bypassed, the page's requests carry the credentials.
 *
 * whatsapp-web.js calls `afterBrowserInitialized` once the page exists and before it navigates, so the hook goes
 * there. Only a session whose proxy asks for credentials needs it. A page that is missing fails the start rather
 * than skipping the call, since a library that stopped calling the hook in that order would otherwise go unnoticed.
 */
export function bypassServiceWorkerOnLaunch(strategy: object): void {
  const target = strategy as LaunchHookStrategy;
  const original = target.afterBrowserInitialized.bind(target);
  target.afterBrowserInitialized = async () => {
    await target.client.pupPage.setBypassServiceWorker(true);
    await original();
  };
}
