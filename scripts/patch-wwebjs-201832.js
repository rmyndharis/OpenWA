/**
 * Build-time backport of upstream whatsapp-web.js#201832 into the installed
 * whatsapp-web.js. Run after `npm ci` in the Docker production stage.
 *
 * Background: WhatsApp Web build 2.3000.x (rolled out ~2026-07-14) renamed the
 * serialized message-id property `id._serialized` to `id.$1` (a minifier-mangled
 * name). whatsapp-web.js 1.34.7 (what OpenWA pins) reads `_serialized` in the
 * Message constructor and ~40 downstream sites, so message ids, acks, quoted-
 * message resolution, and media downloads all break. Upstream fix #201832 adds a
 * `Base._normalizeId()` helper and reapplies it across the model constructors.
 * This script backports that fix into node_modules at image build time.
 *
 * Self-removing: it no-ops once the installed whatsapp-web.js already defines
 * `Base._normalizeId` (i.e. upstream shipped #201832 and OpenWA bumped its dep).
 *
 * Why `patch` and not `git apply`: a bare `git -C node_modules/whatsapp-web.js
 * apply` silently no-ops ("Skipped / 0 files changed") because the parent repo's
 * .git interferes with the diff's blob-SHA index lines. `patch` has no repo
 * discovery and applies cleanly.
 *
 * Known reject on 1.34.7: Contact.js hunk #2 targets a LID-aware block()/
 * unblock() path that does not exist in 1.34.7 (the PR's base is ahead there).
 * It is harmless — the rename cannot break absent code — so it is intentionally
 * dropped. Any OTHER reject means the installed shape drifted from the backport's
 * expected base; we abort the build loudly rather than ship a silently partial
 * patch.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const DEFAULT_PATCH = path.join(__dirname, 'wwebjs-201832.patch');
// The single hunk expected to reject on 1.34.7 (targets absent LID-block code).
const EXPECTED_REJECTS = new Set(['src/structures/Contact.js.rej']);

function findRej(root, dir = root) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findRej(root, full));
    } else if (entry.name.endsWith('.rej')) {
      out.push(path.relative(root, full));
    }
  }
  return out;
}

function applyBackport(wwjsDir = DEFAULT_WWJS, patchFile = DEFAULT_PATCH) {
  const baseJs = path.join(wwjsDir, 'src', 'structures', 'Base.js');
  if (!fs.existsSync(baseJs)) {
    throw new Error(`whatsapp-web.js not found at ${wwjsDir}`);
  }
  // Self-removal: upstream already shipped the fix.
  if (/_normalizeId/.test(fs.readFileSync(baseJs, 'utf8'))) {
    return { skipped: true, reason: 'Base._normalizeId already present (upstream fixed)' };
  }

  // Apply the real upstream diff via `patch` (no git-discovery interference).
  // --ignore-whitespace absorbs a trivial context-indent mismatch in GroupChat.js.
  // `patch` exits non-zero if any hunk is rejected; the expected Contact reject is
  // inspected below.
  try {
    execFileSync(
      'patch',
      ['-p1', '-d', wwjsDir, '-V', 'none', '-N', '-f', '--ignore-whitespace', '-i', patchFile],
      { stdio: 'pipe' },
    );
  } catch (_) {
    // expected: Contact.js hunk #2 rejects on 1.34.7; the reject set is verified below
  }

  const rej = findRej(wwjsDir);
  const unexpected = rej.filter((r) => !EXPECTED_REJECTS.has(r));
  if (unexpected.length) {
    throw new Error(
      `unexpected reject(s) — version skew vs the backport base: ${unexpected.join(', ')}. ` +
        'Re-evaluate scripts/wwebjs-201832.patch against the installed whatsapp-web.js.',
    );
  }

  // Verify the load-bearing normalization sites actually took.
  const read = (rel) => fs.readFileSync(path.join(wwjsDir, rel), 'utf8');
  const baseSrc = read('src/structures/Base.js');
  const msgSrc = read('src/structures/Message.js');
  if (!/static _normalizeId/.test(baseSrc)) {
    throw new Error('Base.js was not patched (static _normalizeId missing) — aborting.');
  }
  if (!/this\.id = Base\._normalizeId\(data\.id\)/.test(msgSrc)) {
    throw new Error('Message.js constructor was not patched — aborting.');
  }

  // Clean up the expected .rej (Contact.js hunk #2 intentionally dropped).
  for (const r of rej) fs.unlinkSync(path.join(wwjsDir, r));

  return {
    skipped: false,
    note: 'applied (Contact.js LID-block hunk intentionally skipped — absent in 1.34.7)',
  };
}

if (require.main === module) {
  try {
    const target = process.argv[2] || DEFAULT_WWJS;
    const res = applyBackport(target);
    console.log(`patch-wwebjs-201832: ${res.skipped ? `skipped — ${res.reason}` : res.note}`);
  } catch (e) {
    console.error(`patch-wwebjs-201832: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { applyBackport, DEFAULT_WWJS, DEFAULT_PATCH, EXPECTED_REJECTS };
