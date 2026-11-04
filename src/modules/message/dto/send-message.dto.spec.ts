import { DECORATORS } from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CustomLinkPreviewDto,
  SendTextMessageDto,
  SendMediaMessageDto,
  SendAudioMessageDto,
  SEND_TEXT_BODY_EXAMPLES,
  SEND_IMAGE_BODY_EXAMPLES,
  SEND_VIDEO_BODY_EXAMPLES,
  SEND_AUDIO_BODY_EXAMPLES,
  SEND_DOCUMENT_BODY_EXAMPLES,
  SEND_STICKER_BODY_EXAMPLES,
  SEND_LOCATION_BODY_EXAMPLES,
  SEND_CONTACT_BODY_EXAMPLES,
  SEND_POLL_BODY_EXAMPLES,
} from './send-message.dto';
import { SendLocationDto, SendContactDto, SendPollDto } from './message-actions.dto';
import { SendTemplateMessageDto } from './send-template.dto';
import { GLOBAL_VALIDATION_OPTIONS } from '../../../config/app-validation';

// Read the production pipe's own options rather than restating them, so these cases cannot assert a
// contract the running app does not apply (a restated copy left out implicit conversion). Validated
// directly instead of through pipe.transform so the cases can name the property that failed.
const validateDto = (cls: new () => object, obj: unknown) =>
  validate(plainToInstance(cls, obj, GLOBAL_VALIDATION_OPTIONS.transformOptions), GLOBAL_VALIDATION_OPTIONS);

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

  it.each([['NOT A USER@c.us'], ['abc@c.us'], ['@c.us'], ['abc@lid'], ['0@c.us']])(
    'rejects %s — a recognised domain is not enough on its own',
    async mention => {
      // These satisfied the original domain-only check and still reached the page-side createWid,
      // which is the throw #1068 was filed for.
      const errors = await validateDto(SendTextMessageDto, { chatId: 'g@g.us', text: 'hi', mentions: [mention] });
      expect(errors.length).toBeGreaterThan(0);
    },
  );

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
      // Each entry must be individually VALID, or the array-size rule is not what fails and the
      // test passes for the wrong reason: `0@c.us` is rejected on shape.
      mentions: Array.from({ length: 1025 }, (_, i) => `${628000000000 + i}@c.us`),
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

