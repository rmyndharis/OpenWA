import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendInteractiveCtaDto, SEND_INTERACTIVE_CTA_BODY_EXAMPLES } from './send-interactive-cta.dto';

const validateDto = (cls: new () => object, obj: unknown) =>
  validate(plainToInstance(cls, obj), { whitelist: true, forbidNonWhitelisted: true });

describe('SendInteractiveCtaDto', () => {
  const valid = {
    chatId: '628123456789@c.us',
    body: 'Visit our store today!',
    displayText: 'Open Shop',
    url: 'https://example.com/shop',
  };

  it('accepts valid minimal input', async () => {
    const errors = await validateDto(SendInteractiveCtaDto, valid);
    expect(errors).toHaveLength(0);
  });

  it('accepts valid input with all optional fields', async () => {
    const errors = await validateDto(SendInteractiveCtaDto, {
      ...valid,
      merchantUrl: 'https://merchant.example.com',
      header: 'Special Offer',
      footer: 'Limited time',
      quotedMessageId: 'msg_123',
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects missing chatId', async () => {
    const candidate: Record<string, unknown> = { ...valid };
    delete candidate.chatId;
    const errors = await validateDto(SendInteractiveCtaDto, candidate);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects missing body', async () => {
    const candidate: Record<string, unknown> = { ...valid };
    delete candidate.body;
    const errors = await validateDto(SendInteractiveCtaDto, candidate);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects missing displayText', async () => {
    const candidate: Record<string, unknown> = { ...valid };
    delete candidate.displayText;
    const errors = await validateDto(SendInteractiveCtaDto, candidate);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects missing url', async () => {
    const candidate: Record<string, unknown> = { ...valid };
    delete candidate.url;
    const errors = await validateDto(SendInteractiveCtaDto, candidate);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects invalid url format', async () => {
    const errors = await validateDto(SendInteractiveCtaDto, {
      ...valid,
      url: 'not-a-valid-url',
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects unknown properties when whitelisting is enforced', async () => {
    const errors = await validateDto(SendInteractiveCtaDto, {
      ...valid,
      unexpectedField: 'forbidden',
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  describe('SEND_INTERACTIVE_CTA_BODY_EXAMPLES', () => {
    it('declares at least one example', () => {
      expect(Object.keys(SEND_INTERACTIVE_CTA_BODY_EXAMPLES).length).toBeGreaterThan(0);
    });

    it('examples pass DTO validation', async () => {
      for (const [name, example] of Object.entries(SEND_INTERACTIVE_CTA_BODY_EXAMPLES)) {
        const errors = await validateDto(SendInteractiveCtaDto, example.value);
        expect({ name, errors: errors.map(e => e.property) }).toEqual({ name, errors: [] });
      }
    });

    it('examples carry no quotedMessageId', () => {
      for (const [name, example] of Object.entries(SEND_INTERACTIVE_CTA_BODY_EXAMPLES)) {
        expect({ name, quoted: (example.value as { quotedMessageId?: string }).quotedMessageId }).toEqual({
          name,
          quoted: undefined,
        });
      }
    });
  });
});
