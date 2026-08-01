/**
 * How many one-second readiness polls to allow before a restart is declared failed.
 *
 * The poll used to latch onto the OLD process — `/infra/health` answers 200 throughout the drain and
 * the engine teardown that follows — so it "succeeded" in about three seconds and the fixed 60-attempt
 * deadline was never approached. Polling readiness instead means the poll genuinely waits for the new
 * process, and the deadline becomes the thing that decides whether the operator sees the dashboard or
 * an error screen.
 *
 * `POST /infra/restart` returns its own `estimatedTime`, which reaches 63s when a restart brings up
 * postgres, redis and minio together (and more with services to remove). A deadline below the server's
 * own estimate would report failure while the stack is still coming up correctly, so the estimate sets
 * the floor and is doubled for margin: the estimate is optimistic, and a container recreate plus
 * migrations can overrun it.
 *
 * The value comes from a server response, so it is clamped at both ends — a missing or absurd estimate
 * must not shorten the deadline below the historical 60, nor leave the modal waiting indefinitely.
 */
const MIN_ATTEMPTS = 60;
const MAX_ATTEMPTS = 300;

export function restartPollAttempts(estimatedSeconds?: number): number {
  if (!Number.isFinite(estimatedSeconds) || (estimatedSeconds as number) <= 0) return MIN_ATTEMPTS;
  return Math.min(MAX_ATTEMPTS, Math.max(MIN_ATTEMPTS, Math.ceil((estimatedSeconds as number) * 2)));
}
