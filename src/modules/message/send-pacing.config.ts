import { ConfigService } from '@nestjs/config';

/**
 * Pacing policy for outbound sends, resolved from the environment.
 *
 * Kept out of `feature-flags.ts` because it is a policy object rather than a set of independent
 * booleans, and because every numeric field needs the clamping below — a bad value here does not
 * misconfigure a feature, it decides whether messages are refused.
 */
export interface SendPacingConfig {
  /** Opt-in — default OFF, so an upgrade never starts refusing sends on its own. */
  enabled: boolean;
  /**
   * Daily send allowance by session age in days: index 0 is the session's first day, and the last
   * entry applies to every day beyond the schedule's length. A brand-new WhatsApp account that
   * immediately sends at volume is the classic ban pattern, so the allowance starts small and grows.
   */
  warmupSchedule: number[];
  /**
   * Daily allowance for **cold reachouts** — the first message to a chat this account has no history
   * with in either direction. Same by-age shape as `warmupSchedule`, and a single number is a flat
   * cap. Empty disables the rule.
   *
   * Separate from the overall cap because the two bound different risks. Answering people who
   * already wrote to you is not what gets numbers banned; starting conversations with strangers is,
   * and WhatsApp's own restriction for it (the reachout timelock) targets exactly that.
   */
  coldSchedule: number[];
  /** Consecutive send failures that trip the breaker. */
  breakerThreshold: number;
  /** How long the breaker stays open before it lets traffic through again. */
  breakerCooldownMs: number;
}

/** A cautious two-week ramp: ~1 message every 3 minutes on day one, ~2/minute by the second week. */
const DEFAULT_WARMUP_SCHEDULE = [20, 40, 80, 160, 320, 640, 1000];
/** Deliberately far below the overall ramp: a stranger costs more standing than a reply does. */
const DEFAULT_COLD_SCHEDULE = [5, 10, 20, 40, 60, 80, 100];
const DEFAULT_BREAKER_THRESHOLD = 5;
const DEFAULT_BREAKER_COOLDOWN_MS = 15 * 60_000;

// A cap of 0 would refuse every send, which is never what a misconfigured value should mean, so the
// floor is 1. The ceiling is a sanity bound, not a WhatsApp limit — nobody's real allowance is 100k,
// and a fat-fingered value that large would silently disable the whole mechanism.
const MIN_DAILY_CAP = 1;
const MAX_DAILY_CAP = 100_000;
const MIN_BREAKER_THRESHOLD = 1;
const MIN_BREAKER_COOLDOWN_MS = 1000;

/**
 * Parse a comma-separated warm-up schedule (`"20,40,80"`). Any malformed entry falls the WHOLE
 * schedule back to the default rather than being skipped: a schedule with a hole in it would apply a
 * silently different ramp than the operator wrote, and quietly sending more than intended is the one
 * failure this feature exists to prevent.
 */
function parseSchedule(raw: string | undefined, fallback: number[]): number[] {
  // An explicit empty value is a deliberate "no rule", distinct from an unset one. Only the cold cap
  // uses it; the overall cap has no off switch short of disabling pacing.
  if (raw !== undefined && raw.trim() === '') return fallback === DEFAULT_COLD_SCHEDULE ? [] : fallback;
  if (!raw) return fallback;
  const parts = raw.split(',').map(part => Number(part.trim()));
  if (parts.length === 0 || parts.some(n => !Number.isFinite(n) || n < MIN_DAILY_CAP || n > MAX_DAILY_CAP)) {
    return fallback;
  }
  return parts.map(n => Math.floor(n));
}

function parsePositiveInt(raw: string | undefined, fallback: number, min: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) return fallback;
  return Math.floor(value);
}

/** Derive the policy from an environment map. Pure and parameterised for testability. */
export function computeSendPacingConfig(env: NodeJS.ProcessEnv = process.env): SendPacingConfig {
  return {
    enabled: env.SEND_PACING_ENABLED === 'true',
    warmupSchedule: parseSchedule(env.SEND_PACING_WARMUP_SCHEDULE, DEFAULT_WARMUP_SCHEDULE),
    coldSchedule: parseSchedule(env.SEND_PACING_COLD_DAILY_CAP, DEFAULT_COLD_SCHEDULE),
    breakerThreshold: parsePositiveInt(
      env.SEND_PACING_BREAKER_THRESHOLD,
      DEFAULT_BREAKER_THRESHOLD,
      MIN_BREAKER_THRESHOLD,
    ),
    breakerCooldownMs: parsePositiveInt(
      env.SEND_PACING_BREAKER_COOLDOWN_MS,
      DEFAULT_BREAKER_COOLDOWN_MS,
      MIN_BREAKER_COOLDOWN_MS,
    ),
  };
}

/**
 * Resolve the policy, preferring the ConfigService snapshot and falling back to a live `process.env`
 * read when ConfigService is absent — the same arrangement `resolveFeatureFlags` uses, and for the
 * same reason: unit tests construct services without the global ConfigModule and mutate `process.env`.
 */
export function resolveSendPacingConfig(configService?: Pick<ConfigService, 'get'>): SendPacingConfig {
  return configService?.get<SendPacingConfig>('sendPacing') ?? computeSendPacingConfig();
}
