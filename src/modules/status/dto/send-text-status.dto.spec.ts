import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendTextStatusDto } from './send-text-status.dto';

describe('SendTextStatusDto recipients validation', () => {
  const valid = { text: 'hi', recipients: ['6281@c.us'] };

  it('accepts a non-empty recipients array', async () => {
    const errors = await validate(plainToInstance(SendTextStatusDto, valid));
    expect(errors).toHaveLength(0);
  });

  it('rejects missing recipients', async () => {
    const errors = await validate(plainToInstance(SendTextStatusDto, { text: 'hi' }));
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('rejects an empty recipients array (-> 400)', async () => {
    const errors = await validate(plainToInstance(SendTextStatusDto, { text: 'hi', recipients: [] }));
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
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
