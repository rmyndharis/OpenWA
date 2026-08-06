import { expectedSha256FromUrl, assertDownloadSha256 } from './plugin-download';
import { createHash } from 'crypto';

/**
 * Optional content integrity for plugin downloads: the expected sha256 travels IN the URL as a
 * `#sha256=` fragment (never sent to the server), and verification is fail-closed whenever the
 * marker is present. Query params — even ones named `sha256`/`checksum` — are NOT markers: they
 * are sent to the server and may belong to the download host's own contract.
 */
describe('expectedSha256FromUrl', () => {
  const digest = 'a'.repeat(64);

  it('extracts the digest from a #sha256= fragment (case-insensitive hex)', () => {
    expect(expectedSha256FromUrl(`https://h/pkg.zip#sha256=${digest}`)).toBe(digest);
    expect(expectedSha256FromUrl(`https://h/pkg.zip#sha256=${digest.toUpperCase()}`)).toBe(digest);
  });

  it('does not seize ?sha256= / ?checksum= query params — they belong to the host, not to OpenWA', () => {
    expect(expectedSha256FromUrl(`https://h/pkg.zip?sha256=${digest}`)).toBeNull();
    expect(expectedSha256FromUrl(`https://h/pkg.zip?checksum=${digest}`)).toBeNull();
    // A host-side checksum param in its own (non-sha256-hex) format must not fail the download.
    expect(expectedSha256FromUrl('https://h/pkg.zip?checksum=1a2b3c4d&dl=1')).toBeNull();
  });

  it('returns null when the URL carries no integrity marker', () => {
    expect(expectedSha256FromUrl('https://h/pkg.zip')).toBeNull();
    expect(expectedSha256FromUrl('https://h/pkg.zip#download')).toBeNull();
    expect(expectedSha256FromUrl('not a url')).toBeNull(); // downstream URL validation rejects it
  });

  it('fails closed on a malformed marker', () => {
    expect(() => expectedSha256FromUrl('https://h/pkg.zip#sha256=xyz')).toThrow(/64-character hex/i);
    expect(() => expectedSha256FromUrl(`https://h/pkg.zip#sha256=${'a'.repeat(63)}`)).toThrow(/64-character hex/i);
  });

  it('honors the fragment alongside unrelated query params (the params are simply ignored)', () => {
    expect(expectedSha256FromUrl(`https://h/pkg.zip?checksum=1a2b3c#sha256=${digest}`)).toBe(digest);
    expect(expectedSha256FromUrl(`https://h/pkg.zip?sha256=${'b'.repeat(64)}#sha256=${digest}`)).toBe(digest);
  });
});

describe('assertDownloadSha256', () => {
  const body = Buffer.from('plugin zip bytes');
  const digest = createHash('sha256').update(body).digest('hex');

  it('is a no-op when the URL carries no integrity marker', () => {
    expect(() => assertDownloadSha256('https://h/pkg.zip', body)).not.toThrow();
  });

  it('passes when the digest matches the downloaded bytes', () => {
    expect(() => assertDownloadSha256(`https://h/pkg.zip#sha256=${digest}`, body)).not.toThrow();
  });

  it('throws when the digest does not match (substituted package)', () => {
    expect(() => assertDownloadSha256(`https://h/pkg.zip#sha256=${'0'.repeat(64)}`, body)).toThrow(/sha256 mismatch/i);
  });
});
