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
 * Why `patch` first and not `git apply`: a bare `git -C node_modules/whatsapp-web.js
 * apply` silently no-ops ("Skipped / 0 files changed") because the parent repo's
 * .git interferes with the diff's blob-SHA index lines. `patch` has no repo
 * discovery and applies cleanly. `git apply` is still the fallback when the `patch`
 * binary is missing — see applyWithGit, which fences off that repo discovery.
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
const os = require('os');
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

/** Keep artifact keys stable across POSIX and Windows for EXPECTED_REJECTS comparisons. */
function normalizeArtifactPath(rel) {
  return rel.replaceAll('\\', '/');
}

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
      out.push(normalizeArtifactPath(path.relative(root, full)));
    }
  }
  return out;
}

/**
 * Fallback applier for hosts without the GNU `patch` binary — the default on Windows outside Git
 * Bash, and the reason a native install could silently ship an unpatched whatsapp-web.js while
 * `npm install` still reported success (#889). Anyone installing from source necessarily has git,
 * so this closes that gap without adding a dependency.
 *
 * GIT_CEILING_DIRECTORIES is what makes it work at all: without it git discovers the parent OpenWA
 * repo, whose index the diff's blob SHAs do not match, and skips every file while exiting 0. Aimed
 * at node_modules, discovery stops before it can reach any repo.
 *
 * `--reject` reproduces GNU patch's behaviour on this patch exactly — byte-identical tree, the same
 * single Contact.js reject, the same exit 1 — so the caller's artifact and REQUIRED_SITES checks
 * apply unchanged. core.autocrlf is forced off because a Windows global config would otherwise
 * rewrite line endings in the files it touches, producing a tree no other platform generates.
 */
/**
 * Hand the appliers a patch with LF line endings, copying to a temp file only when the checked-out one
 * has CRLF.
 *
 * Neither applier accepts CRLF: a unified diff line must start with ' ', '+', '-' or '@', and a bare
 * \r is none of those, so both stop at line 7 of this patch — its first empty context line (`git
 * apply`: "corrupt patch at line 7"; `patch`: "malformed patch at line 7"). Windows checks the file out
 * that way whenever `core.autocrlf` is on, which is its default, so the git fallback added for Windows
 * could never actually run there and took `npm install` down with it (#889).
 *
 * The `.gitattributes` rule keeps fresh clones on LF; this repairs the ones already on disk, which that
 * rule cannot reach. Everywhere else the file is already LF and this is a single read with no temp file.
 */
function withLfPatch(patchFile, run) {
  const raw = fs.readFileSync(patchFile, 'utf8');
  if (!raw.includes('\r\n')) return run(patchFile);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwebjs-201832-'));
  try {
    const lf = path.join(dir, path.basename(patchFile));
    fs.writeFileSync(lf, raw.replace(/\r\n/g, '\n'));
    return run(lf);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `git apply` exit 128 is its generic "fatal", and only SOME fatals happen before anything is written.
 * It parses the whole patch up front, so a diff it cannot read — or a bad invocation — is refused with
 * the tree untouched; that is the case the Windows CRLF handling needs to degrade cleanly. A fatal
 * raised while writing results (read-only tree, full disk) leaves the files already written in place,
 * and classifying THAT as pristine lets `--best-effort` wave a half-patched dependency through with
 * exit 0 — which is exactly what the flag must never do, because a half-patched tree reads as healthy
 * afterwards. So match the messages git emits before it writes, not the exit code on its own.
 */
// Verified against the messages git actually emits: a CRLF patch gives "corrupt patch at line N" and a
// non-diff gives "No valid patches in input" (older builds: "unrecognized input"). Both are refusals
// raised while parsing, before a single file is touched.
const GIT_APPLY_REFUSED_INPUT =
  /corrupt patch|unrecognized input|no valid patches in input|only garbage|usage: git apply|not a git repository|No such file or directory/i;

/** True only when a `git apply` failure provably happened before anything was written. */
function gitApplyLeftTreeUntouched(e) {
  if (e.code === 'ENOENT') return true; // git never executed at all
  if (e.status !== 128) return false; // any other failure may have written
  return GIT_APPLY_REFUSED_INPUT.test(e.stderr ? String(e.stderr) : e.message || '');
}

function applyWithGit(wwjsDir, patchFile) {
  try {
    execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', '-p1', '--reject', '--ignore-whitespace', patchFile], {
      cwd: wwjsDir,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(wwjsDir) },
      stdio: 'pipe',
    });
  } catch (e) {
    // Exit 1 = hunks rejected: expected, and verified against EXPECTED_REJECTS by the caller.
    if (e.status === 1) return;
    const detail = e.stderr ? String(e.stderr).trim() : e.message;
    const err = new Error(`neither \`patch\` nor \`git apply\` could run (${e.code ?? `exit ${e.status}`}): ${detail}`);
    // Degrade only when nothing can have been written: ENOENT means git never executed at all, and a
    // 128 whose message is one of git's pre-write refusals means it rejected the input before applying
    // anything. Any other failure — including a 128 raised midway through writing results — has to be
    // treated as a partial tree. A rejected hunk is exit 1, which returned above.
    throw gitApplyLeftTreeUntouched(e) ? err : partialTree(err);
  }
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
  if (!fs.existsSync(msgJs)) {
    // A dep tree with Base.js but no Message.js is version skew vs the backport base — say so,
    // instead of dying on a raw ENOENT from the read below. A plain Error, NOT partialTree:
    // nothing has been written yet, so `--best-effort` may still degrade on a pristine tree.
    throw new Error(
      `whatsapp-web.js at ${wwjsDir} has src/structures/Base.js but no src/structures/Message.js — ` +
        'version skew vs the backport base. Reinstall the dependency, or drop this backport if the ' +
        'installed version restructured these files.',
    );
  }
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
  withLfPatch(patchFile, lfPatch => {
    try {
      execFileSync(
        'patch',
        ['-p1', '-d', wwjsDir, '--no-backup-if-mismatch', '-N', '-f', '-F0', '--ignore-whitespace', '-i', lfPatch],
        { stdio: 'pipe' },
      );
    } catch (e) {
      // `patch` exits 1 when hunks reject — expected here (Contact.js hunk #2), and the reject set is
      // verified below. ENOENT means the binary is absent: apply with git instead of leaving the dep
      // unpatched. Anything else (2 = serious trouble) is a real failure: rethrow it rather than let
      // the assertions below misreport it as version skew.
      if (e.code === 'ENOENT') {
        applyWithGit(wwjsDir, lfPatch);
      } else if (e.status !== 1) {
        const detail = e.stderr ? String(e.stderr).trim() : e.message;
        throw partialTree(new Error(`\`patch\` failed (${e.code ?? `exit ${e.status}`}): ${detail}`));
      }
    }
  });

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

module.exports = {
  applyBackport,
  normalizeArtifactPath,
  gitApplyLeftTreeUntouched,
  DEFAULT_WWJS,
  DEFAULT_PATCH,
  EXPECTED_REJECTS,
};
