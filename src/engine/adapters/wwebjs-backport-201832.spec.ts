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
  const tmpDirs: string[] = [];

  function copyWwjs(): string {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-backport-'));
    tmpDirs.push(tmp);
    const copy = path.join(tmp, 'whatsapp-web.js');
    fs.cpSync(WWJS_SRC, copy, { recursive: true });
    return copy;
  }

  afterAll(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('self-removes (no-ops) once the installed dep normalizes ids itself', () => {
    const dir = copyWwjs();
    const msgJs = path.join(dir, 'src', 'structures', 'Message.js');
    fs.writeFileSync(
      msgJs,
      fs.readFileSync(msgJs, 'utf8').replace('this.id = data.id', 'this.id = Base._normalizeId(data.id)'),
    );

    const res = applyBackport(dir);

    expect(res.skipped).toBe(true);
    // Chat.js is left untouched — proof the patcher stood down rather than re-applying.
    expect(fs.readFileSync(path.join(dir, 'src', 'structures', 'Chat.js'), 'utf8')).toContain('this.id = data.id');
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
});
