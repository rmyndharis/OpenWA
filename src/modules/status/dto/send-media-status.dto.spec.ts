import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendImageStatusDto, SendVideoStatusDto } from './send-media-status.dto';

describe('SendImageStatusDto recipients validation', () => {
  const valid = { image: { url: 'https://example.com/i.png' }, recipients: ['6281@c.us'] };

  it('accepts a non-empty recipients array', async () => {
    const errors = await validate(plainToInstance(SendImageStatusDto, valid));
    expect(errors).toHaveLength(0);
  });

  it('rejects missing recipients', async () => {
    const errors = await validate(plainToInstance(SendImageStatusDto, { image: valid.image }));
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('rejects an empty recipients array (-> 400)', async () => {
    const errors = await validate(plainToInstance(SendImageStatusDto, { image: valid.image, recipients: [] }));
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('rejects non-string entries', async () => {
    const errors = await validate(plainToInstance(SendImageStatusDto, { image: valid.image, recipients: [123] }));
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('rejects more than 256 recipients', async () => {
    const recipients = Array.from({ length: 257 }, (_, i) => `${i}@c.us`);
    const errors = await validate(plainToInstance(SendImageStatusDto, { image: valid.image, recipients }));
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('rejects malformed JIDs', async () => {
    const errors = await validate(
      plainToInstance(SendImageStatusDto, {
        image: valid.image,
        recipients: ['not-a-jid', '123@g.us', '@c.us', 'abc@lid'],
      }),
    );
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('accepts @lid recipients', async () => {
    const errors = await validate(
      plainToInstance(SendImageStatusDto, { image: valid.image, recipients: ['6281@lid'] }),
    );
    expect(errors).toHaveLength(0);
  });
});

describe('SendVideoStatusDto recipients validation', () => {
  const valid = { video: { url: 'https://example.com/v.mp4' }, recipients: ['6281@c.us'] };

  it('accepts a non-empty recipients array', async () => {
    const errors = await validate(plainToInstance(SendVideoStatusDto, valid));
    expect(errors).toHaveLength(0);
  });

  it('rejects missing recipients', async () => {
    const errors = await validate(plainToInstance(SendVideoStatusDto, { video: valid.video }));
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('rejects an empty recipients array (-> 400)', async () => {
    const errors = await validate(plainToInstance(SendVideoStatusDto, { video: valid.video, recipients: [] }));
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('rejects non-string entries', async () => {
    const errors = await validate(plainToInstance(SendVideoStatusDto, { video: valid.video, recipients: [123] }));
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('rejects more than 256 recipients', async () => {
    const recipients = Array.from({ length: 257 }, (_, i) => `${i}@c.us`);
    const errors = await validate(plainToInstance(SendVideoStatusDto, { video: valid.video, recipients }));
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('rejects malformed JIDs', async () => {
    const errors = await validate(
      plainToInstance(SendVideoStatusDto, {
        video: valid.video,
        recipients: ['not-a-jid', '123@g.us', '@c.us', 'abc@lid'],
      }),
    );
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('accepts @lid recipients', async () => {
    const errors = await validate(
      plainToInstance(SendVideoStatusDto, { video: valid.video, recipients: ['6281@lid'] }),
    );
    expect(errors).toHaveLength(0);
  });
});
