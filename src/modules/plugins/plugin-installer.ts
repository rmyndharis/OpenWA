import AdmZip from 'adm-zip';
import * as path from 'path';
import { BadRequestException } from '@nestjs/common';
import { PluginManifest, PluginType } from '../../core/plugins';

export interface PackageLimits {
  /** Max number of files in the archive (cheap zip-bomb / fork-bomb guard). */
  maxEntries: number;
  /** Max total uncompressed bytes (checked against the zip headers BEFORE decompressing). */
  maxTotalBytes: number;
}

export const DEFAULT_PACKAGE_LIMITS: PackageLimits = { maxEntries: 200, maxTotalBytes: 20 * 1024 * 1024 };

/**
 * Plugin ids an uploaded package must never use. `whatsapp-web.js` / `baileys` are built-in engines;
 * `auto-reply` / `translation` are the legacy bundled-extension ids (removed in v0.7 — superseded by
 * the marketplace `chat-flow` / `group-translate`) kept reserved so a re-upload can't shadow them.
 */
export const RESERVED_PLUGIN_IDS = new Set(['whatsapp-web.js', 'baileys', 'auto-reply', 'translation']);

/** Only extensions are user-installable; engines (and other tiers) are built-in by design. */
export const INSTALLABLE_TYPES = new Set<string>([PluginType.EXTENSION]);

const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const REQUIRED_FIELDS = ['id', 'name', 'version', 'type', 'main'] as const;

export interface ParsedPackage {
  manifest: PluginManifest;
  /** Files to write under the plugin directory, relative to the package root, zip-slip-safe. */
  entries: { relPath: string; data: Buffer }[];
}

/**
 * Parse + validate an uploaded plugin `.zip` without touching the filesystem. Locates the package
 * root (the shallowest `manifest.json`, so both a flat zip and a single-folder zip work), validates
 * the manifest and id, and resolves every file path defensively (rejects absolute / `..` escapes and
 * over-size archives). The caller writes the returned entries; this function decides what is safe.
 */
export function parsePluginPackage(buffer: Buffer, limits: PackageLimits = DEFAULT_PACKAGE_LIMITS): ParsedPackage {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new BadRequestException('Uploaded file is not a valid .zip archive');
  }

  const files = zip.getEntries().filter(e => !e.isDirectory);
  if (files.length === 0) throw new BadRequestException('The archive is empty');
  if (files.length > limits.maxEntries) throw new BadRequestException('The archive has too many files');

  // Package root = directory of the shallowest manifest.json (handles flat and single-folder zips).
  const manifestEntry = files
    .filter(e => path.posix.basename(e.entryName) === 'manifest.json')
    .sort((a, b) => a.entryName.split('/').length - b.entryName.split('/').length)[0];
  if (!manifestEntry) throw new BadRequestException('The archive has no manifest.json');
  const dir = path.posix.dirname(manifestEntry.entryName);
  const prefix = dir === '.' ? '' : dir + '/';

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestEntry.getData().toString('utf-8'));
  } catch {
    throw new BadRequestException('manifest.json is not valid JSON');
  }
  // JSON.parse("null") / "[]" / "5" don't throw — but indexing a field on a non-object then throws an
  // uncaught TypeError (HTTP 500) on the attacker-controlled install path. Require a plain object.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestException('manifest.json must be a JSON object');
  }
  const manifest = parsed as PluginManifest;
  for (const field of REQUIRED_FIELDS) {
    // Require a non-empty STRING: a non-string value (e.g. `main: 123`) is truthy and would pass a
    // bare falsy check, then crash a string-only API like path.posix.normalize with an uncaught
    // TypeError (HTTP 500). Reject it cleanly as a 400 here.
    if (typeof manifest[field] !== 'string' || manifest[field].length === 0) {
      throw new BadRequestException(`manifest.json is missing or has an invalid required field: ${field}`);
    }
  }
  if (!SAFE_ID.test(manifest.id) || manifest.id.includes('..')) {
    throw new BadRequestException(`Invalid plugin id: "${manifest.id}"`);
  }
  if (RESERVED_PLUGIN_IDS.has(manifest.id.toLowerCase())) {
    throw new BadRequestException(`Plugin id "${manifest.id}" is reserved by a built-in plugin`);
  }
  if (!INSTALLABLE_TYPES.has(manifest.type)) {
    throw new BadRequestException(
      `Plugin type "${manifest.type}" is not installable — only extension plugins can be installed (engines and other tiers are built-in).`,
    );
  }

  // Size guard FIRST, off the declared header sizes, so a zip bomb is rejected before we decompress.
  const packaged = files.filter(e => !prefix || e.entryName.startsWith(prefix));
  const declared = packaged.reduce((sum, e) => sum + e.header.size, 0);
  if (declared > limits.maxTotalBytes) throw new BadRequestException('The archive contents exceed the size limit');

  const entries: { relPath: string; data: Buffer }[] = [];
  for (const e of packaged) {
    const relPath = e.entryName.slice(prefix.length);
    if (!relPath) continue;
    const norm = path.posix.normalize(relPath);
    if (relPath.includes('\\') || norm.startsWith('..') || norm === '..' || path.posix.isAbsolute(norm)) {
      throw new BadRequestException(`Unsafe path in archive: ${e.entryName}`);
    }
    entries.push({ relPath: norm, data: e.getData() });
  }

  const mainRel = path.posix.normalize(manifest.main);
  if (!entries.some(en => en.relPath === mainRel)) {
    throw new BadRequestException(`The archive is missing its main file: ${manifest.main}`);
  }

  return { manifest, entries };
}
