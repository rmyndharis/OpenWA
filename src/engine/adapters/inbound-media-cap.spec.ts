import { capInboundMedia, inboundMediaMaxBytes } from './inbound-media-cap';

describe('inbound media cap', () => {
  const ENV = 'MEDIA_DOWNLOAD_MAX_BYTES';
  const orig = process.env[ENV];
  afterEach(() => {
    if (orig === undefined) delete process.env[ENV];
    else process.env[ENV] = orig;
  });

  describe('inboundMediaMaxBytes', () => {
    it('defaults to 50 MiB', () => {
      delete process.env[ENV];
      expect(inboundMediaMaxBytes()).toBe(50 * 1024 * 1024);
    });
    it('honors a positive override', () => {
      process.env[ENV] = '1024';
      expect(inboundMediaMaxBytes()).toBe(1024);
    });
    it('falls back to the default for a non-positive/garbage override', () => {
      process.env[ENV] = '0';
      expect(inboundMediaMaxBytes()).toBe(50 * 1024 * 1024);
      process.env[ENV] = 'abc';
      expect(inboundMediaMaxBytes()).toBe(50 * 1024 * 1024);
    });
  });

  describe('capInboundMedia', () => {
    it('keeps media within the cap, encoding base64 exactly once', () => {
      const toBase64 = jest.fn(() => 'BASE64DATA');
      const res = capInboundMedia({
        mimetype: 'image/png',
        filename: 'p.png',
        sizeBytes: 1000,
        toBase64,
        maxBytes: 5000,
      });
      expect(res).toEqual({ mimetype: 'image/png', filename: 'p.png', data: 'BASE64DATA' });
      expect(toBase64).toHaveBeenCalledTimes(1);
    });

    it('drops over-cap media WITHOUT encoding it — marker only, no base64 (the RAM fix)', () => {
      const toBase64 = jest.fn(() => 'SHOULD-NOT-BE-CALLED');
      const res = capInboundMedia({
        mimetype: 'video/mp4',
        filename: 'v.mp4',
        sizeBytes: 99_999,
        toBase64,
        maxBytes: 5000,
      });
      expect(res).toEqual({ mimetype: 'video/mp4', filename: 'v.mp4', omitted: true, sizeBytes: 99_999 });
      expect(res.data).toBeUndefined();
      expect(toBase64).not.toHaveBeenCalled();
    });

    it('treats exactly-at-the-cap as within the limit', () => {
      const res = capInboundMedia({ mimetype: 'image/jpeg', sizeBytes: 5000, toBase64: () => 'D', maxBytes: 5000 });
      expect(res.data).toBe('D');
      expect(res.omitted).toBeUndefined();
    });
  });
});
