import { deriveToolTitle } from './tool-title';

describe('deriveToolTitle', () => {
  it('splits a PascalCase name into words, sentence case', () => {
    expect(deriveToolTitle('MessageSendText')).toBe('Message send text');
    expect(deriveToolTitle('SessionFindAll')).toBe('Session find all');
    expect(deriveToolTitle('ContactGetProfilePicture')).toBe('Contact get profile picture');
  });

  it('keeps a run of capitals together', () => {
    expect(deriveToolTitle('SessionGetQRCode')).toBe('Session get QR code');
    expect(deriveToolTitle('WebhookURLList')).toBe('Webhook URL list');
  });

  it('handles a one-word name, digits and an empty name', () => {
    expect(deriveToolTitle('Ping')).toBe('Ping');
    expect(deriveToolTitle('Group2Fa')).toBe('Group2 fa');
    expect(deriveToolTitle('')).toBe('');
  });
});
