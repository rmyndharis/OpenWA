import { postWebhookPayload } from './deliver-once';
import { redactSsrfError } from '../../../common/security/ssrf-guard';

// A webhook row can carry a URL with credentials (a row made before the create-time refusal, or restored from an
// archive): the delivery fails, and the text it leaves in the failure row must not repeat them.
describe('postWebhookPayload: a URL with credentials', () => {
  it('fails with a text that does not repeat the credentials', async () => {
    const error = await postWebhookPayload('https://ops:s3cr3t-token@93.184.216.34/hook', '{}', {}, 1000).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    const text = redactSsrfError(error);
    expect(text).toBe('URL must not contain credentials (userinfo)');
    expect(text).not.toContain('s3cr3t-token');
  });
});
