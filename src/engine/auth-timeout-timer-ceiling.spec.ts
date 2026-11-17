import { resolveAuthTimeoutMs } from './engine-init-timeout';

/**
 * WWEBJS_AUTH_TIMEOUT_MS is handed to whatsapp-web.js as `authTimeoutMs`. Since 1.34.8 the library waits for WhatsApp
 * Web with Puppeteer's waitForFunction and that option as its `timeout`, which Puppeteer arms with a plain setTimeout.
 * Node fires a timer longer than 2^31-1 ms after 1 ms, so a value above it failed every start with 'auth timeout' at
 * once instead of waiting longer (1.34.7 polled Date.now and held any safe integer).
 */
const MAX_TIMER_MS = 2 ** 31 - 1;

describe('WWEBJS_AUTH_TIMEOUT_MS above what a Node timer holds', () => {
  const saved = process.env.WWEBJS_AUTH_TIMEOUT_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.WWEBJS_AUTH_TIMEOUT_MS;
    else process.env.WWEBJS_AUTH_TIMEOUT_MS = saved;
  });

  it.each(['2147483648', '3000000000', String(Number.MAX_SAFE_INTEGER)])('is capped at the timer limit: %s', raw => {
    process.env.WWEBJS_AUTH_TIMEOUT_MS = raw;
    expect(resolveAuthTimeoutMs()).toBe(MAX_TIMER_MS);
  });

  it.each([String(MAX_TIMER_MS), '600000', '1'])('hands a value a timer holds over unchanged: %s', raw => {
    process.env.WWEBJS_AUTH_TIMEOUT_MS = raw;
    expect(resolveAuthTimeoutMs()).toBe(Number(raw));
  });
});
