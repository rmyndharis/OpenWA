/**
 * Fail-closed allowlist for Chromium launch flags passed via `PUPPETEER_ARGS` or
 * `PUT /api/infra/config`.
 *
 * Chromium accepts command-execution and sandbox/network escape switches such as
 * `--gpu-launcher`, `--utility-cmd-prefix`, `--renderer-cmd-prefix`,
 * `--browser-subprocess-path`, `--load-extension`, `--remote-debugging-*`,
 * `--user-data-dir`, `--disk-cache-dir`, `--proxy-server`, `--proxy-pac-url`,
 * `--disable-web-security`, `--ignore-certificate-errors`, and `--js-flags`.
 * Restricting `PUPPETEER_ARGS` to vetted flags prevents an operator config or API
 * request from turning browser launch into arbitrary process execution or host egress bypass.
 */

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Safe boolean Chromium flags allowed without a value. */
export const ALLOWED_BOOLEAN_PUPPETEER_FLAGS: ReadonlySet<string> = new Set([
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--no-first-run',
  '--no-zygote',
  '--mute-audio',
  '--hide-scrollbars',
  '--headless',
  '--single-process',
  '--disable-accelerated-2d-canvas',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-component-extensions-with-background-pages',
  '--disable-default-apps',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-notifications',
  '--disable-popup-blocking',
  '--disable-renderer-backgrounding',
  '--disable-sync',
  '--disable-translate',
  '--disable-crash-reporter',
  '--metrics-recording-only',
  '--no-default-browser-check',
  '--safebrowsing-disable-auto-update',
  '--enable-automation',
]);

const FEATURE_LIST_PATTERN = /^[A-Za-z0-9_.-]+(?:,[A-Za-z0-9_.-]+)*$/;

/** Safe valued Chromium flags (`--flag=value`) with strict per-flag value patterns. */
export const ALLOWED_VALUED_PUPPETEER_FLAGS: Readonly<Record<string, RegExp>> = {
  '--lang': /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/,
  '--window-size': /^[1-9]\d{1,4},[1-9]\d{1,4}$/,
  '--disable-features': FEATURE_LIST_PATTERN,
  '--enable-features': FEATURE_LIST_PATTERN,
  '--disable-blink-features': FEATURE_LIST_PATTERN,
  '--headless': /^(?:new|old)$/,
  '--use-gl': /^(?:angle|desktop|egl|osmesa|swiftshader|swiftshader-webgl|disabled)$/,
  '--use-angle': /^(?:default|gl|gles|swiftshader|swiftshader-webgl|vulkan|metal|d3d9|d3d11|warp)$/,
  '--force-color-profile': /^(?:srgb|display-p3-d65|color-spin-gamma24|scrgb-linear|hdr10)$/,
  '--font-render-hinting': /^(?:none|slight|medium|full|max)$/,
};

/**
 * Split a comma- or space-separated Chromium argument string into discrete argv tokens.
 * A comma only splits before the next flag so flag values carrying commas
 * (`--disable-features=A,B`, `--window-size=1280,720`) stay intact.
 */
export function parsePuppeteerArgs(raw: string): string[] {
  return raw
    .split(/\s+|,+(?=-)/)
    .map(arg => arg.replace(/^,+|,+$/g, ''))
    .filter(Boolean);
}

/** Validate a single parsed Chromium argv token against the fail-closed allowlist. */
export function validatePuppeteerArg(arg: string): string | null {
  if (!arg || hasControlChar(arg)) {
    return `PUPPETEER_ARGS contains an invalid token (${JSON.stringify(arg)})`;
  }
  if (!arg.startsWith('--')) {
    return `PUPPETEER_ARGS only permits allowlisted "--" Chromium flags (rejected positional or short argument ${JSON.stringify(arg)})`;
  }
  const eq = arg.indexOf('=');
  if (eq === -1) {
    if (ALLOWED_BOOLEAN_PUPPETEER_FLAGS.has(arg)) return null;
    if (arg in ALLOWED_VALUED_PUPPETEER_FLAGS) {
      return `PUPPETEER_ARGS flag ${JSON.stringify(arg)} requires an explicit value (e.g. ${arg}=...)`;
    }
    return `PUPPETEER_ARGS flag ${JSON.stringify(arg)} is not in the allowlist of safe Chromium flags`;
  }
  const name = arg.slice(0, eq);
  const value = arg.slice(eq + 1);
  const pattern = ALLOWED_VALUED_PUPPETEER_FLAGS[name];
  if (!pattern) {
    return `PUPPETEER_ARGS flag ${JSON.stringify(name)} is not in the allowlist of safe valued Chromium flags`;
  }
  if (!pattern.test(value)) {
    return `PUPPETEER_ARGS flag ${JSON.stringify(name)} has an invalid value (${JSON.stringify(value)})`;
  }
  return null;
}

/**
 * Validate a raw `PUPPETEER_ARGS` string. Returns an error message on the first rejected token or
 * control character, or `null` when valid (empty/whitespace-only counts as unset).
 */
export function puppeteerArgsError(raw: string): string | null {
  if (hasControlChar(raw)) {
    return 'PUPPETEER_ARGS must not contain control characters or line breaks';
  }
  if (raw.trim() === '') return null;
  for (const token of parsePuppeteerArgs(raw)) {
    const err = validatePuppeteerArg(token);
    if (err) return err;
  }
  return null;
}
