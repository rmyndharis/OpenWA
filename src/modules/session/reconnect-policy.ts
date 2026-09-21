/**
 * The reconnect backoff *decision*, separated from its effects.
 *
 * `SessionEngineLifecycle.scheduleReconnect` interleaves three rules (budget exhaustion, exponential
 * backoff with jitter, periodic loop alerting) with the side effects they trigger
 * (status writes, engine eviction, webhooks, timers). The rules are the subtle part and the effects
 * are the untestable part, so the rules live here as a pure function over explicit state.
 *
 * Pure by construction: no timers, no I/O, and `jitter` is injected, so every branch,
 * including the capped long-streak ones, is directly reachable in a test.
 */

/** Mutable per-session backoff state. Owned by the caller; this module only reads and derives. */
export interface ReconnectAttemptState {
  attempts: number;
  maxAttempts: number;
  baseDelay: number;
}

/** Give up: the attempt budget is spent (or auto-reconnect was disabled outright). */
export interface ReconnectExhausted {
  kind: 'exhausted';
  /** Operator-facing reason, surfaced via `lastError`. */
  reason: string;
}

/** Schedule attempt `attempt` after `delayMs`. */
export interface ReconnectScheduled {
  kind: 'schedule';
  delayMs: number;
  /** 1-based number of the attempt being scheduled. */
  attempt: number;
  /** True when this attempt completes a loop-alert interval. */
  loopAlert: boolean;
}

export type ReconnectDecision = ReconnectExhausted | ReconnectScheduled;

/**
 * A reconnect-loop alert fires once per this many CONSECUTIVE attempts of a session — one signal per
 * ongoing episode, not spam per attempt. A broken-forever setup retries without limit (by design), so
 * the 5th/10th/15th… scheduled attempt is the operator-facing tell; the streak resets only when the
 * session reaches READY, so a later episode re-arms the alert from attempt 5 again.
 */
export const RECONNECT_LOOP_ALERT_INTERVAL_ATTEMPTS = 5;

/**
 * Upper bound on a computed backoff delay (see clampReconnectDelay). Kept at 5 minutes so a session
 * recovers within about that long once a lengthy outage ends.
 */
export const RECONNECT_DELAY_CAP_MS = 300_000;

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Clamp a computed backoff delay finite and within setTimeout's safe range (a huge value would
 * overflow its 32-bit ms field and fire immediately).
 */
export function clampReconnectDelay(rawDelay: number, baseDelay: number): number {
  return clampNumber(Number.isFinite(rawDelay) ? rawDelay : baseDelay, 0, RECONNECT_DELAY_CAP_MS);
}

/**
 * Decide what should happen for the next reconnect of a session, and advance `state` accordingly.
 *
 * MUTATES `state` (attempts) exactly as the original inline code did, so the caller
 * keeps a single source of truth for the session's streak across calls.
 *
 * @param jitter  Injected jitter in ms, added before clamping (production passes `Math.random() * 1000`).
 */
export function decideReconnect(
  state: ReconnectAttemptState,
  jitter: number = Math.random() * 1000,
): ReconnectDecision {
  // The attempt counter only resets when the session reaches READY (the lifecycle does that). A reset
  // keyed on elapsed time would fire as soon as the backoff delay itself grew past the window, so an
  // explicit cap would never be reached.
  if (state.attempts >= state.maxAttempts) {
    // maxAttempts:0 means auto-reconnect is disabled, not that N attempts were tried and failed — say
    // so instead of the misleading "failed after 0 attempts".
    return {
      kind: 'exhausted',
      reason:
        state.maxAttempts === 0
          ? 'Auto-reconnect is disabled (max attempts set to 0); the session was left disconnected — restart it manually.'
          : `Reconnection failed after ${state.attempts} attempts — restart the session.`,
    };
  }

  // Exponential backoff: baseDelay * 2^attempts (with jitter), clamped finite + within
  // setTimeout's safe range so the timer can't overflow and fire immediately. With the default
  // unlimited budget the delay parks at RECONNECT_DELAY_CAP_MS once the exponent outgrows it.
  const delayMs = clampReconnectDelay(state.baseDelay * Math.pow(2, state.attempts) + jitter, state.baseDelay);
  state.attempts++;

  return {
    kind: 'schedule',
    delayMs,
    attempt: state.attempts,
    loopAlert: state.attempts > 0 && state.attempts % RECONNECT_LOOP_ALERT_INTERVAL_ATTEMPTS === 0,
  };
}
