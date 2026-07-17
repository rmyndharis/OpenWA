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

// Every normalization site the backport must land, so a hunk that fails to apply can never pass
// unnoticed. `patch` always writes a .rej for a hunk it couldn't place, but a hunk placed at the
// WRONG offset would be silent — these assertions are what close that gap.
//
// This list must cover every file the patch normalizes, not just the structure constructors, because
// the skip branch below uses it to decide a half-patched tree apart from an upstream fix. `patch`
// applies the diff in file order and Utils.js is applied LAST, one file after Message.js — which is
// what the skip branch keys on. Omitting a file here means a run that died in that window leaves a
// tree where every assertion passes, so every later run stands down and the missing site latches in
// permanently. One entry per file: `siteLanded` resolves a file's marker with `.find`, so a second
// entry for the same path would never be read.
const REQUIRED_SITES = [
  ['src/structures/Base.js', /static _normalizeId\(id\)/],
  ['src/structures/Message.js', /this\.id = Base\._normalizeId\(data\.id\)/],
  ['src/structures/Chat.js', /this\.id = Base\._normalizeId\(data\.id\)/],
  ['src/structures/Contact.js', /this\.id = Base\._normalizeId\(data\.id\)/],
  ['src/structures/Channel.js', /this\.id = Base\._normalizeId\(data\.id\)/],
  ['src/structures/Broadcast.js', /this\.id = Base\._normalizeId\(data\.id\)/],
  ['src/structures/GroupNotification.js', /this\.id = Base\._normalizeId\(data\.id\)/],
  ['src/structures/ClientInfo.js', /this\.wid = Base\._normalizeId\(data\.wid\)/],
  // The browser-side normalizer every inbound message crosses on its way to Node — the site the
  // structure constructors above cannot cover, and the last file the patch writes.
  ['src/util/Injected/Utils.js', /_serialized: msg\.id\.\$1/],
  ['src/Client.js', /res\.gid\._serialized \|\| res\.gid\.\$1/],
  ['src/structures/GroupChat.js', /pWid\._serialized \|\| pWid\.\$1/],
];

/** Artifacts `patch` can leave behind. `.~N~` are GNU's backup-if-mismatch copies of pre-patch source. */
const ARTIFACT_RE = /(\.rej|\.orig|~)$/;

/** True once `rel`'s REQUIRED_SITES marker is present in the installed tree. */
function siteLanded(wwjsDir, rel) {
  const marker = REQUIRED_SITES.find(([r]) => r === rel)[1];
  return marker.test(fs.readFileSync(path.join(wwjsDir, rel), 'utf8'));
}

/**
 * Flag an error raised against a tree that is no longer pristine — either this run wrote to it, or a
 * previous run left it half-patched. `--best-effort` degrades on a pre-flight failure (no `patch`
 * binary — nothing ran, tree untouched) but must never swallow one of these: `patch` applies hunks as
 * it goes, so failing mid-apply leaves whatsapp-web.js half-patched — which the self-disable check
 * above reads as healthy, latching the broken tree in on every later run.
 */
function partialTree(err) {
  err.leftPartialTree = true;
  return err;
}

