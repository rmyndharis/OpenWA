import { PayloadTooLargeException } from '@nestjs/common';
import { assertBase64WithinMediaCap } from './media-cap.util';

describe('assertBase64WithinMediaCap', () => {
  const orig = process.env.MEDIA_DOWNLOAD_MAX_BYTES;
  afterEach(() => {
    if (orig === undefined) delete process.env.MEDIA_DOWNLOAD_MAX_BYTES;
    else process.env.MEDIA_DOWNLOAD_MAX_BYTES = orig;
  });

  /** A base64 string that decodes to exactly `bytes` bytes. */
  const base64OfBytes = (bytes: number): string => Buffer.alloc(bytes).toString('base64');

  it('does nothing for an empty or missing value', () => {
    expect(() => assertBase64WithinMediaCap(undefined)).not.toThrow();
    expect(() => assertBase64WithinMediaCap(null)).not.toThrow();
    expect(() => assertBase64WithinMediaCap('')).not.toThrow();
  });

  it('accepts a base64 payload at the cap', () => {
    process.env.MEDIA_DOWNLOAD_MAX_BYTES = '1024';
    expect(() => assertBase64WithinMediaCap(base64OfBytes(1024))).not.toThrow();
  });

  it('rejects a base64 payload over the cap with a 400', () => {
    process.env.MEDIA_DOWNLOAD_MAX_BYTES = '1024';
    expect(() => assertBase64WithinMediaCap(base64OfBytes(1025))).toThrow(PayloadTooLargeException);
  });

  it('honors the MEDIA_DOWNLOAD_MAX_BYTES override (shared with the URL/inbound caps)', () => {
    process.env.MEDIA_DOWNLOAD_MAX_BYTES = '2048';
    expect(() => assertBase64WithinMediaCap(base64OfBytes(2000))).not.toThrow();
    expect(() => assertBase64WithinMediaCap(base64OfBytes(4096))).toThrow(PayloadTooLargeException);
  });
});
