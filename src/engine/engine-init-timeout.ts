/**
 * The deadline the session lifecycle races `engine.initialize()` against, and the whatsapp-web.js
 * auth window it is derived from.
 *
 * These live outside the adapters because the OUTER deadline is engine-agnostic —
 * SessionEngineLifecycle applies it to every engine — while the value it must clear is set by
 * whatsapp-web.js. Deriving it inside the session lifecycle service meant the lifecycle owner
 * imported the wwjs adapter just to size a
 * timeout, which is why this pair now has one home instead of a cross-layer import.
 */

/**
 * Optional override for whatsapp-web.js's initial boot/inject wait (#353). On slow first boots
 * (e.g. WSL2 or low-resource containers) the default 30s `authTimeoutMs` can expire before WhatsApp
 * Web finishes loading, aborting QR generation. Set WWEBJS_AUTH_TIMEOUT_MS to a larger value in
 * milliseconds (e.g. 120000) to extend it. Unset, or a value that is not a positive safe integer,
 * keeps the whatsapp-web.js default (30000ms). A value above what a Node timer holds is capped at it.
 */
export function resolveAuthTimeoutMs(): number | undefined {
  const raw = process.env.WWEBJS_AUTH_TIMEOUT_MS?.trim();
  if (!raw || !/^\d+$/.test(raw)) {
    return undefined;
  }
  const ms = Number(raw);
  // Number.isSafeInteger rejects Infinity (from huge digit strings) and integers above 2^53: both pass the
  // /^\d+$/ shape check, but neither is a duration a timer can hold, so they keep the default like any non-number.
  // A safe integer above the largest delay a Node timer holds is capped there: since 1.34.8 the library waits for
  // WhatsApp Web with a Puppeteer timeout of this value, and above the cap setTimeout fires after 1 ms, failing every
  // start at once.
  return Number.isSafeInteger(ms) && ms > 0 ? Math.min(ms, 2_147_483_647) : undefined;
}

/**
 * How long a session waits for `engine.initialize()` before treating it as wedged.
 *
 * The deadline MUST exceed the auth wait whatsapp-web.js runs INSIDE engine.initialize()
 * (authTimeoutMs — the inject() poll for WA Web's JS to bootstrap, raisable via
 * WWEBJS_AUTH_TIMEOUT_MS for slow first boots). A shorter outer deadline would SIGKILL a legitimate
 * slow init mid-auth. Floor 60s for the hang case; otherwise the configured auth window plus 30s for
 * launch/navigation/post-inject overhead.
 *
 * WWEBJS_AUTH_TIMEOUT_MS can only ever RAISE this above the 60s floor, never lower it, so a
 * Baileys session whose operator set it for whatsapp-web.js gets a more generous deadline — never a
 * shorter one. Giving the two engines separate windows would need its own env var and is a
 * behaviour change, not part of moving this out of the adapter.
 */
export function resolveEngineInitTimeoutMs(): number {
  // Capped at the largest delay a Node timer holds: above it setTimeout fires after 1 ms, so a huge
  // WWEBJS_AUTH_TIMEOUT_MS failed every start at once instead of waiting longer.
  return Math.min(2_147_483_647, Math.max(60_000, (resolveAuthTimeoutMs() ?? 30_000) + 30_000));
}
