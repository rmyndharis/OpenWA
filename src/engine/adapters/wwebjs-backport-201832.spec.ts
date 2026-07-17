import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The patcher is a CommonJS build script (scripts/*.js); import it with a typed
// shape so the spec stays under the strict lint rules.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyBackport, DEFAULT_PATCH: PATCH_FILE } = require('../../../scripts/patch-wwebjs-201832') as {
  applyBackport: (wwjsDir: string, patchFile?: string) => { skipped: boolean; reason?: string; note?: string };
  DEFAULT_PATCH: string;
};

const WWJS_SRC = path.join(__dirname, '..', '..', '..', 'node_modules', 'whatsapp-web.js');
/** The patcher's CLI entrypoint — the `--best-effort` cases exercise the process, not just applyBackport. */
const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'patch-wwebjs-201832.js');

/**
 * Guards the build-time backport of upstream whatsapp-web.js#201832
 * (`id._serialized` -> `id.$1` normalization, broken by WA Web 2.3000.x). Each
 * case runs the patcher against a temp COPY of the installed whatsapp-web.js so
 * the real node_modules install is never mutated. This covers the boot-smoke
 * blind spot (boot-smoke only curls /api/health/live and never exercises the
 * patched paths): if the patcher ever fails to restore the normalization sites,
 * or drifts on a future whatsapp-web.js bump, these tests fail loudly.
 */
