import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { type PatchFamily, unappliedPatches, unappliedPatchesMessage } from './engine-patch-status';

/**
 * Guards the startup diagnostic for engine patches that never applied. The cost runs both ways, as
 * it does for `wwebjs-backport-check.ts`: a missed detection restores the silence the guard exists
 * to break, and a false alarm on every boot sends operators after patches they do not need. The
 * "cannot tell" cases below are the second half of that, and they matter more here than in the
 * single-patcher guard, because this one walks a directory and requires whatever it finds.
 */
describe('unappliedPatches', () => {
  const tmpDirs: string[] = [];

  function tmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  /** A scripts/ directory holding stub patchers, each written as the module the guard requires. */
  function scriptsWith(modules: Record<string, string>): string {
    const dir = tmp('openwa-patch-scripts-');
    for (const [name, body] of Object.entries(modules)) fs.writeFileSync(path.join(dir, name), body);
    return dir;
  }

  const patcher = (applied: boolean): string => `module.exports = { isApplied: () => ${String(applied)} };\n`;

  afterAll(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names only the patchers whose predicate answers false', () => {
    const scripts = scriptsWith({
      'patch-wwebjs-alpha.js': patcher(true),
      'patch-wwebjs-beta.js': patcher(false),
      'patch-wwebjs-gamma.js': patcher(false),
    });

    expect(unappliedPatches('wwebjs', scripts, tmp('dep-'))).toEqual(['patch-wwebjs-beta', 'patch-wwebjs-gamma']);
  });

  it('reports nothing when every patcher is applied', () => {
    const scripts = scriptsWith({ 'patch-wwebjs-alpha.js': patcher(true) });

    expect(unappliedPatches('wwebjs', scripts, tmp('dep-'))).toEqual([]);
  });

  it('keeps each family to its own patchers', () => {
    const scripts = scriptsWith({
      'patch-wwebjs-alpha.js': patcher(false),
      'patch-baileys-alpha.js': patcher(false),
    });

    expect(unappliedPatches('wwebjs', scripts, tmp('dep-'))).toEqual(['patch-wwebjs-alpha']);
    expect(unappliedPatches('baileys', scripts, tmp('dep-'))).toEqual(['patch-baileys-alpha']);
  });

  it('passes the resolved dependency directory to the predicate', () => {
    const dep = tmp('dep-');
    const scripts = scriptsWith({
      'patch-wwebjs-alpha.js': 'module.exports = { isApplied: dir => dir !== process.env.OPENWA_EXPECTED_DEP };\n',
    });
    process.env.OPENWA_EXPECTED_DEP = dep;

    try {
      // The predicate answers false only when it was handed exactly the directory we passed in, so
      // a guard that called isApplied() with no argument would report nothing here.
      expect(unappliedPatches('wwebjs', scripts, dep)).toEqual(['patch-wwebjs-alpha']);
    } finally {
      delete process.env.OPENWA_EXPECTED_DEP;
    }
  });

  it('ignores specs, non-patchers and anything that is not a .js file', () => {
    const scripts = scriptsWith({
      'patch-wwebjs-alpha.spec.js': patcher(false),
      'patch-wwebjs-alpha.js': patcher(true),
      'check-audit.mjs': patcher(false),
      'wwebjs-201832.patch': 'not javascript at all',
    });

    expect(unappliedPatches('wwebjs', scripts, tmp('dep-'))).toEqual([]);
  });

  it('skips a patcher that exports no predicate rather than reporting it', () => {
    // This is patch-wwebjs-201832.js's situation: guarded elsewhere, so it opts out by omission.
    const scripts = scriptsWith({
      'patch-wwebjs-legacy.js': 'module.exports = { applyBackport: () => undefined };\n',
      'patch-wwebjs-alpha.js': patcher(false),
    });

    expect(unappliedPatches('wwebjs', scripts, tmp('dep-'))).toEqual(['patch-wwebjs-alpha']);
  });

  it('skips a patcher that cannot be required instead of failing the boot', () => {
    const scripts = scriptsWith({
      'patch-wwebjs-broken.js': 'this is not valid javascript {{{\n',
      'patch-wwebjs-alpha.js': patcher(false),
    });

    expect(unappliedPatches('wwebjs', scripts, tmp('dep-'))).toEqual(['patch-wwebjs-alpha']);
  });

  it('stays quiet when there is no scripts directory to read', () => {
    expect(unappliedPatches('wwebjs', path.join(tmp('openwa-empty-'), 'absent'), tmp('dep-'))).toEqual([]);
  });

  it('stays quiet when the dependency cannot be resolved', () => {
    const scripts = scriptsWith({ 'patch-wwebjs-alpha.js': patcher(false) });

    // Both engines are always installed here, so the only way to reach the unresolvable branch is
    // a family with no package behind it. That stands in for the real case: an install whose
    // engine library is absent or pruned is not an install we can judge, and the patcher stubs
    // above would otherwise be reported as missing.
    expect(unappliedPatches('absent-engine' as PatchFamily, scripts)).toEqual([]);
  });
});

