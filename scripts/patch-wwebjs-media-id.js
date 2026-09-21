/**
 * Strip the media model's private id from the outgoing message whatsapp-web.js builds.
 *
 * `window.WWebJS.sendMessage` builds the outgoing message with `id: newMsgKey` and then spreads
 * the media model returned by `processMediaData` into it. On the WhatsApp Web builds rolled out
 * on 2026-09-17 that model carries an enumerable private `__x_id`, which lands on the plain object
 * and clobbers the id when the `Msg` model initialises: every media send fails with "Data passed
 * to getter must include an id property (it's how we memoize) but got undefined" while text keeps
 * working. Upstream carries the one-line fix in whatsapp-web.js PR #201923, unmerged, with no
 * release after 1.34.7; this applies the same line.
 *
 * The source transform is deliberately exact and self-disabling. An unknown shape fails the
 * production image build instead of silently shipping without the fix, and the patch stands down
 * once the installed tree carries the line itself.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const UTILS_PATH = path.join('src', 'util', 'Injected', 'Utils.js');
// The comment that follows the outgoing message object in sendMessage, unique in the file.
const ANCHOR = "        // Bot's won't reply if canonicalUrl is set (linking)\n";
const FIX = '        delete message.__x_id;\n\n';

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

function applyBackport(wwjsDir = DEFAULT_WWJS) {
  const utilsFile = path.join(wwjsDir, UTILS_PATH);
  if (!fs.existsSync(utilsFile)) {
    throw new Error(`whatsapp-web.js Utils.js not found at ${utilsFile}`);
  }

  const source = fs.readFileSync(utilsFile, 'utf8');
  const anchorCount = occurrences(source, ANCHOR);
  const fixCount = occurrences(source, FIX + ANCHOR);

  if (anchorCount === 1 && fixCount === 1) {
    return {
      skipped: true,
      reason: 'installed whatsapp-web.js already strips the media model id',
    };
  }
  if (anchorCount !== 1 || fixCount !== 0) {
    throw new Error(
      `unsupported Utils.js shape (anchors: ${anchorCount}, fixes: ${fixCount}); ` +
        're-evaluate the media id backport against the installed whatsapp-web.js',
    );
  }

  fs.writeFileSync(utilsFile, source.replace(ANCHOR, FIX + ANCHOR));
  return { skipped: false, note: 'media model id stripped from outgoing messages' };
}

/**
 * The stand-down branch above as a predicate, for the startup guard (engine-patch-status.ts).
 * Unreadable reads as applied: a tree we cannot inspect is not evidence of a broken one.
 */
function isApplied(wwjsDir = DEFAULT_WWJS) {
  try {
    const source = fs.readFileSync(path.join(wwjsDir, UTILS_PATH), 'utf8');
    return occurrences(source, ANCHOR) === 1 && occurrences(source, FIX + ANCHOR) === 1;
  } catch {
    return true;
  }
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyBackport();
    console.log(`patch-wwebjs-media-id: ${result.skipped ? `skipped: ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-media-id: skipped: ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-media-id: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyBackport, isApplied, ANCHOR, FIX };