// send-location, send-contact and send-poll were sampler-driven until quotedMessageId gave them an
// optional property whose sampled value the send path REFUSES (an unresolvable quote fails rather
// than delivering unquoted), which would have made every unedited Execute an error. Same trap as
// #1068, so the same contract: each example must validate, and must not carry a quotedMessageId.
describe('location / contact / poll body examples', () => {
  const suites: Array<[string, new () => object, Record<string, { value: unknown }>]> = [
    ['send-location', SendLocationDto, SEND_LOCATION_BODY_EXAMPLES],
    ['send-contact', SendContactDto, SEND_CONTACT_BODY_EXAMPLES],
    ['send-poll', SendPollDto, SEND_POLL_BODY_EXAMPLES],
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

  // The whole reason these examples exist: a pre-filled quoted id points at no real message.
  it.each(suites)('%s examples carry no quotedMessageId', (_route, _cls, examples) => {
    for (const [name, example] of Object.entries(examples)) {
      expect({ name, quoted: (example.value as { quotedMessageId?: string }).quotedMessageId }).toEqual({
        name,
        quoted: undefined,
      });
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
    ['privacy id @lid (phone genuinely unknown)', '100000000000000@lid'],
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

// Both engines fetch only a string that starts with http(s):// and decode anything else as base64,
// so any other url passed validation and then failed inside the engine.
describe('SendMediaMessageDto url', () => {
  it('accepts only an absolute http(s) url', async () => {
    for (const url of ['example.com/a.jpg', 'ftp://example.com/a.jpg']) {
      expect((await validateDto(SendMediaMessageDto, { chatId: 'c@c.us', url })).length).toBeGreaterThan(0);
    }
    for (const url of ['https://example.com/a.jpg', 'HTTPS://example.com/a.jpg', 'http://media_server:8080/a.jpg']) {
      expect(await validateDto(SendMediaMessageDto, { chatId: 'c@c.us', url })).toHaveLength(0);
    }
  });

  it('ignores a stale url next to base64', async () => {
    expect(await validateDto(SendMediaMessageDto, { chatId: 'c@c.us', base64: 'AAAA', url: 'junk' })).toHaveLength(0);
  });

  it('checks the url when base64 is only a data-URI prefix, since the url is then what gets sent', async () => {
    const errors = await validateDto(SendMediaMessageDto, {
      chatId: 'c@c.us',
      base64: 'data:image/jpeg;base64,',
      mimetype: 'image/jpeg',
      url: 'cdn/banner.jpg',
    });
    expect(errors.map(e => e.property)).toContain('url');
  });
});

describe('SendMediaMessageDto base64', () => {
  // A url next to it must not switch the type check off: buildMediaInput reads base64 first, so a
  // non-string there reached the engine whatever the url said.
  it('rejects a non-string base64 even when a url is present', async () => {
    const errors = await validateDto(SendMediaMessageDto, {
      chatId: 'c@c.us',
      url: 'https://example.com/a.jpg',
      base64: ['x'],
      mimetype: 'image/jpeg',
    });
    expect(errors.map(e => e.property)).toContain('base64');
  });
});

// @nestjs/swagger derives no bounds from the validators, so each one is declared on the decorator;
// without it the published schema advertises an unbounded field the server answers 400 for.
describe('SendTemplateMessageDto identifiers', () => {
  // TemplateService.resolve reads templateId first, so a templateName next to it must not switch the
  // type check off.
  it('rejects a non-string templateId even when a templateName is present', async () => {
    const errors = await validateDto(SendTemplateMessageDto, {
      chatId: 'c@c.us',
      templateId: ['a'],
      templateName: 'x',
    });
    expect(errors.map(e => e.property)).toContain('templateId');
  });

  it('rejects a non-string templateName even when a templateId is present', async () => {
    const errors = await validateDto(SendTemplateMessageDto, {
      chatId: 'c@c.us',
      templateId: 'a',
      templateName: ['x'],
    });
    expect(errors.map(e => e.property)).toContain('templateName');
  });
});

describe('SendTextMessageDto customLinkPreview', () => {
  const base = { chatId: 'g@g.us', text: 'hi https://example.com' };
  const preview = { url: 'https://example.com', title: 'Example' };
  const previewErrors = async (customLinkPreview: unknown) =>
    (await validateDto(SendTextMessageDto, { ...base, customLinkPreview })).filter(
      e => e.property === 'customLinkPreview',
    );

  it('accepts the preview as an object', async () => {
    expect(await previewErrors(preview)).toHaveLength(0);
  });

  // @ValidateNested checks an array element by element, so [] and [{...}] passed and reached the engine as
  // an array, which Baileys read .url and .title off to send an empty preview without an error.
  it.each([[[]], [[preview]]])('refuses an array: %j', async value => {
    expect(await previewErrors(value)).toHaveLength(1);
  });

  it('accepts a preview image as an http(s) URL or as base64', async () => {
    expect(await previewErrors({ ...preview, thumbnailUrl: 'https://cdn.example/a.jpg' })).toHaveLength(0);
    expect(await previewErrors({ ...preview, thumbnailBase64: 'AAAA' })).toHaveLength(0);
  });

  it('refuses a preview image URL that is not http(s)', async () => {
    expect(await previewErrors({ ...preview, thumbnailUrl: 'file:///etc/passwd' })).toHaveLength(1);
  });

  // base64 wins, as on the media routes, so the URL beside it is never fetched and not checked.
  it('does not check a preview image URL beside a base64', async () => {
    expect(await previewErrors({ ...preview, thumbnailUrl: 'not a url', thumbnailBase64: 'AAAA' })).toHaveLength(0);
  });
});

// Implicit conversion rewrote a boolean or an object into its string form before @IsString ran, so
// {"text":{"order":42}} was sent as the literal text "[object Object]". A number keeps the conversion: no-code
// clients post a phone number or a chat id held as a number, and every release has read it as its decimal
// string. Every field below is documented as a string, in docs/06 and in the request types of all five SDKs.
describe('string fields refuse a boolean or an object', () => {
  const invalid: Array<[unknown]> = [[{ order: 42 }], [true], [['a']]];

  it.each(invalid)('SendTextMessageDto refuses text %j', async text => {
    const errors = await validateDto(SendTextMessageDto, { chatId: 'g@g.us', text });
    expect(errors.map(e => e.property)).toEqual(['text']);
  });

  it.each(invalid)('SendTextMessageDto refuses chatId %j', async chatId => {
    const errors = await validateDto(SendTextMessageDto, { chatId, text: 'hi' });
    expect(errors.map(e => e.property)).toEqual(['chatId']);
  });

  it.each(invalid)('SendMediaMessageDto refuses caption %j', async caption => {
    const errors = await validateDto(SendMediaMessageDto, {
      chatId: 'g@g.us',
      url: 'https://example.com/a.jpg',
      caption,
    });
    expect(errors.map(e => e.property)).toEqual(['caption']);
  });

  it.each(invalid)('SendContactDto refuses contactNumber %j', async contactNumber => {
    const errors = await validateDto(SendContactDto, { chatId: 'g@g.us', contactName: 'Alice', contactNumber });
    expect(errors.map(e => e.property)).toEqual(['contactNumber']);
  });

  it('still reads a number as its decimal string', async () => {
    const contact = plainToInstance(
      SendContactDto,
      { chatId: 'g@g.us', contactName: 'Alice', contactNumber: 628999888777 },
      GLOBAL_VALIDATION_OPTIONS.transformOptions,
    );
    expect(contact.contactNumber).toBe('628999888777');
    expect(await validate(contact, GLOBAL_VALIDATION_OPTIONS)).toHaveLength(0);

    expect(await validateDto(SendTextMessageDto, { chatId: 'g@g.us', text: 5 })).toHaveLength(0);
  });

  it('still takes the same values spelled as strings', async () => {
    expect(await validateDto(SendTextMessageDto, { chatId: 'g@g.us', text: '{"order":42}' })).toHaveLength(0);
    expect(await validateDto(SendTextMessageDto, { chatId: 'g@g.us', text: '628123456789' })).toHaveLength(0);
    expect(await validateDto(SendTextMessageDto, { chatId: 'g@g.us', text: 'true' })).toHaveLength(0);
  });
});

describe('published schema bounds', () => {
  const published = (cls: new () => object, key: string): Record<string, unknown> | undefined =>
    Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES, cls.prototype as object, key) as
      Record<string, unknown> | undefined;

  it.each([SendTextMessageDto, SendMediaMessageDto, SendTemplateMessageDto])('%p bounds mentions', cls => {
    expect(published(cls, 'mentions')).toMatchObject({
      maxItems: 1024,
      items: { type: 'string', maxLength: 64 },
    });
  });

  it('bounds the media filename and the custom preview url', () => {
    expect(published(SendMediaMessageDto, 'filename')?.maxLength).toBe(255);
    expect(published(CustomLinkPreviewDto, 'url')?.maxLength).toBe(2048);
  });
});
