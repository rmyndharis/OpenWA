import * as fs from 'fs';
import * as path from 'path';

/**
 * Startup guard for OpenWA's install-time engine patches.
 *
 * The patches are applied two ways, and only one of them is loud. The Docker production stage runs
 * every patcher WITHOUT `--best-effort`, so an unrecognised source shape fails the image build. A
 * source install runs them through `scripts/postinstall.js` WITH `--best-effort`, except the Puppeteer
 * transform, which aborts the install on a shape it does not recognise. Under `--best-effort` a patcher
 * that cannot apply prints one line into a long `npm install` transcript and the install still
 * succeeds. The operator then runs a tree that is missing a fix, and the symptom arrives later as
 * exactly the opaque failure the patch existed to remove: an unnamed 500, a send that reports no
 * message, a resync loop that never ends. None of those errors name their cause.
 *
 * So restate it on the machine that is actually affected, as the engine starts.
 *
 * Ground truth only. Each patcher exports `isApplied()`, which is that patcher's OWN stand-down
 * branch, reading the installed file. There is deliberately no manifest and no recorded install
 * outcome: a record can survive a dependency being reinstalled underneath it, and a guard that
 * says "patched" about an unpatched tree is worse than no guard at all.
 *
 * Diagnostic, not preventive: startup continues, so a session reaching READY is not evidence that
 * every patch landed. Every shipped patcher exports `isApplied()`, verified by
 * `engine-patch-status.spec.ts`.
 */

/** Which library a patcher targets, read from its filename prefix. */
export type PatchFamily = 'wwebjs' | 'baileys';

const PACKAGE_FOR: Record<PatchFamily, string> = {
  wwebjs: 'whatsapp-web.js',
  baileys: '@whiskeysockets/baileys',
};

/** The one member of a patcher module this file uses. Everything else is the patcher's business. */
interface Patcher {
  isApplied?: (depDir?: string) => boolean;
}

/**
 * `scripts/` as it sits beside the compiled output: `dist/engine/adapters` and `src/engine/adapters`
 * are both three levels below the package root, so the same hop works built and under ts-jest. The
 * production image copies the patchers in (Dockerfile), so this resolves there too.
 */
function defaultScriptsDir(): string {
  return path.join(__dirname, '..', '..', '..', 'scripts');
}

/**
 * Names of the patchers for `family` that the installed library does NOT carry, without the `.js`.
 *
 * Empty is the answer for every uncertainty: no `scripts/` directory, an unresolvable package, a
 * patcher that exports no predicate. An install we cannot inspect is not evidence of a broken one,
 * and a false alarm on every boot would send operators chasing a patch they do not need.
 */
export function unappliedPatches(family: PatchFamily, scriptsDir?: string, depDir?: string): string[] {
  const dir = scriptsDir ?? defaultScriptsDir();

  let resolvedDep: string;
  try {
    resolvedDep = depDir ?? path.dirname(require.resolve(`${PACKAGE_FOR[family]}/package.json`));
  } catch {
    return [];
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const prefix = `patch-${family}-`;
  const missing: string[] = [];
  for (const entry of entries.sort()) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.js') || entry.endsWith('.spec.js')) continue;
    let patcher: Patcher;
    try {
      // Requiring a patcher does not run it: each guards its own CLI behind `require.main`. The
      // patchers are plain CommonJS loaded by computed path, so this cannot be an import.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      patcher = require(path.join(dir, entry)) as Patcher;
    } catch {
      continue;
    }
    if (typeof patcher.isApplied !== 'function') continue;
    if (patcher.isApplied(resolvedDep) === false) missing.push(entry.replace(/\.js$/, ''));
  }
  return missing;
}

/** The startup line for a non-empty `unappliedPatches` result. */
export function unappliedPatchesMessage(family: PatchFamily, names: string[]): string {
  const commands = names.map(name => `\`node scripts/${name}.js\``).join(', ');
  return (
    `The installed ${PACKAGE_FOR[family]} is missing ${names.length} of OpenWA's install-time ` +
    `patches: ${names.join(', ')}. The capabilities each one repairs will fail with errors that ` +
    'name no cause. The install skipped them. When it ran with --ignore-scripts, apply them with ' +
    `${commands} (or reinstall with \`npm install\`) and restart. A patcher that refused a source shape ` +
    'it did not recognise is not fixed by either: the library has moved and the transform needs ' +
    're-evaluating. See docs/12-troubleshooting-faq.md.'
  );
}
