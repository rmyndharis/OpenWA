import {
  capInboundMedia,
  inboundMediaMaxBytes,
  inboundMediaConcurrency,
  coerceDeclaredSize,
} from './inbound-media-cap';

describe('inbound media cap', () => {
  const ENV = 'MEDIA_DOWNLOAD_MAX_BYTES';
  const CONC = 'INBOUND_MEDIA_CONCURRENCY';
  const orig = process.env[ENV];
  const origConc = process.env[CONC];
  afterEach(() => {
    if (orig === undefined) delete process.env[ENV];
    else process.env[ENV] = orig;
    if (origConc === undefined) delete process.env[CONC];
    else process.env[CONC] = origConc;
  });

  describe('inboundMediaConcurrency', () => {
    it('defaults to 4', () => {
      delete process.env[CONC];
      expect(inboundMediaConcurrency()).toBe(4);
    });
    it('honors a positive override', () => {
      process.env[CONC] = '2';
      expect(inboundMediaConcurrency()).toBe(2);
    });
    it('falls back to the default for a non-positive/garbage override', () => {
      process.env[CONC] = '0';
      expect(inboundMediaConcurrency()).toBe(4);
      process.env[CONC] = 'abc';
      expect(inboundMediaConcurrency()).toBe(4);
    });
  });

  describe('coerceDeclaredSize', () => {
    it('passes a finite number through', () => {
      expect(coerceDeclaredSize(1234)).toBe(1234);
    });
    it('reads a Long-like { toNumber() }', () => {
      expect(coerceDeclaredSize({ toNumber: () => 5000 })).toBe(5000);
    });
    it('parses a numeric string', () => {
      expect(coerceDeclaredSize('4096')).toBe(4096);
    });
    it("returns 0 for absent/garbage (never NaN — don't pre-gate on unknown)", () => {
      expect(coerceDeclaredSize(undefined)).toBe(0);
      expect(coerceDeclaredSize(null)).toBe(0);
      expect(coerceDeclaredSize('xyz')).toBe(0);
      expect(coerceDeclaredSize(NaN)).toBe(0);
      expect(coerceDeclaredSize({})).toBe(0);
    });
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
