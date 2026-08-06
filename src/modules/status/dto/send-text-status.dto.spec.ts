import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendTextStatusDto } from './send-text-status.dto';

describe('SendTextStatusDto font validation (WhatsApp font enum)', () => {
  const withFont = (font: unknown) => ({ text: 'hi', font });

  it('accepts every value in the wire enum (0, 1, 2, 6–10)', async () => {
    for (const font of [0, 1, 2, 6, 7, 8, 9, 10]) {
      const errors = await validate(plainToInstance(SendTextStatusDto, withFont(font)));
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects values outside the wire enum (3–5 no longer exist on it, 11+, negatives)', async () => {
    for (const font of [3, 4, 5, 11, -1]) {
      const errors = await validate(plainToInstance(SendTextStatusDto, withFont(font)));
      expect(errors.some(e => e.property === 'font')).toBe(true);
    }
  });
});

describe('SendTextStatusDto recipients validation', () => {
  const valid = { text: 'hi', recipients: ['6281@c.us'] };

  it('accepts a non-empty recipients array', async () => {
    const errors = await validate(plainToInstance(SendTextStatusDto, valid));
    expect(errors).toHaveLength(0);
  });

  it('accepts missing recipients (optional — whatsapp-web.js broadcasts without them)', async () => {
    const errors = await validate(plainToInstance(SendTextStatusDto, { text: 'hi' }));
    expect(errors).toHaveLength(0);
  });

  it('accepts an empty recipients array', async () => {
    const errors = await validate(plainToInstance(SendTextStatusDto, { text: 'hi', recipients: [] }));
    expect(errors).toHaveLength(0);
  });

  it('rejects non-string entries', async () => {
    const errors = await validate(plainToInstance(SendTextStatusDto, { text: 'hi', recipients: [123] }));
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('rejects more than 256 recipients', async () => {
    const recipients = Array.from({ length: 257 }, (_, i) => `${i}@c.us`);
    const errors = await validate(plainToInstance(SendTextStatusDto, { text: 'hi', recipients }));
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('accepts exactly 256 recipients', async () => {
    const recipients = Array.from({ length: 256 }, (_, i) => `${i}@c.us`);
    const errors = await validate(plainToInstance(SendTextStatusDto, { text: 'hi', recipients }));
    expect(errors).toHaveLength(0);
  });

  it('rejects malformed JIDs', async () => {
    const errors = await validate(
      plainToInstance(SendTextStatusDto, { text: 'hi', recipients: ['not-a-jid', '123@g.us', '@c.us', 'abc@lid'] }),
    );
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('accepts @lid recipients', async () => {
    const errors = await validate(plainToInstance(SendTextStatusDto, { text: 'hi', recipients: ['6281@lid'] }));
    expect(errors).toHaveLength(0);
  });
});
