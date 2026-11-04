// Remote plugin catalog: the shape of an entry in the OpenWA-plugins `plugins.json`, and the pure
// logic that annotates each entry with install state relative to what is currently loaded.

/** One entry as published in the remote catalog (plugins.json). Extra fields are tolerated. */
export interface CatalogEntry {
  id: string;
  name: string;
  version: string;
  type?: string;
  status?: string;
  description?: string;
  author?: string;
  license?: string;
  keywords?: string[];
  minOpenWAVersion?: string;
  testedOpenWAVersion?: string;
  releasedAt?: string;
  repoUrl?: string;
  homepage?: string;
  download?: string;
  [key: string]: unknown;
}

const OPTIONAL_STRING_FIELDS = [
  'type',
  'status',
  'description',
  'author',
  'license',
  'minOpenWAVersion',
  'testedOpenWAVersion',
  'releasedAt',
  'repoUrl',
  'homepage',
  'download',
] as const;

/**
 * Whether `value` has the shape of {@link CatalogEntry}: non-empty string id, name and version, string
 * optional fields, and a string-array `keywords`; a null optional field counts as absent, as a hand-written
 * catalog often has it. Extra fields are tolerated. The dashboard lists and
 * searches these fields as text, so a value of another type would break the page that renders them.
 */
export function isCatalogEntry(value: unknown): value is CatalogEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const text = (field: unknown): boolean => typeof field === 'string' && field !== '';
  return (
    text(entry.id) &&
    text(entry.name) &&
    text(entry.version) &&
    OPTIONAL_STRING_FIELDS.every(key => entry[key] == null || typeof entry[key] === 'string') &&
    (entry.keywords == null ||
      (Array.isArray(entry.keywords) && entry.keywords.every(word => typeof word === 'string')))
  );
}

/** The entry without the optional fields a catalog left null, so none is answered as null where a string is declared. */
function withoutNulls(entry: CatalogEntry): CatalogEntry {
  const out: CatalogEntry = { ...entry };
  for (const key of [...OPTIONAL_STRING_FIELDS, 'keywords'] as const) {
    if (out[key] === null) delete out[key];
  }
  return out;
}

/** A catalog entry annotated with this instance's install state. */
export interface CatalogPlugin extends CatalogEntry {
  installed: boolean;
  installedVersion: string | null;
  updateAvailable: boolean;
}

/** Compare two `MAJOR.MINOR.PATCH` strings (pre-release suffixes ignored). Returns -1 | 0 | 1. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    String(v)
      .split('-')[0]
      .split('.')
      .map(n => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Annotate catalog entries with install state, given the plugins currently loaded by this instance.
 * `updateAvailable` is true when an entry is installed and the catalog version is strictly newer. A final
 * release counts as newer than an installed prerelease of the same version, which compareSemver alone
 * would call equal.
 */
export function annotateCatalog(
  entries: CatalogEntry[],
  installed: { id: string; version: string }[],
): CatalogPlugin[] {
  const byId = new Map(installed.map(p => [p.id, p.version]));
  return entries.map(entry => {
    const installedVersion = byId.get(entry.id) ?? null;
    const cmp = installedVersion === null ? 0 : compareSemver(entry.version, installedVersion);
    return {
      ...withoutNulls(entry),
      installed: installedVersion !== null,
      installedVersion,
      updateAvailable:
        installedVersion !== null &&
        (cmp > 0 || (cmp === 0 && installedVersion.includes('-') && !String(entry.version).includes('-'))),
    };
  });
}
