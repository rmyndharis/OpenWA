import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  SendTextMessageDto,
  SendMediaMessageDto,
  SendAudioMessageDto,
  SEND_TEXT_BODY_EXAMPLES,
  SEND_IMAGE_BODY_EXAMPLES,
  SEND_VIDEO_BODY_EXAMPLES,
  SEND_AUDIO_BODY_EXAMPLES,
  SEND_DOCUMENT_BODY_EXAMPLES,
  SEND_STICKER_BODY_EXAMPLES,
} from './send-message.dto';

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

// These examples are what Swagger UI pre-fills into "Try it out", so a caller who changes nothing
// submits them verbatim. Left to the schema sampler the body paired `linkPreview: false` with a
// `customLinkPreview` and every Try-it click 400'd (#1068); these assertions are what keeps a new
// optional field from quietly recreating an unusable default.
describe('SEND_TEXT_BODY_EXAMPLES', () => {
  const entries = Object.entries(SEND_TEXT_BODY_EXAMPLES);

  it('declares at least one example', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)('%s passes DTO validation', async (_name, example) => {
    const errors = await validateDto(SendTextMessageDto, example.value);
    expect(errors).toHaveLength(0);
  });

  it.each(entries)('%s does not combine linkPreview:false with customLinkPreview', (_name, example) => {
    const value = example.value as { linkPreview?: boolean; customLinkPreview?: unknown };
    expect(value.linkPreview === false && value.customLinkPreview !== undefined).toBe(false);
  });
});

// These are what Swagger UI pre-fills into "Try it out", so a caller who changes nothing submits them
// verbatim. Left to the schema sampler the body carried `url` and `base64: "string"` together, and
// base64 wins in buildMediaInput — so Execute uploaded four characters of garbage (#1068). Every
// example must stay submittable as-is, which is what stops a new optional field from recreating that.
describe('media route body examples', () => {
  const suites: Array<[string, new () => object, Record<string, { value: unknown }>]> = [
    ['send-image', SendMediaMessageDto, SEND_IMAGE_BODY_EXAMPLES],
    ['send-video', SendMediaMessageDto, SEND_VIDEO_BODY_EXAMPLES],
    ['send-audio', SendAudioMessageDto, SEND_AUDIO_BODY_EXAMPLES],
    ['send-document', SendMediaMessageDto, SEND_DOCUMENT_BODY_EXAMPLES],
    ['send-sticker', SendMediaMessageDto, SEND_STICKER_BODY_EXAMPLES],
  ];

  it.each(suites)('%s declares at least one example', (_route, _cls, examples) => {
    expect(Object.keys(examples).length).toBeGreaterThan(0);
  });

  it.each(suites)('%s examples all pass DTO validation', async (_route, cls, examples) => {
    for (const [name, example] of Object.entries(examples)) {
      const errors = await validateDto(cls, example.value);
      expect({ name, errors: errors.map(e => e.property) }).toEqual({ name, errors: [] });
    }
  });

  // buildMediaInput prefers base64 over url, so an example carrying both would send the base64 —
  // and no short placeholder is real media. Exactly one source per example, never both.
  it.each(suites)('%s examples carry exactly one media source', (_route, _cls, examples) => {
    for (const [name, example] of Object.entries(examples)) {
      const v = example.value as { url?: string; base64?: string };
      expect({ name, sources: [v.url, v.base64].filter(Boolean).length }).toEqual({ name, sources: 1 });
    }
  });
});

// Nothing checked the shape before, so a malformed entry reached WhatsApp Web's createWid and threw
// from the minified bundle as `Error: t: t` — the caller got a 500 that named neither the field nor
// the value (#1068). These cases are the contract: what an individual WID looks like, and what does not.
describe('mentions WID shape', () => {
  const accepted: Array<[string, string]> = [
    ['phone @c.us (the documented form)', '628123456789@c.us'],
    ['raw protocol @s.whatsapp.net (the #156 workaround)', '628123456789@s.whatsapp.net'],
    ['privacy id @lid (phone genuinely unknown)', '148004841455867@lid'],
    ['multi-device suffix', '628123456789:12@c.us'],
  ];

  const rejected: Array<[string, string]> = [
    ['bare number, no domain', '628123456789'],
    ['garbage', 'not-a-wid!!'],
    ['empty string', ''],
    ['group id (mentions is the participant list, not groupMentions)', '120363000000000000@g.us'],
    ['status pseudo-JID', 'status@broadcast'],
    ['unknown domain', '628123456789@example.com'],
  ];

  it.each(accepted)('accepts %s', async (_label, wid) => {
    const errors = await validateDto(SendTextMessageDto, { chatId: 'g@g.us', text: 'hi', mentions: [wid] });
    expect(errors).toHaveLength(0);
  });

  it.each(rejected)('rejects %s', async (_label, wid) => {
    const errors = await validateDto(SendTextMessageDto, { chatId: 'g@g.us', text: 'hi', mentions: [wid] });
    expect(errors.map(e => e.property)).toEqual(['mentions']);
  });

  it('rejects a bad entry even when another entry is valid', async () => {
    const errors = await validateDto(SendTextMessageDto, {
      chatId: 'g@g.us',
      text: 'hi',
      mentions: ['628123456789@c.us', 'not-a-wid!!'],
    });
    expect(errors.map(e => e.property)).toEqual(['mentions']);
  });

  it('applies to media captions too', async () => {
    const errors = await validateDto(SendMediaMessageDto, {
      chatId: 'g@g.us',
      url: 'https://example.com/a.jpg',
      mentions: ['not-a-wid!!'],
    });
    expect(errors.map(e => e.property)).toEqual(['mentions']);
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
