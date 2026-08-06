import * as path from 'path';
import { PluginManifest, PluginType } from './plugin.interfaces';

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

/**
 * The manifest validation BOTH install-time (parsePluginPackage) and boot-time
 * (PluginLoaderService.loadPlugin) enforce, so a plugin that could never be installed can never be
 * boot-loaded from a hand-placed or crash-leftover directory either. Throws a plain Error with the
 * shared message; each caller maps it to its own surface (install → HTTP 400, boot → load failure
 * logged + the directory skipped).
 *
 * Checks: plain-object shape; required fields present as non-empty strings; id format + reserved
 * ids; installable (extension) type; and that `main` is a relative path that cannot escape the
 * plugin directory. The `main` check here is lexical (forward-slash semantics); the loader
 * additionally anchors it against the real on-disk directory, which also catches platform-separator
 * tricks, and requires the entry file to exist (parity with install's in-archive check).
 */
export function validatePluginManifest(manifest: unknown): asserts manifest is PluginManifest {
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
