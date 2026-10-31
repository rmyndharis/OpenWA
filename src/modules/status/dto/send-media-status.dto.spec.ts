import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { GLOBAL_VALIDATION_OPTIONS } from '../../../config/app-validation';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendImageStatusDto, SendVideoStatusDto, SendVoiceStatusDto } from './send-media-status.dto';

describe('SendImageStatusDto recipients validation', () => {
  const valid = { image: { url: 'https://example.com/i.png' }, recipients: ['6281@c.us'] };

  it('accepts a non-empty recipients array', async () => {
    const errors = await validate(plainToInstance(SendImageStatusDto, valid));
    expect(errors).toHaveLength(0);
  });

  it('accepts missing recipients (optional — whatsapp-web.js broadcasts without them)', async () => {
    const errors = await validate(plainToInstance(SendImageStatusDto, { image: valid.image }));
    expect(errors).toHaveLength(0);
  });

  it('accepts an empty recipients array', async () => {
    const errors = await validate(plainToInstance(SendImageStatusDto, { image: valid.image, recipients: [] }));
    expect(errors).toHaveLength(0);
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

  it.each(['not-a-jid', '123@g.us', '@c.us', 'abc@lid'])('rejects the malformed JID %s', async jid => {
    const errors = await validate(plainToInstance(SendImageStatusDto, { image: valid.image, recipients: [jid] }));
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

  it('accepts missing recipients (optional — whatsapp-web.js broadcasts without them)', async () => {
    const errors = await validate(plainToInstance(SendVideoStatusDto, { video: valid.video }));
    expect(errors).toHaveLength(0);
  });

  it('accepts an empty recipients array', async () => {
    const errors = await validate(plainToInstance(SendVideoStatusDto, { video: valid.video, recipients: [] }));
    expect(errors).toHaveLength(0);
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

  it.each(['not-a-jid', '123@g.us', '@c.us', 'abc@lid'])('rejects the malformed JID %s', async jid => {
    const errors = await validate(plainToInstance(SendVideoStatusDto, { video: valid.video, recipients: [jid] }));
    expect(errors.some(e => e.property === 'recipients')).toBe(true);
  });

  it('accepts @lid recipients', async () => {
    const errors = await validate(
      plainToInstance(SendVideoStatusDto, { video: valid.video, recipients: ['6281@lid'] }),
    );
    expect(errors).toHaveLength(0);
  });
});

// @ValidateNested checks an array element by element, so a media source sent as [] or [{...}] passed.
describe('status media sources refuse an array', () => {
  const source = { url: 'https://example.com/m.bin' };

  it.each([
    ['image', SendImageStatusDto],
    ['video', SendVideoStatusDto],
    ['audio', SendVoiceStatusDto],
  ] as const)('%s as an object is accepted and as an array is refused', async (key, Dto) => {
    const failed = async (value: unknown) =>
      (await validate(plainToInstance(Dto as new () => object, { [key]: value }))).some(e => e.property === key);
    expect(await failed(source)).toBe(false);
    expect(await failed([source])).toBe(true);
    expect(await failed([])).toBe(true);
  });
});

// Both engines fetch only a string that starts with http(s):// and decode anything else as base64.
describe('status media url', () => {
  it('accepts only an absolute http(s) url', async () => {
    for (const url of ['example.com/a.jpg', 'ftp://example.com/a.jpg']) {
      const errors = await validate(plainToInstance(SendImageStatusDto, { image: { url } }));
      expect(errors.some(e => e.property === 'image')).toBe(true);
    }
    for (const url of [
      'https://example.com/a.jpg',
      'HTTPS://example.com/a.jpg',
      'http://media-store/a.jpg',
      'http://media_server:8080/a.jpg',
      `https://bucket.s3.amazonaws.com/k.mp4?X-Amz-Security-Token=${'a'.repeat(2100)}`,
    ]) {
      expect(await validate(plainToInstance(SendVideoStatusDto, { video: { url } }))).toHaveLength(0);
    }
  });

  it('ignores a url sent next to base64, which wins', async () => {
    const both = { image: { base64: 'AAAA', mimetype: 'image/jpeg', url: 'cdn/banner.jpg' } };
    expect(await validate(plainToInstance(SendImageStatusDto, both))).toHaveLength(0);
    const alone = await validate(plainToInstance(SendImageStatusDto, { image: { url: 'cdn/banner.jpg' } }));
    expect(alone.some(e => e.property === 'image')).toBe(true);
    // A base64 that is only a data-URI prefix strips to nothing, so the url is what would be sent.
    const emptyBase64 = { image: { base64: 'data:image/jpeg;base64,', mimetype: 'image/jpeg', url: 'cdn/banner.jpg' } };
    const refused = await validate(plainToInstance(SendImageStatusDto, emptyBase64));
    expect(refused.some(e => e.property === 'image')).toBe(true);
  });
});

describe('status media precedence through the global validation options', () => {
  const pipe = new ValidationPipe(GLOBAL_VALIDATION_OPTIONS);

  it.each([
    ['image', SendImageStatusDto],
    ['video', SendVideoStatusDto],
    ['audio', SendVoiceStatusDto],
  ] as const)('%s ignores an empty unused URL and validates the selected source', async (key, Dto) => {
    const through = (media: unknown) => pipe.transform({ [key]: media }, { type: 'body', metatype: Dto });
    for (const base64 of ['QUJD', 'data:image/png;base64,QUJD']) {
      await expect(through({ base64, url: '', mimetype: 'image/png' })).resolves.toBeDefined();
      await expect(through({ base64, url: 'unused/path', mimetype: 'image/png' })).resolves.toBeDefined();
    }
    await expect(through({ url: 'https://example.com/media' })).resolves.toBeDefined();
    for (const media of [
      {},
      { url: '' },
      { url: 'unused/path' },
      { base64: 'data:image/png;base64,', url: 'unused/path' },
      { base64: 'QUJD', url: null },
      { base64: 'QUJD', url: {} },
      { base64: 'QUJD', url: false },
      { base64: [] },
      { base64: {} },
    ]) {
      await expect(through(media)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
