import AdmZip from 'adm-zip';
import { parsePluginPackage } from './plugin-installer';

const validManifest = { id: 'my-plg', name: 'My Plugin', version: '1.0.0', type: 'extension', main: 'index.js' };

function zipOf(files: Record<string, string>): Buffer {
  const z = new AdmZip();
  for (const [name, content] of Object.entries(files)) z.addFile(name, Buffer.from(content));
  return z.toBuffer();
}

describe('parsePluginPackage', () => {
  it('parses a flat package (manifest + files at the root)', () => {
    const out = parsePluginPackage(
      zipOf({ 'manifest.json': JSON.stringify(validManifest), 'index.js': 'module.exports=class{}' }),
    );
    expect(out.manifest.id).toBe('my-plg');
    expect(out.entries.map(e => e.relPath).sort()).toEqual(['index.js', 'manifest.json']);
  });

  it('strips a single wrapping folder (a zipped plugin directory)', () => {
    const out = parsePluginPackage(
      zipOf({ 'my-plg/manifest.json': JSON.stringify(validManifest), 'my-plg/index.js': 'x' }),
    );
    expect(out.entries.map(e => e.relPath).sort()).toEqual(['index.js', 'manifest.json']);
  });

  it('ignores cruft outside the package root (e.g. __MACOSX)', () => {
    const out = parsePluginPackage(
      zipOf({ 'my-plg/manifest.json': JSON.stringify(validManifest), 'my-plg/index.js': 'x', '__MACOSX/._x': 'junk' }),
    );
    expect(out.entries.map(e => e.relPath).sort()).toEqual(['index.js', 'manifest.json']);
  });

  it('rejects an archive with no manifest.json', () => {
    expect(() => parsePluginPackage(zipOf({ 'index.js': 'x' }))).toThrow(/no manifest/i);
  });

  it('rejects a manifest missing a required field', () => {
    const bad = { ...validManifest, main: undefined };
    expect(() => parsePluginPackage(zipOf({ 'manifest.json': JSON.stringify(bad), 'index.js': 'x' }))).toThrow(
      /required field: main/i,
    );
  });

  it('rejects a non-string required field (numeric main) with a clean 400, not a TypeError/500', () => {
    // A non-string `main` is truthy, so a bare falsy check would pass it through and then crash
    // path.posix.normalize with an uncaught TypeError (HTTP 500). It must be rejected as a 400.
    const bad = { ...validManifest, main: 123 };
    expect(() => parsePluginPackage(zipOf({ 'manifest.json': JSON.stringify(bad), 'index.js': 'x' }))).toThrow(
      /invalid required field/i,
    );
  });

  it('rejects a non-object manifest (null / array / scalar) with a 400, not a TypeError/500', () => {
    // JSON.parse("null") is null (no throw); accessing manifest['id'] on it then throws an uncaught
    // TypeError (HTTP 500). null, an array, and a bare scalar must all be rejected as a clean 400.
    for (const body of ['null', '[]', '"x"', '5', 'true']) {
      expect(() => parsePluginPackage(zipOf({ 'manifest.json': body, 'index.js': 'x' }))).toThrow(
        /must be a JSON object/i,
      );
    }
  });

  it('rejects an unsafe plugin id', () => {
    const bad = { ...validManifest, id: '../evil' };
    expect(() => parsePluginPackage(zipOf({ 'manifest.json': JSON.stringify(bad), 'index.js': 'x' }))).toThrow(
      /invalid plugin id/i,
    );
  });

  it('rejects an id reserved by a built-in', () => {
    const bad = { ...validManifest, id: 'baileys' };
    expect(() => parsePluginPackage(zipOf({ 'manifest.json': JSON.stringify(bad), 'index.js': 'x' }))).toThrow(
      /reserved/i,
    );
  });

  it('rejects a case-variant of a reserved id (the id check is case-insensitive)', () => {
    // SAFE_ID accepts mixed case, so a case-variant must still hit the reservation — else `Auto-Reply`
    // installs as a distinct plugin that shadows the reserved `auto-reply`.
    const bad = { ...validManifest, id: 'Auto-Reply' };
    expect(() => parsePluginPackage(zipOf({ 'manifest.json': JSON.stringify(bad), 'index.js': 'x' }))).toThrow(
      /reserved/i,
    );
  });

  it('rejects an engine-type package (engines are built-in, not user-installable)', () => {
    const bad = { ...validManifest, id: 'my-engine', type: 'engine' };
    expect(() => parsePluginPackage(zipOf({ 'manifest.json': JSON.stringify(bad), 'index.js': 'x' }))).toThrow(
      /extension/i,
    );
  });

  it('rejects an unknown plugin type', () => {
    const bad = { ...validManifest, type: 'wormhole' };
    expect(() => parsePluginPackage(zipOf({ 'manifest.json': JSON.stringify(bad), 'index.js': 'x' }))).toThrow(/type/i);
  });

  it('rejects a zip-slip path escaping the package root', () => {
    // adm-zip sanitizes names on add, so forge the malicious entry name directly to simulate a
    // hand-crafted archive.
    const z = new AdmZip();
    z.addFile('manifest.json', Buffer.from(JSON.stringify(validManifest)));
    z.addFile('index.js', Buffer.from('x'));
    z.addFile('evil.js', Buffer.from('pwned'));
    z.getEntries().find(e => e.entryName === 'evil.js')!.entryName = '../evil.js';
    expect(() => parsePluginPackage(z.toBuffer())).toThrow(/unsafe path/i);
  });

  it('rejects a package missing its declared main file', () => {
    const buf = zipOf({ 'manifest.json': JSON.stringify(validManifest), 'other.js': 'x' });
    expect(() => parsePluginPackage(buf)).toThrow(/missing its main file/i);
  });

  it('rejects too many files', () => {
    const files: Record<string, string> = { 'manifest.json': JSON.stringify(validManifest), 'index.js': 'x' };
    for (let i = 0; i < 5; i++) files[`f${i}.txt`] = 'x';
    expect(() => parsePluginPackage(zipOf(files), { maxEntries: 3, maxTotalBytes: 1e9 })).toThrow(/too many/i);
  });

  it('rejects an archive that exceeds the size limit (before decompressing)', () => {
    const buf = zipOf({ 'manifest.json': JSON.stringify(validManifest), 'index.js': 'a'.repeat(100) });
    expect(() => parsePluginPackage(buf, { maxEntries: 100, maxTotalBytes: 10 })).toThrow(/size limit/i);
  });
});