function findArtifacts(root, dir = root) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findArtifacts(root, full));
    } else if (ARTIFACT_RE.test(entry.name)) {
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
  // Self-removal: once the installed whatsapp-web.js normalizes ids itself, this backport steps
  // aside. Detect on the id-normalizing READ in the Message constructor rather than on Base.js's
  // helper: Message.js is the load-bearing site (OpenWA reads `msg.id._serialized` in ~40 places),
  // and keying off Base.js alone would treat a half-patched tree — helper present, constructor not —
  // as "already fixed" and ship it. Matched loosely (`Base._normalizeId(` OR an inline `$1` fallback)
  // so a future upstream release that fixes this differently still stands the patcher down.
  const msgJs = path.join(wwjsDir, 'src', 'structures', 'Message.js');
  const msgSrc = fs.readFileSync(msgJs, 'utf8');
  if (/_normalizeId\(|\.\$1/.test(msgSrc)) {
    // Message.js normalizing is necessary but NOT sufficient to stand down. `patch` writes as it goes and
    // Message.js is patched early, so a run that died part-way through lands here too — and skipping would
    // latch that half-patched tree in permanently, because every later run takes this same branch and never
    // reaches the assertions below. An upstream release that fixes this lands every site at once; a crashed
    // run does not. Proving the tree is whole is what tells the two apart.
    const missing = REQUIRED_SITES.filter(([rel]) => !siteLanded(wwjsDir, rel));
    if (missing.length) {
      // `partialTree`, so `--best-effort` cannot warn past this. The tree this detects is precisely the
      // one that flag must never wave through: half-patched, self-disable reading it as healthy, and
      // unrepairable by any later run.
      throw partialTree(
        new Error(
          'whatsapp-web.js is PARTIALLY patched — Message.js normalizes ids but ' +
            `${missing.map(([rel]) => rel).join(', ')} did not land. A previous run left the tree half-patched; ` +
            'it cannot repair itself. Reinstall the dependency (`rm -rf node_modules/whatsapp-web.js && npm ci`) ' +
            'and re-run. If the installed version genuinely ships its own fix, drop this backport instead.',
        ),
      );
    }
    return { skipped: true, reason: 'installed whatsapp-web.js already normalizes message ids' };
  }

  // Apply the real upstream diff via `patch` (no git-discovery interference).
  // Flags, each load-bearing:
  //   --no-backup-if-mismatch  GNU patch defaults to writing `<file>.~1~` backups for every file
  //                            whose hunks needed an offset or rejected — 328K of pre-patch source
  //                            that would otherwise ship in the image. (`-V none` does NOT do this;
  //                            it only picks the backup *style*.) BSD patch has no such default,
  //                            which is why this is invisible on macOS and only bites in Debian CI.
  //   -F0                      No fuzz: a hunk must match exactly, never slide onto a similar-looking
  //                            neighbouring block. Fuzzed application would be silent — invisible to
  //                            both the reject-set check and the assertions below.
  //   --ignore-whitespace      Absorbs a trivial context-indent mismatch in GroupChat.js.
  //   -f -N                    Never prompt; `-f` also forces already-applied hunks to reject loudly
  //                            rather than be skipped silently.
  // With these, GNU and BSD patch produce byte-identical trees, so a local macOS run faithfully
  // reproduces the Debian image build.
  try {
    execFileSync(
      'patch',
      ['-p1', '-d', wwjsDir, '--no-backup-if-mismatch', '-N', '-f', '-F0', '--ignore-whitespace', '-i', patchFile],
      { stdio: 'pipe' },
    );
  } catch (e) {
    // `patch` exits 1 when hunks reject — expected here (Contact.js hunk #2), and the reject set is
    // verified below. Anything else (2 = serious trouble, ENOENT = `patch` not installed) is a real
    // failure: rethrow it rather than let the assertions below misreport it as version skew.
    if (e.status !== 1) {
      const detail = e.stderr ? String(e.stderr).trim() : e.message;
      const err = new Error(`\`patch\` failed (${e.code ?? `exit ${e.status}`}): ${detail}`);
      // ENOENT means `patch` never executed, so the tree is untouched and degrading is still safe.
      throw e.code === 'ENOENT' ? err : partialTree(err);
    }
  }

  const artifacts = findArtifacts(wwjsDir);
  const unexpected = artifacts.filter(a => !EXPECTED_REJECTS.has(a));
  if (unexpected.length) {
    throw partialTree(
      new Error(
        `unexpected patch artifact(s) — version skew vs the backport base: ${unexpected.join(', ')}. ` +
          'Re-evaluate scripts/wwebjs-201832.patch against the installed whatsapp-web.js.',
      ),
    );
  }

  // Verify EVERY normalization site landed — a hunk placed at a wrong offset leaves no .rej.
  for (const [rel, marker] of REQUIRED_SITES) {
    if (!siteLanded(wwjsDir, rel)) {
      throw partialTree(
        new Error(`${rel} was not patched (missing ${marker}) — aborting rather than ship a partial backport.`),
      );
    }
  }

  // Clean up the expected .rej (Contact.js hunk #2 intentionally dropped).
  for (const a of artifacts) fs.unlinkSync(path.join(wwjsDir, a));

  return {
    skipped: false,
    note: 'applied (Contact.js LID-block hunk intentionally skipped — absent in 1.34.7)',
  };
}

if (require.main === module) {
  // `--best-effort` (used by the postinstall hook) warns instead of failing. The image build runs
  // without it: there, an unpatched whatsapp-web.js must abort the build rather than ship broken.
  // Locally the same failure is only a degraded dev install — `patch` may not exist at all (Windows
  // without WSL), and a Baileys-only user has no reason to care — so breaking `npm install` over it
  // would be worse than the bug.
  const bestEffort = process.argv.includes('--best-effort');
  const target = process.argv.find(a => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1]);
  try {
    const res = applyBackport(target || DEFAULT_WWJS);
    console.log(`patch-wwebjs-201832: ${res.skipped ? `skipped — ${res.reason}` : res.note}`);
  } catch (e) {
    // `--best-effort` degrades only while the tree is still pristine — an unpatched whatsapp-web.js is a
    // known-degraded dev install, which is the trade this flag exists to make. A HALF-patched one is not
    // that trade: it is undetectable afterwards (the self-disable check reads it as healthy) and would
    // ship silently. Fail on it regardless of the flag.
    if (bestEffort && !e.leftPartialTree) {
      console.warn(
        `patch-wwebjs-201832: skipped — ${e.message}\n` +
          '  Inbound media/message ids may be broken on current WhatsApp Web builds (#747).\n' +
          '  The published Docker image applies this automatically; see scripts/patch-wwebjs-201832.js.',
      );
      return;
    }
    console.error(`patch-wwebjs-201832: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { applyBackport, DEFAULT_WWJS, DEFAULT_PATCH, EXPECTED_REJECTS };
