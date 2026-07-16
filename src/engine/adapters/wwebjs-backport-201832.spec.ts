import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The patcher is a CommonJS build script (scripts/*.js); import it with a typed
// shape so the spec stays under the strict lint rules.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applyBackport } = require('../../../scripts/patch-wwebjs-201832') as {
  applyBackport: (wwjsDir: string, patchFile?: string) => { skipped: boolean; reason?: string; note?: string };
};

const WWJS_SRC = path.join(__dirname, '..', '..', '..', 'node_modules', 'whatsapp-web.js');

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
  function copyWwjs(): string {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-backport-'));
    const copy = path.join(tmp, 'whatsapp-web.js');
    fs.cpSync(WWJS_SRC, copy, { recursive: true });
    return copy;
  }

  it('self-removes (no-ops) once the upstream fix is already present', () => {
    const dir = copyWwjs();
    const baseJs = path.join(dir, 'src', 'structures', 'Base.js');
    fs.writeFileSync(baseJs, fs.readFileSync(baseJs, 'utf8') + '\nstatic _normalizeId(){}\n');

    const res = applyBackport(dir);

    expect(res.skipped).toBe(true);
    // The Message constructor is left untouched (we only injected the marker).
    const msg = fs.readFileSync(path.join(dir, 'src', 'structures', 'Message.js'), 'utf8');
    expect(msg).toContain('this.id = data.id');
  });

  it('applies the backport and restores id._serialized across the Message path', () => {
    const dir = copyWwjs();

    const res = applyBackport(dir);

    expect(res.skipped).toBe(false);
    const base = fs.readFileSync(path.join(dir, 'src', 'structures', 'Base.js'), 'utf8');
    const msg = fs.readFileSync(path.join(dir, 'src', 'structures', 'Message.js'), 'utf8');
    // Root normalization helper + the load-bearing constructor reassignment that
    // OpenWA's ~40 `msg.id._serialized` reads depend on.
    expect(base).toContain('static _normalizeId');
    expect(msg).toContain('this.id = Base._normalizeId(data.id)');
    // from/to/author fallbacks (OpenWA reads these as chat/sender strings).
    expect(msg).toMatch(/data\.from\._serialized \|\| data\.from\.\$1/);
    // Contact hunk #1 (constructor) applies even though hunk #2 (LID-block)
    // rejects — so contacts get normalized ids too.
    const contact = fs.readFileSync(path.join(dir, 'src', 'structures', 'Contact.js'), 'utf8');
    expect(contact).toContain('this.id = Base._normalizeId(data.id)');
    // The one expected reject is cleaned up; no .rej files leak into the image.
    const structDir = path.join(dir, 'src', 'structures');
    expect(fs.readdirSync(structDir).some(f => f.endsWith('.rej'))).toBe(false);
  });

  it('aborts loudly on unexpected version skew', () => {
    const dir = copyWwjs();
    // Break the exact line the Message hunk targets -> that hunk rejects, which
    // is NOT in the expected-reject set -> the patcher must throw rather than
    // ship a partially patched whatsapp-web.js.
    const msgJs = path.join(dir, 'src', 'structures', 'Message.js');
    const src = fs.readFileSync(msgJs, 'utf8').replace('this.id = data.id', 'this.id = DATA_ID_MOVED');
    fs.writeFileSync(msgJs, src);

    expect(() => applyBackport(dir)).toThrow();
  });
});