describe('patch-wwebjs-201832 (build-time backport of upstream #201832)', () => {
  const tmpDirs: string[] = [];

  /**
   * A pristine (unpatched) copy of the installed whatsapp-web.js.
   *
   * The install itself is not a reliable fixture: `postinstall` applies this same backport, so
   * node_modules is patched on a normal `npm install` but pristine in the Docker builder stage
   * (which installs before `scripts/` is copied). Reverse the constructor rewrites on the copy so
   * every case starts from the same known-unpatched shape either way.
   */
  function copyWwjs(): string {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-backport-'));
    tmpDirs.push(tmp);
    const copy = path.join(tmp, 'whatsapp-web.js');
    fs.cpSync(WWJS_SRC, copy, { recursive: true });

    const baseJs = path.join(copy, 'src', 'structures', 'Base.js');
    if (!/static _normalizeId/.test(fs.readFileSync(baseJs, 'utf8'))) return copy; // already pristine

    // Reverse-apply the same diff rather than hand-unpicking it: symmetric with the forward path, and
    // it stays correct by construction if the patch file changes. Exits 1 on the Contact.js hunk that
    // was never applied in the first place — expected, hence the ignored status.
    try {
      execFileSync(
        'patch',
        ['-p1', '-d', copy, '-R', '--no-backup-if-mismatch', '-f', '-F0', '--ignore-whitespace', '-i', PATCH_FILE],
        { stdio: 'pipe' },
      );
    } catch (e) {
      if ((e as { status?: number }).status !== 1) throw e;
    }
    for (const rej of ['src/structures/Contact.js.rej']) {
      fs.rmSync(path.join(copy, rej), { force: true });
    }
    return copy;
  }

  afterAll(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('self-removes (no-ops) once the installed dep normalizes ids itself', () => {
    const dir = copyWwjs();
    // Land the fix the way an upstream release would — every site at once. Normalizing only SOME sites
    // is a half-patched tree, not a fixed one, and must not be used to simulate this (see below).
    applyBackport(dir);
    const injected = path.join(dir, 'src', 'util', 'Injected', 'Utils.js');
    const before = fs.readFileSync(injected, 'utf8');

    const res = applyBackport(dir);

    expect(res.skipped).toBe(true);
    // Re-applying would reject every already-applied hunk and leave artifacts behind, so a byte-identical
    // Injected/Utils.js is what proves the patcher truly stood down rather than quietly ran again.
    expect(fs.readFileSync(injected, 'utf8')).toBe(before);
  });

  it('refuses to stand down when only the last-applied file is missing', () => {
    const dir = copyWwjs();
    const injected = path.join(dir, 'src', 'util', 'Injected', 'Utils.js');
    const pristine = fs.readFileSync(injected, 'utf8');
    applyBackport(dir);
    // `patch` writes in diff order and Injected/Utils.js is the LAST of the twelve files, one after
    // Message.js — which is what the stand-down check keys on. A run that died in that window leaves
    // exactly this tree: every structure constructor normalizes, so the tree reads as healthy, while the
    // browser-side normalizer every inbound message crosses never landed. Asserting only the structure
    // files would wave it through and latch it in for good.
    fs.writeFileSync(injected, pristine);

    expect(() => applyBackport(dir)).toThrow(/PARTIALLY patched[\s\S]*Injected\/Utils\.js/);
  });

  it('refuses to stand down on a half-patched tree', () => {
    const dir = copyWwjs();
    // Exactly what a run that died mid-apply leaves: `patch` writes as it goes and Message.js is patched
    // early, so the load-bearing constructor normalizes while its siblings never did. Standing down here
    // latches the broken tree in for good — every later run reads Message.js and takes the same branch —
    // and ships a whatsapp-web.js whose ids work in some paths and not others.
    const msgJs = path.join(dir, 'src', 'structures', 'Message.js');
    fs.writeFileSync(
      msgJs,
      fs.readFileSync(msgJs, 'utf8').replace('this.id = data.id', 'this.id = Base._normalizeId(data.id)'),
    );

    expect(() => applyBackport(dir)).toThrow(/PARTIALLY patched/);
  });

  it('applies the backport across every id-normalization site', () => {
    const dir = copyWwjs();

    const res = applyBackport(dir);

    expect(res.skipped).toBe(false);
    const read = (rel: string): string => fs.readFileSync(path.join(dir, rel), 'utf8');
    // Root helper + the load-bearing Message constructor that OpenWA's ~40
    // `msg.id._serialized` reads depend on, plus every sibling structure.
    expect(read('src/structures/Base.js')).toContain('static _normalizeId');
    expect(read('src/structures/Message.js')).toContain('this.id = Base._normalizeId(data.id)');
    for (const f of ['Chat', 'Contact', 'Channel', 'Broadcast', 'GroupNotification']) {
      expect(read(`src/structures/${f}.js`)).toContain('this.id = Base._normalizeId(data.id)');
    }
    expect(read('src/structures/ClientInfo.js')).toContain('this.wid = Base._normalizeId(data.wid)');
    // from/to/author fallbacks (OpenWA reads these as chat/sender strings).
    expect(read('src/structures/Message.js')).toMatch(/data\.from\._serialized \|\| data\.from\.\$1/);
  });

  it('leaves no patch artifacts in the image', () => {
    const dir = copyWwjs();

    applyBackport(dir);

    // GNU patch writes `<file>.~1~` backups of pre-patch source on any offset/reject
    // (BSD patch does not — which is why this must be asserted, not eyeballed on macOS).
    // Rejects are cleaned too. Anything left here would ship in the production image.
    const leftovers: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (/(\.rej|\.orig|~)$/.test(e.name)) leftovers.push(path.relative(dir, full));
      }
    };
    walk(dir);
    expect(leftovers).toEqual([]);
  });

  it('normalizes a $1-only id while leaving a healthy id untouched', () => {
    const dir = copyWwjs();
    applyBackport(dir);

    // The load-bearing invariant, exercised rather than grepped: on an affected
    // build `_serialized` is synthesized from `$1`; on a healthy build the id must
    // pass through byte-for-byte (identity), so unaffected users see no change.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Base = require(path.join(dir, 'src', 'structures', 'Base.js')) as {
      _normalizeId: (id: unknown) => { _serialized?: string };
    };

    const affected = { $1: 'true_123@c.us_ABC', remote: '123@c.us', fromMe: true, id: 'ABC' };
    expect(Base._normalizeId(affected)._serialized).toBe('true_123@c.us_ABC');
    // Sibling fields survive the copy — OpenWA reads id.remote / id.id downstream.
    expect(Base._normalizeId(affected)).toMatchObject({ remote: '123@c.us', fromMe: true, id: 'ABC' });

    const healthy = { _serialized: 'true_123@c.us_XYZ', remote: '123@c.us' };
    expect(Base._normalizeId(healthy)).toBe(healthy); // identity — same reference, not a copy
  });

  it('aborts loudly on unexpected version skew', () => {
    const dir = copyWwjs();
    // Break the exact line the Message hunk targets -> that hunk rejects, which
    // is NOT in the expected-reject set -> the patcher must throw rather than
    // ship a partially patched whatsapp-web.js.
    const msgJs = path.join(dir, 'src', 'structures', 'Message.js');
    fs.writeFileSync(msgJs, fs.readFileSync(msgJs, 'utf8').replace('this.id = data.id', 'this.id = DATA_ID_MOVED'));

    expect(() => applyBackport(dir)).toThrow(/version skew/);
  });

  // `npm ci` fires the postinstall hook (--best-effort) BEFORE the image build's strict run, so
  // --best-effort decides what the strict run inherits. Both directions are load-bearing.
  describe('--best-effort', () => {
    it('still fails when the tree was already written', () => {
      const dir = copyWwjs();
      // Skew a hunk so `patch` mutates the tree and only THEN rejects. Degrading here would leave a
      // half-patched tree that the strict run reads as healthy and waves through — a green build
      // shipping broken ids. An unpatched dep is the trade this flag exists to make; this is not.
      const chatJs = path.join(dir, 'src', 'structures', 'Chat.js');
      fs.writeFileSync(chatJs, fs.readFileSync(chatJs, 'utf8').replace('this.id = data.id', 'this.id = MOVED'));

      const res = spawnSync(process.execPath, [SCRIPT, '--best-effort', dir], { encoding: 'utf8' });

      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/version skew/);
    });

    it('still fails on a tree an earlier run left half-patched', () => {
      const dir = copyWwjs();
      const injected = path.join(dir, 'src', 'util', 'Injected', 'Utils.js');
      const pristine = fs.readFileSync(injected, 'utf8');
      applyBackport(dir);
      fs.writeFileSync(injected, pristine);

      // This run writes nothing itself — it only detects a tree an earlier run broke. Degrading on that
      // is the one thing the flag must never do: it would warn, exit 0, and hand the strict run a tree
      // whose stand-down check reads as healthy. The trade this flag makes is an UNPATCHED dep, never a
      // half-patched one.
      const res = spawnSync(process.execPath, [SCRIPT, '--best-effort', dir], { encoding: 'utf8' });

      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/PARTIALLY patched/);
    });

    it('degrades when `patch` is not installed, leaving the tree pristine', () => {
      const dir = copyWwjs();
      // The case the flag exists for (Windows outside WSL, Baileys-only setups): `patch` never runs, so
      // nothing was written and a warning beats breaking `npm install`. Emptying PATH is what makes the
      // lookup fail; node itself is invoked by absolute path and is unaffected.
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-nopath-'));
      tmpDirs.push(emptyDir);

      const res = spawnSync(process.execPath, [SCRIPT, '--best-effort', dir], {
        encoding: 'utf8',
        env: { ...process.env, PATH: emptyDir },
      });

      expect(res.status).toBe(0);
      expect(res.stderr).toMatch(/skipped/);
      expect(fs.readFileSync(path.join(dir, 'src', 'structures', 'Message.js'), 'utf8')).toContain('this.id = data.id');
    });
  });
});
