import * as fs from 'fs';
import * as path from 'path';

/**
 * Startup guard for the whatsapp-web.js message-id backport that scripts/patch-wwebjs-201832.js
 * applies at install time.
 *
 * WhatsApp Web 2.3000.x renamed the serialized message-id property `id._serialized` to `id.$1`.
 * whatsapp-web.js 1.34.7 still reads the old name, so an install that never received the backport
 * breaks opaquely once WhatsApp Web serves that shape: a send resolves with no message object at
 * all (the gateway then refuses to report a delivery it cannot confirm) and chat and media reads
 * throw the minified `r: r` (#889). None of those errors name their cause.
 *
 * The install already warns when it skips the patch, but that is one line in a full `npm install`
 * transcript, and the symptom only appears later, when WhatsApp Web rolls a build that carries the
 * rename. So restate it on the machine that is actually broken, as the engine starts.
 *
 * The marker is the loose test that opens the patcher's stand-down branch. The patcher then also
 * requires every site to carry its own text, so a release that fixes the ids another way reads as
 * healthy here while the install refuses it.
 */
const NORMALIZED_ID_MARKER = /_normalizeId\(|\.\$1/;

export const BACKPORT_MISSING_MESSAGE =
  'The installed whatsapp-web.js is missing the message-id backport this build requires. On current ' +
  'WhatsApp Web builds every send will fail with "the engine returned no message" — even when the ' +
  'message is delivered — and chat and media reads will fail with "r: r". The install skipped the ' +
  'patch, usually because neither the `patch` binary nor git was available. Apply it with ' +
  '`node scripts/patch-wwebjs-201832.js` (or reinstall with `npm install`) and restart. ' +
  'See docs/12-troubleshooting-faq.md.';

/**
 * The message for a tree the patcher began and did not finish: it kills a run's later files (an
 * out-of-memory kill, Ctrl-C or a full disk while `npm install` ran), and the patcher refuses the tree
 * from then on, so reapplying it does not help.
 */
export function partialBackportMessage(sites: string[]): string {
  return (
    'The installed whatsapp-web.js carries only part of the message-id backport this build requires: ' +
    `${sites.join(', ')} did not land, usually because an install was interrupted while the patch was ` +
    'being written. On current WhatsApp Web builds inbound messages and chat reads will fail with empty ids ' +
    'or "r: r". The patcher cannot repair that tree: reinstall the dependency ' +
    '(`rm -rf node_modules/whatsapp-web.js && npm ci`) and restart. See docs/12-troubleshooting-faq.md.'
  );
}

/**
 * Whether the installed whatsapp-web.js is known NOT to carry the backport.
 *
 * Any uncertainty reads as false — package unresolvable, sources pruned, a bundled install. An
 * install we cannot inspect is not evidence of a broken one, and a false alarm would send operators
 * chasing a patch they do not need.
 */
export function isBackportMissing(wwjsDir?: string): boolean {
  try {
    const dir = wwjsDir ?? path.dirname(require.resolve('whatsapp-web.js/package.json'));
    return !NORMALIZED_ID_MARKER.test(fs.readFileSync(path.join(dir, 'src', 'structures', 'Message.js'), 'utf8'));
  } catch {
    return false;
  }
}

/**
 * The sites of a backport the patcher began and did not finish, by relative path: the patcher's own
 * answer, so the guard and the patcher cannot disagree about which sites a finished backport has.
 * Empty when the patcher cannot be loaded, for the same reason {@link isBackportMissing} fails open.
 */
export function partialBackportSites(wwjsDir?: string): string[] {
  try {
    const dir = wwjsDir ?? path.dirname(require.resolve('whatsapp-web.js/package.json'));
    // `scripts/` sits beside dist/ and src/, three levels up, where the image copies the patchers.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const patcher = require(path.join(__dirname, '..', '..', '..', 'scripts', 'patch-wwebjs-201832.js')) as {
      missingSites?: (dir: string) => string[];
    };
    return patcher.missingSites?.(dir) ?? [];
  } catch {
    return [];
  }
}

/**
 * What the startup guard should say about the installed backport, or undefined when it needs no word.
 * A partly applied tree is named first: an interrupted run usually stops before Message.js, which then
 * reads as unpatched, and the patcher refuses a partly applied tree rather than finish it.
 */
export function backportProblem(wwjsDir?: string): string | undefined {
  const sites = partialBackportSites(wwjsDir);
  if (sites.length) return partialBackportMessage(sites);
  return isBackportMissing(wwjsDir) ? BACKPORT_MISSING_MESSAGE : undefined;
}
