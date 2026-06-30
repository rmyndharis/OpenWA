import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendTextMessageDto, SendMediaMessageDto } from './send-message.dto';

// Mirror the global ValidationPipe (main.ts): whitelist + forbidNonWhitelisted strip/reject unknown props.
const validateDto = (cls: new () => object, obj: unknown) =>
  validate(plainToInstance(cls, obj), { whitelist: true, forbidNonWhitelisted: true });

describe('SendTextMessageDto mentions', () => {
  it('accepts an optional array of mention WIDs', async () => {
    const errors = await validateDto(SendTextMessageDto, {
      chatId: 'g@g.us',
      text: 'hi @62811',
      mentions: ['62811@c.us'],
    });
    expect(errors).toHaveLength(0);
  });

  it('is omittable (mentions stays optional)', async () => {
    const errors = await validateDto(SendTextMessageDto, { chatId: 'g@g.us', text: 'hi' });
    expect(errors).toHaveLength(0);
  });

  it('rejects a non-string element in mentions', async () => {
    const errors = await validateDto(SendTextMessageDto, {
      chatId: 'g@g.us',
      text: 'hi',
      mentions: [123],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an oversized mentions array (> 1024 entries)', async () => {
    const errors = await validateDto(SendTextMessageDto, {
      chatId: 'g@g.us',
      text: 'hi',
      mentions: Array.from({ length: 1025 }, (_, i) => `${i}@c.us`),
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a mention WID longer than the per-element cap', async () => {
    const errors = await validateDto(SendTextMessageDto, {
      chatId: 'g@g.us',
      text: 'hi',
      mentions: ['a'.repeat(65) + '@c.us'],
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('SendMediaMessageDto mentions', () => {
  it('accepts an optional array of mention WIDs', async () => {
    const errors = await validateDto(SendMediaMessageDto, {
      chatId: 'g@g.us',
      url: 'https://example.com/a.jpg',
      caption: 'look @62811',
      mentions: ['62811@c.us'],
    });
    expect(errors).toHaveLength(0);
  });
});
