/**
 * The reconnect backoff *decision*, separated from its effects.
 *
 * `SessionEngineLifecycle.scheduleReconnect` interleaves four rules (stability reset, budget exhaustion,
 * exponential backoff with jitter, periodic loop alerting) with the side effects they trigger
 * (status writes, engine eviction, webhooks, timers). The rules are the subtle part and the effects
 * are the untestable part, so the rules live here as a pure function over explicit state.
 *
 * Pure by construction: no timers, no I/O, and `now`/`jitter` are injected, so every branch —
 * including the ones that only occur after hours of uptime — is directly reachable in a test.
 */

/** Mutable per-session backoff state. Owned by the caller; this module only reads and derives. */
export interface ReconnectAttemptState {
  attempts: number;
  maxAttempts: number;
  baseDelay: number;
  /** When the last attempt was scheduled (epoch ms) — feeds the stability reset. */
  lastAttemptAt?: number;
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
  /** The attempt counter reset because the session had been stable. */
  stabilityReset: boolean;
}

export type ReconnectDecision = ReconnectExhausted | ReconnectScheduled;

/**
 * A reconnect-attempt budget covers one CONTINUOUS bad stretch: once this much time has passed
 * since the last scheduled attempt the session demonstrably stayed up, so `attempts` resets to 0.
 * Without it a long-lived session would slowly accrue attempts toward an explicit cap across
 * unrelated transient drops and one day wedge FAILED for no current reason.
 */
export const RECONNECT_STABILITY_RESET_MS = 300_000;

/**
 * A reconnect-loop alert fires once per this many CONSECUTIVE attempts of a session — one signal per
 * ongoing episode, not spam per attempt. A broken-forever setup retries without limit (by design), so
 * the 5th/10th/15th… scheduled attempt is the operator-facing tell; the streak resets via the
 * stability window above (or onReady), so a later episode re-arms the alert from attempt 5 again.
 */
export const RECONNECT_LOOP_ALERT_INTERVAL_ATTEMPTS = 5;

/** Upper bound on a computed backoff delay (see clampReconnectDelay). */
export const RECONNECT_DELAY_CAP_MS = 3_600_000;

function clampNumber(value: number, min: number, max: number): number {
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
 * MUTATES `state` (attempts / lastAttemptAt) exactly as the original inline code did, so the caller
 * keeps a single source of truth for the session's streak across calls.
 *
 * @param now     Injected clock (epoch ms).
 * @param jitter  Injected jitter in ms, added before clamping (production passes `Math.random() * 1000`).
 */
export function decideReconnect(
  state: ReconnectAttemptState,
  now: number = Date.now(),
  jitter: number = Math.random() * 1000,
): ReconnectDecision {
  // Stability reset: the attempt budget covers one CONTINUOUS bad stretch. When the session stayed
  // up ≥5 min since the last scheduled attempt it demonstrably recovered, so the next drop
  // restarts the budget — unrelated transient drops must not accrue toward an explicit cap over
  // the session's lifetime.
  let stabilityReset = false;
  if (state.lastAttemptAt !== undefined && now - state.lastAttemptAt >= RECONNECT_STABILITY_RESET_MS) {
    state.attempts = 0;
    stabilityReset = true;
  }

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
  state.lastAttemptAt = now;

  return {
    kind: 'schedule',
    delayMs,
    attempt: state.attempts,
    loopAlert: state.attempts > 0 && state.attempts % RECONNECT_LOOP_ALERT_INTERVAL_ATTEMPTS === 0,
    stabilityReset,
  };
}
