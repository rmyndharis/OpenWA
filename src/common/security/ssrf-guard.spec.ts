import { assertSafeWebhookUrl, isWebhookSsrfProtectionEnabled } from './ssrf-guard';

describe('ssrf-guard', () => {
  const prev = process.env.WEBHOOK_SSRF_PROTECT;
  afterEach(() => {
    if (prev === undefined) delete process.env.WEBHOOK_SSRF_PROTECT;
    else process.env.WEBHOOK_SSRF_PROTECT = prev;
  });

  it('is disabled by default (no-op, allows internal hosts)', async () => {
    delete process.env.WEBHOOK_SSRF_PROTECT;
    expect(isWebhookSsrfProtectionEnabled()).toBe(false);
    await expect(assertSafeWebhookUrl('http://127.0.0.1:8080/hook')).resolves.toBeUndefined();
  });

  describe('when enabled (WEBHOOK_SSRF_PROTECT=true)', () => {
    beforeEach(() => {
      process.env.WEBHOOK_SSRF_PROTECT = 'true';
    });

    it('blocks loopback IP literals', async () => {
      await expect(assertSafeWebhookUrl('http://127.0.0.1/hook')).rejects.toThrow(/internal/);
    });

    it('blocks the cloud metadata address', async () => {
      await expect(assertSafeWebhookUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/internal/);
    });

    it('blocks private RFC1918 ranges', async () => {
      await expect(assertSafeWebhookUrl('http://10.0.0.5/x')).rejects.toThrow(/internal/);
      await expect(assertSafeWebhookUrl('http://192.168.1.10/x')).rejects.toThrow(/internal/);
      await expect(assertSafeWebhookUrl('http://172.16.0.1/x')).rejects.toThrow(/internal/);
    });

    it('blocks IPv6 loopback and IPv4-mapped private', async () => {
      await expect(assertSafeWebhookUrl('http://[::1]/x')).rejects.toThrow(/internal/);
      await expect(assertSafeWebhookUrl('http://[::ffff:127.0.0.1]/x')).rejects.toThrow(/internal/);
    });

    it('blocks non-http(s) schemes', async () => {
      await expect(assertSafeWebhookUrl('file:///etc/passwd')).rejects.toThrow(/scheme/);
      await expect(assertSafeWebhookUrl('gopher://127.0.0.1/x')).rejects.toThrow();
    });

    it('allows a public IP literal', async () => {
      await expect(assertSafeWebhookUrl('https://93.184.216.34/hook')).resolves.toBeUndefined();
    });
  });
});
