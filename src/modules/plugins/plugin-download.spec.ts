import { expectedSha256FromUrl, assertDownloadSha256 } from './plugin-download';
import { createHash } from 'crypto';

/**
 * Optional content integrity for plugin downloads: the expected sha256 travels IN the URL
 * (`#sha256=` fragment — never sent to the server — or a `?sha256=`/`?checksum=` query param), and
 * verification is fail-closed whenever a marker is present.
 */
describe('expectedSha256FromUrl', () => {
  const digest = 'a'.repeat(64);

  it('extracts the digest from a #sha256= fragment (case-insensitive hex)', () => {
    expect(expectedSha256FromUrl(`https://h/pkg.zip#sha256=${digest}`)).toBe(digest);
    expect(expectedSha256FromUrl(`https://h/pkg.zip#sha256=${digest.toUpperCase()}`)).toBe(digest);
  });

  it('extracts the digest from ?sha256= / ?checksum= query params', () => {
    expect(expectedSha256FromUrl(`https://h/pkg.zip?sha256=${digest}`)).toBe(digest);
    expect(expectedSha256FromUrl(`https://h/pkg.zip?checksum=${digest}`)).toBe(digest);
  });

  it('returns null when the URL carries no integrity marker', () => {
    expect(expectedSha256FromUrl('https://h/pkg.zip')).toBeNull();
    expect(expectedSha256FromUrl('https://h/pkg.zip#download')).toBeNull();
    expect(expectedSha256FromUrl('not a url')).toBeNull(); // downstream URL validation rejects it
  });

  it('fails closed on a malformed marker', () => {
    expect(() => expectedSha256FromUrl('https://h/pkg.zip#sha256=xyz')).toThrow(/64-character hex/i);
    expect(() => expectedSha256FromUrl(`https://h/pkg.zip?sha256=${'a'.repeat(63)}`)).toThrow(/64-character hex/i);
  });

  it('fails closed when fragment and query disagree', () => {
    expect(() => expectedSha256FromUrl(`https://h/pkg.zip?sha256=${digest}#sha256=${'b'.repeat(64)}`)).toThrow(
      /conflicting/i,
    );
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
