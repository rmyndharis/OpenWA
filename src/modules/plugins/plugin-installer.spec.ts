import AdmZip from 'adm-zip';
import { BadRequestException } from '@nestjs/common';
import { parsePluginPackage } from './plugin-installer';

const validManifest = { id: 'my-plg', name: 'My Plugin', version: '1.0.0', type: 'extension', main: 'index.js' };

function zipOf(files: Record<string, string>): Buffer {
  const z = new AdmZip();
  for (const [name, content] of Object.entries(files)) z.addFile(name, Buffer.from(content));
  return z.toBuffer();
}

/**
 * Build a valid plugin zip, then corrupt one entry's compressed bytes so `getData()` throws a
 * decompression/CRC error (BAD_CRC / zlib invalid-code) — simulating a truncated or damaged archive.
 */
function zipWithCorruptEntry(target: string): Buffer {
  const z = new AdmZip();
  z.addFile('manifest.json', Buffer.from(JSON.stringify(validManifest)));
  z.addFile('index.js', Buffer.from('module.exports=class{}'));
  z.addFile(target, Buffer.from('A'.repeat(100)));
  const buf = Buffer.from(z.toBuffer()); // writable copy
  const locsig = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04 local file header signature
  let off = buf.indexOf(locsig);
  while (off !== -1) {
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 30, off + 30 + nameLen).toString();
    const dataStart = off + 30 + nameLen + extraLen;
    if (name === target) {
      buf[dataStart] ^= 0xff; // flip the first compressed byte → bad CRC / invalid deflate stream
      break;
    }
    off = buf.indexOf(locsig, off + 1);
  }
  return buf;
}

/**
 * Build a plugin zip whose `target` entry declares uncompressed size = 0 in BOTH the central
 * directory and the local header, while the entry still carries real (deflated) content. adm-zip
 * only sets zlib `maxOutputLength` when the declared size is > 0, so without a bound this entry
 * inflates with no cap — the zip-bomb residual gap (a lying-header entry).
 */
function zipWithLyingZeroSizeEntries(targets: Record<string, string>): Buffer {
  const z = new AdmZip();
  z.addFile('manifest.json', Buffer.from(JSON.stringify(validManifest)));
  z.addFile('index.js', Buffer.from('module.exports=class{}'));
  for (const [name, content] of Object.entries(targets)) z.addFile(name, Buffer.from(content));
  const buf = Buffer.from(z.toBuffer()); // writable copy
  const censig = Buffer.from([0x50, 0x4b, 0x01, 0x02]); // PK\x01\x02 central directory header signature
  let off = buf.indexOf(censig);
  while (off !== -1) {
    const nameLen = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString();
    if (name in targets) {
      const locoff = buf.readUInt32LE(off + 42); // CENOFF — local header offset
      buf.writeUInt32LE(0, off + 24); // CENLEN = 0 (declared uncompressed size, central)
      buf.writeUInt32LE(0, locoff + 22); // LOCLEN = 0 (declared uncompressed size, local)
    }
    off = buf.indexOf(censig, off + 1);
  }
  return buf;
}

function zipWithLyingZeroSizeEntry(target: string, content: string): Buffer {
  return zipWithLyingZeroSizeEntries({ [target]: content });
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

  it('rejects a corrupt entry with a clean 400, not an uncaught decompression error / 500', () => {
    // A truncated/damaged entry throws BAD_CRC / a zlib error from getData(); without the try/catch
    // that escapes as an HTTP 500. It must surface as a BadRequestException (clean 400).
    const buf = zipWithCorruptEntry('data.bin');
    expect(() => parsePluginPackage(buf)).toThrow(BadRequestException);
    expect(() => parsePluginPackage(buf)).toThrow(/corrupt or too large/i);
  });

  it('rejects a lying size=0 entry whose actual content exceeds the cap (no unbounded inflation)', () => {
    // adm-zip skips zlib `maxOutputLength` when declared size is 0, so this entry would inflate with
    // NO cap. The declared aggregate (0 + tiny manifest + index) passes the pre-check; only the
    // actual-bytes bound stops the lying entry. Actual content (500B) exceeds the per-entry cap (200B)
    // → ERR_BUFFER_TOO_LARGE → BadRequestException.
    const buf = zipWithLyingZeroSizeEntry('big.bin', 'A'.repeat(500));
    expect(() => parsePluginPackage(buf, { maxEntries: 100, maxTotalBytes: 200 })).toThrow(BadRequestException);
    expect(() => parsePluginPackage(buf, { maxEntries: 100, maxTotalBytes: 200 })).toThrow(/corrupt or too large/i);
  });

  it('rejects many lying size=0 entries whose aggregate exceeds the cap (multi-entry zip bomb)', () => {
    // Each lying entry is individually under the per-entry cap (150B < 300B), and the declared sum
    // is tiny (lying sizes are 0 + manifest + index), so both the declared pre-check and the per-entry
    // bound pass. Without the running actual-bytes counter, these accumulate unbounded in `entries`
    // before the function returns → OOM. The aggregate bound aborts as soon as the running total
    // crosses the cap.
    const buf = zipWithLyingZeroSizeEntries({
      'big1.bin': 'A'.repeat(150),
      'big2.bin': 'A'.repeat(150),
      'big3.bin': 'A'.repeat(150),
    });
    expect(() => parsePluginPackage(buf, { maxEntries: 100, maxTotalBytes: 300 })).toThrow(BadRequestException);
    expect(() => parsePluginPackage(buf, { maxEntries: 100, maxTotalBytes: 300 })).toThrow(/too large/i);
  });

  it('happy path unchanged: a normal small plugin installs identically (no regression)', () => {
    const buf = zipOf({
      'manifest.json': JSON.stringify(validManifest),
      'index.js': 'module.exports=class{}',
      'extra.txt': 'some extra bytes',
    });
    const out = parsePluginPackage(buf);
    expect(out.manifest.id).toBe('my-plg');
    expect(out.entries.map(e => e.relPath).sort()).toEqual(['extra.txt', 'index.js', 'manifest.json']);
    expect(out.entries.find(e => e.relPath === 'extra.txt')?.data.toString()).toBe('some extra bytes');
  });
});
