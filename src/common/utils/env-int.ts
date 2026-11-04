/**
 * Read a positive-integer knob from the environment. Boot validation rejects a malformed value for
 * every key read through this, so the fallback covers unset and empty only: `parseInt` accepts the
 * leading digits of a unit-suffixed value and would silently take `50mb` as 50.
 */
export function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * A positive integer from a raw environment value, for the limiters that read their budget leniently:
 * blank, non-numeric and non-positive values fall back, and a fraction is floored (`2.9` reads as 2).
 */
export function positiveIntOrDefault(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i >= 1 ? i : fallback;
}
