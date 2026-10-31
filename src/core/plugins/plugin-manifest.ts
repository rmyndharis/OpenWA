import * as path from 'path';
import { PluginManifest, PluginType } from './plugin.interfaces';
import { compareSemver } from '../../modules/plugins/catalog';

// The version of the running code (same source as /api/health), the default floor check target.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version: HOST_VERSION } = require('../../../package.json') as { version: string };

/**
 * Plugin ids a plugin package / directory must never use. `whatsapp-web.js` / `baileys` are built-in
 * engines; `auto-reply` / `translation` are the legacy bundled-extension ids (removed in v0.7 —
 * superseded by the marketplace `chat-flow` / `group-translate`) kept reserved so a re-upload or a
 * hand-placed directory can't shadow them.
 */
export const RESERVED_PLUGIN_IDS = new Set(['whatsapp-web.js', 'baileys', 'auto-reply', 'translation']);

/** Only extensions are user-installable / directory-loadable; engines (and other tiers) are built-in by design. */
export const INSTALLABLE_TYPES = new Set<string>([PluginType.EXTENSION]);

const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const REQUIRED_FIELDS = ['id', 'name', 'version', 'type', 'main'] as const;
// compareSemver reads garbage as 0.0.0, so a floor must be well-formed before it is compared.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The manifest validation BOTH install-time (parsePluginPackage) and boot-time
 * (PluginLoaderService.loadPlugin) enforce, so a plugin that could never be installed can never be
 * boot-loaded from a hand-placed or crash-leftover directory either. Throws a plain Error with the
 * shared message; each caller maps it to its own surface (install → HTTP 400, boot → load failure
 * logged + the directory skipped).
 *
 * Checks: plain-object shape; required fields present as non-empty strings; id format + reserved
 * ids; installable (extension) type; that `permissions`, `sessions`, `hooks` and `net.allow` /
 * `net.allowConfigHosts` are string arrays when present; that `main` is a relative path that
 * cannot escape the plugin directory; and that an optional `minOpenWAVersion` is a MAJOR.MINOR.PATCH version no newer
 * than `hostVersion` (pre-release suffixes are ignored, so 0.24.0-rc.1 satisfies 0.24.0). The
 * `main` check here is lexical (forward-slash semantics); the loader additionally anchors it
 * against the real on-disk directory, which also catches platform-separator tricks, and requires
 * the entry file to exist (parity with install's in-archive check).
 */
export function validatePluginManifest(
  manifest: unknown,
  hostVersion: string = HOST_VERSION,
): asserts manifest is PluginManifest {
  // JSON.parse("null") / "[]" / "5" don't throw — but indexing a field on a non-object then throws a
  // TypeError downstream. Require a plain object up front.
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error('manifest.json must be a JSON object');
  }
  const m = manifest as PluginManifest;
  for (const field of REQUIRED_FIELDS) {
    // Require a non-empty STRING: a non-string value (e.g. `main: 123`) is truthy and would pass a
    // bare falsy check, then crash a string-only API like path.posix.normalize with a TypeError.
    if (typeof m[field] !== 'string' || m[field].length === 0) {
      throw new Error(`manifest.json is missing or has an invalid required field: ${field}`);
    }
  }
  if (!SAFE_ID.test(m.id) || m.id.includes('..')) {
    throw new Error(`Invalid plugin id: "${m.id}"`);
  }
  // SAFE_ID accepts mixed case, so the reservation check is case-insensitive — else `Auto-Reply`
  // loads as a distinct plugin that shadows the reserved `auto-reply`.
  if (RESERVED_PLUGIN_IDS.has(m.id.toLowerCase())) {
    throw new Error(`Plugin id "${m.id}" is reserved by a built-in plugin`);
  }
  if (!INSTALLABLE_TYPES.has(m.type)) {
    throw new Error(
      `Plugin type "${m.type}" is not installable — only extension plugins can be installed (engines and other tiers are built-in).`,
    );
  }
  assertMainContained(m.main);
  // The consumers match these with `.includes`, which also works on a string: `sessions: 'sales-team'`
  // would admit session 'sales'. Require real string arrays (null reads as absent, like the consumers).
  assertStringArray(m.permissions, 'permissions');
  assertStringArray(m.sessions, 'sessions');
  assertStringArray(m.hooks, 'hooks');
  const net: unknown = m.net;
  if (net !== undefined && net !== null) {
    if (typeof net !== 'object' || Array.isArray(net)) {
      throw new Error('manifest.json net must be an object');
    }
    assertStringArray(m.net?.allow, 'net.allow');
    assertStringArray(m.net?.allowConfigHosts, 'net.allowConfigHosts');
  }
  const min: unknown = m.minOpenWAVersion;
  if (min !== undefined && min !== null) {
    if (typeof min !== 'string' || !SEMVER.test(min)) {
      throw new Error('manifest.json minOpenWAVersion must be a MAJOR.MINOR.PATCH version');
    }
    if (compareSemver(hostVersion, min) < 0) {
      throw new Error(`Plugin ${m.id} requires OpenWA >= ${min} (running ${hostVersion})`);
    }
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Remove, in place and at any depth, a configSchema `properties` or `items` that is not a plain object and a
 * `properties` entry that is not a field object. Every reader of the schema (secret masking and restore, the
 * dashboard form) takes such an entry as a field and fails on a null one, which took down the plugin list for
 * every plugin. The key is then read as an undescribed one, as seedConfigDefaults already does. Not a refusal:
 * such a package loads today.
 */
export function dropMalformedConfigFields(schema: unknown): void {
  if (!isPlainObject(schema)) return;
  if ('properties' in schema) {
    const properties = schema.properties;
    if (!isPlainObject(properties)) {
      delete schema.properties;
    } else {
      for (const [key, field] of Object.entries(properties)) {
        if (isPlainObject(field)) dropMalformedConfigFields(field);
        else delete properties[key];
      }
    }
  }
  if ('items' in schema) {
    if (isPlainObject(schema.items)) dropMalformedConfigFields(schema.items);
    else delete schema.items;
  }
}

function assertStringArray(value: unknown, field: string): void {
  if (value !== undefined && value !== null && !(Array.isArray(value) && value.every(v => typeof v === 'string'))) {
    throw new Error(`manifest.json ${field} must be an array of strings`);
  }
}

/**
 * Lexical containment for a manifest `main`: a relative, forward-slash path that stays inside the
 * plugin directory. Rejects absolute paths, `..` escapes, and backslashes (the install pipeline
 * rejects backslash archive paths outright, so a loadable main never contains one — a Windows-style
 * `..\x` would otherwise sail through the forward-slash checks and escape on a Windows host).
 */
function assertMainContained(main: string): void {
  const normalized = path.posix.normalize(main);
  if (path.posix.isAbsolute(main) || normalized === '..' || normalized.startsWith('../') || main.includes('\\')) {
    throw new Error(`manifest.json main escapes the plugin directory: "${main}"`);
  }
}
