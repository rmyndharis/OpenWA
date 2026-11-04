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

  // One entry per validate call: any single bad entry fails the whole array, so a combined list
  // would still fail if one of the others (a group JID, say) were wrongly accepted.
  it.each(['not-a-jid', '123@g.us', '@c.us', 'abc@lid'])('rejects the malformed JID %s', async jid => {
    const errors = await validate(plainToInstance(SendTextStatusDto, { text: 'hi', recipients: [jid] }));
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('accepts @lid recipients', async () => {
    const errors = await validate(plainToInstance(SendTextStatusDto, { text: 'hi', recipients: ['6281@lid'] }));
    expect(errors).toHaveLength(0);
  });
});

describe('SendTextStatusDto text validation', () => {
  it('rejects an empty or whitespace-only body', async () => {
    for (const text of ['', '   ', '\n\t']) {
      const errors = await validate(plainToInstance(SendTextStatusDto, { text }));
      expect(errors.some(e => e.property === 'text')).toBe(true);
    }
  });

  it('accepts a body with surrounding whitespace', async () => {
    expect(await validate(plainToInstance(SendTextStatusDto, { text: '  hi  ' }))).toHaveLength(0);
  });

  // docs/06: text is at most 4096 characters.
  it('accepts exactly 4096 characters and rejects 4097', async () => {
    const failing = async (text: string): Promise<string[]> =>
      (await validate(plainToInstance(SendTextStatusDto, { text }))).map(e => e.property);

    expect(await failing('x'.repeat(4096))).toEqual([]);
    expect(await failing('x'.repeat(4097))).toEqual(['text']);
  });
});

// docs/06: backgroundColor is a 6-digit hex colour matching ^#[0-9A-Fa-f]{6}$. A short form, a missing
// hash or a non-hex digit is refused rather than handed to the engine to draw as it sees fit.
describe('SendTextStatusDto backgroundColor validation', () => {
  const failing = async (backgroundColor: string): Promise<string[]> =>
    (await validate(plainToInstance(SendTextStatusDto, { text: 'hi', backgroundColor }))).map(e => e.property);

  it.each(['#25D366', '#25d366', '#000000', '#FFFFFF'])('accepts %s', async color => {
    expect(await failing(color)).toEqual([]);
  });

  it.each([
    ['the 3-digit short form', '#abc'],
    ['5 digits', '#25D36'],
    ['7 digits', '#25D3666'],
    ['no hash', '25D366'],
    ['a non-hex digit', '#25D36G'],
    ['trailing whitespace', '#25D366 '],
    ['an empty string', ''],
  ])('rejects %s', async (_label, color) => {
    expect(await failing(color)).toEqual(['backgroundColor']);
  });
});
