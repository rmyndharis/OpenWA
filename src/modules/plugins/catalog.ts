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
 * `updateAvailable` is true when an entry is installed and the catalog version is strictly newer.
 */
export function annotateCatalog(
  entries: CatalogEntry[],
  installed: { id: string; version: string }[],
): CatalogPlugin[] {
  const byId = new Map(installed.map(p => [p.id, p.version]));
  return entries.map(entry => {
    const installedVersion = byId.get(entry.id) ?? null;
    return {
      ...entry,
      installed: installedVersion !== null,
      installedVersion,
      updateAvailable: installedVersion !== null && compareSemver(entry.version, installedVersion) > 0,
    };
  });
}
