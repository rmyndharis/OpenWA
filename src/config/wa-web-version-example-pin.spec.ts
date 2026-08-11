import * as fs from 'fs';
import * as path from 'path';

/**
 * Operator-facing guidance must not hand out a literal WhatsApp Web build to copy into
 * `WWEBJS_WEB_VERSION`.
 *
 * The wa-version registry withdraws old builds, and whatsapp-web.js's remote cache is non-strict:
 * a pin whose HTML it can no longer fetch is missed and silently ignored, leaving the operator on
 * the default behaviour while `Pinning WhatsApp Web version …` still claims the pin was applied.
 * `2.3000.1040641150-alpha` shipped in both `.env.example` and the troubleshooting FAQ and was
 * withdrawn; nothing failed anywhere, which is exactly why it went unnoticed. Describing the
 * setting and pointing at the registry's `html/` folder is fine — naming a build is not.
 *
 * Scope is deliberately operator-facing only. A spec assigning `process.env.WWEBJS_WEB_VERSION` a
 * build id is a fixture, not guidance, and the CHANGELOG legitimately records builds that were
 * current when an entry was written.
 */

const REPO_ROOT = path.join(__dirname, '..', '..');

/** `WWEBJS_WEB_VERSION` assigned something starting with a digit — how the resolver reads an exact build. */
const LITERAL_BUILD_PIN = /WWEBJS_WEB_VERSION\s*=\s*["']?\d/;

const SETTING = 'WWEBJS_WEB_VERSION';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function markdownUnder(dir: string): string[] {
  return fs
    .readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })
    .flatMap(entry =>
      entry.isDirectory()
        ? markdownUnder(path.join(dir, entry.name))
        : entry.name.endsWith('.md')
          ? [path.join(dir, entry.name)]
          : [],
    );
}

/** Everything an operator is expected to copy from. */
function operatorFacingFiles(): string[] {
  return ['.env.example', ...markdownUnder('docs')];
}

function filesNamingABuild(files: string[]): string[] {
  return files.filter(relativePath => LITERAL_BUILD_PIN.test(read(relativePath)));
}

describe('operator-facing guidance never names a WhatsApp Web build to pin', () => {
  const files = operatorFacingFiles();

  it('names no build anywhere an operator copies from', () => {
    expect(filesNamingABuild(files)).toEqual([]);
  });

  // Anti-vacuity: a corpus that lost the files, or a setting that was renamed out from under the
  // pattern, would make the assertion above pass while checking nothing.
  it('scans a corpus that still documents the setting', () => {
    const documenting = files.filter(relativePath => read(relativePath).includes(SETTING));
    expect(documenting).toContain('.env.example');
    expect(documenting).toContain(path.join('docs', '12-troubleshooting-faq.md'));
  });

  // Self-mutation control: the check must be capable of firing.
  it('fires on a document that names a build', () => {
    expect(LITERAL_BUILD_PIN.test('WWEBJS_WEB_VERSION=2.3000.1040641150-alpha')).toBe(true);
    expect(LITERAL_BUILD_PIN.test('WWEBJS_WEB_VERSION = "2.3000.1040641150-alpha"')).toBe(true);
  });

  it('does not fire on the forms that are safe to document', () => {
    expect(LITERAL_BUILD_PIN.test('WWEBJS_WEB_VERSION=off')).toBe(false);
    expect(LITERAL_BUILD_PIN.test('WWEBJS_WEB_VERSION=auto')).toBe(false);
    expect(LITERAL_BUILD_PIN.test("WWEBJS_WEB_VERSION=<a build from that registry's html/ folder>")).toBe(false);
  });
});
