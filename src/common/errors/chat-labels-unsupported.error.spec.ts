import { ChatLabelsUnsupportedError } from './chat-labels-unsupported.error';

describe('ChatLabelsUnsupportedError', () => {
  it('carries HTTP 422 so NestJS returns Unprocessable Entity without a custom filter', () => {
    expect(new ChatLabelsUnsupportedError().getStatus()).toBe(422);
  });

  it('defaults to the Business-account message and accepts an override', () => {
    expect(new ChatLabelsUnsupportedError().message).toContain('WhatsApp Business account');
    expect(new ChatLabelsUnsupportedError('Channels do not support chat labels.').message).toContain('Channels');
  });
});