describe('the patchers this repository actually ships', () => {
  const scripts = path.join(__dirname, '..', '..', '..', 'scripts');
  const shipped = fs
    .readdirSync(scripts)
    .filter(f => f.startsWith('patch-') && f.endsWith('.js') && !f.endsWith('.spec.js'))
    .sort();

  it('finds the patchers at all', () => {
    // Vacuity guard: an empty scan would make both assertions below pass without checking anything.
    expect(shipped.length).toBeGreaterThanOrEqual(9);
  });

  it('exports a predicate from every patcher except the one guarded elsewhere', () => {
    const withoutPredicate = shipped.filter(f => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const patcher = require(path.join(scripts, f)) as { isApplied?: unknown };
      return typeof patcher.isApplied !== 'function';
    });

    // patch-wwebjs-201832.js is covered by wwebjs-backport-check.ts, which has its own predicate,
    // its own message and its own docs/12 entry. It is the ONLY patcher allowed to opt out: any
    // other name here is a patcher whose failure to apply would be silent again.
    expect(withoutPredicate).toEqual(['patch-wwebjs-201832.js']);
  });

  it('names a family this guard understands in every patcher filename', () => {
    // A patcher named outside both prefixes would be silently invisible to unappliedPatches.
    const unfamiliar = shipped.filter(f => !f.startsWith('patch-wwebjs-') && !f.startsWith('patch-baileys-'));

    expect(unfamiliar).toEqual([]);
  });
});

describe('unappliedPatchesMessage', () => {
  it('names the library, the count, every patcher and a command for each', () => {
    const message = unappliedPatchesMessage('wwebjs', ['patch-wwebjs-media-id', 'patch-wwebjs-status']);

    expect(message).toContain('whatsapp-web.js');
    expect(message).toContain('missing 2');
    expect(message).toContain('patch-wwebjs-media-id, patch-wwebjs-status');
    expect(message).toContain('node scripts/patch-wwebjs-media-id.js');
    expect(message).toContain('node scripts/patch-wwebjs-status.js');
    expect(message).toContain('docs/12-troubleshooting-faq.md');
  });

  it('offers the reinstall only for the cause it fixes, and says a refused shape needs more', () => {
    const message = unappliedPatchesMessage('baileys', ['patch-baileys-appstate']);

    expect(message).toMatch(/When it ran with --ignore-scripts, apply them with[\s\S]*?reinstall with `npm install`/);
    expect(message).toMatch(/refused a source shape[^.]*is not fixed by either/);
  });

  it('names the Baileys package for the baileys family', () => {
    expect(unappliedPatchesMessage('baileys', ['patch-baileys-appstate'])).toContain('@whiskeysockets/baileys');
  });
});
