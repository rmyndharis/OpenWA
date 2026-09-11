// IANA time zone list for the Client Mapping form's timezone dropdown. Backed by the runtime's own
// zone database (Intl.supportedValuesOf) rather than a hand-maintained list, so it never drifts from
// what the browser (and the backend's own Intl.DateTimeFormat validation) actually accepts.
const FALLBACK_ZONES = [
  'UTC',
  'Asia/Kolkata',
  'Asia/Jakarta',
  'Asia/Singapore',
  'Asia/Dubai',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'Australia/Sydney',
];

/**
 * All zones the runtime supports, sorted. Falls back to a short curated list on an older browser.
 *
 * Verified live: this varies by ICU/Node version — some runtimes enumerate the modern IANA name
 * ('Asia/Kolkata'), others still return the legacy tzdata link name ('Asia/Calcutta') for the exact
 * same zone. Both resolve identically in Intl.DateTimeFormat, so this just renames the legacy form
 * to the modern one (the backend's own validator/docs use the modern name too) rather than showing
 * a confusing 'Calcutta' entry that a stored 'Kolkata' value would never match against.
 */
export function listTimezones(): string[] {
  const zones =
    typeof Intl.supportedValuesOf === 'function'
      ? (() => {
          try {
            return Intl.supportedValuesOf('timeZone');
          } catch {
            return FALLBACK_ZONES;
          }
        })()
      : FALLBACK_ZONES;
  if (zones.includes('Asia/Kolkata')) return zones;
  return zones.map(zone => (zone === 'Asia/Calcutta' ? 'Asia/Kolkata' : zone));
}

/** Zones grouped by their region prefix (the part before the first '/'), for <optgroup> rendering. */
export function groupedTimezones(): Array<{ region: string; zones: string[] }> {
  const zones = listTimezones();
  const byRegion = new Map<string, string[]>();
  for (const zone of zones) {
    const region = zone.includes('/') ? zone.split('/')[0] : 'Other';
    const list = byRegion.get(region);
    if (list) list.push(zone);
    else byRegion.set(region, [zone]);
  }
  return [...byRegion.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([region, list]) => ({
      region,
      zones: list.sort(),
    }));
}
