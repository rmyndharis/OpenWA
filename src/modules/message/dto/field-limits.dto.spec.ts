import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GLOBAL_VALIDATION_OPTIONS } from '../../../config/app-validation';
import { CustomLinkPreviewDto, SendMediaMessageDto, SendTextMessageDto } from './send-message.dto';
import { ClickButtonDto, SendPollDto, StarMessageDto } from './message-actions.dto';

// docs/06 and the published OpenAPI schema state these limits, and the DTO decorators enforce them, with
// nothing tying the two together: @nestjs/swagger derives no bound from a validator, so a literal in
// @ApiProperty and a constant in @MaxLength can part without any other check noticing. This table holds
// the validator side to the documented numbers. The limits are written out as literals on purpose: a
// spec that read the DTO's own constant would move with a change to it and keep passing.
const validateDto = (cls: new () => object, obj: unknown) =>
  validate(plainToInstance(cls, obj, GLOBAL_VALIDATION_OPTIONS.transformOptions), GLOBAL_VALIDATION_OPTIONS);

interface Row {
  label: string;
  dto: new () => object;
  /** A payload that is valid apart from `field`. */
  base: object;
  field: string;
  /** The largest value the documented limit allows. */
  valid: unknown;
  /** The smallest value past it. */
  invalid: unknown;
}

const CHAT = '628123456789@c.us';
const text = (length: number): string => 'x'.repeat(length);
const PREVIEW = { url: 'https://example.com/launch', title: 'We just launched' };

const ROWS: Row[] = [
  {
    label: 'SendTextMessageDto.quotedMessageId is non-empty',
    dto: SendTextMessageDto,
    base: { chatId: CHAT, text: 'hi' },
    field: 'quotedMessageId',
    valid: 'wamid.quoted',
    invalid: '',
  },
  {
    label: 'SendTextMessageDto.customLinkPreview is validated as a nested object (title is required)',
    dto: SendTextMessageDto,
    base: { chatId: CHAT, text: 'hi' },
    field: 'customLinkPreview',
    valid: PREVIEW,
    invalid: { url: PREVIEW.url },
  },
  {
    label: 'CustomLinkPreviewDto.url is non-empty',
    dto: CustomLinkPreviewDto,
    base: PREVIEW,
    field: 'url',
    valid: 'https://example.com/a',
    invalid: '',
  },
  {
    label: 'CustomLinkPreviewDto.title is at most 256 characters',
    dto: CustomLinkPreviewDto,
    base: PREVIEW,
    field: 'title',
    valid: text(256),
    invalid: text(257),
  },
  {
    label: 'CustomLinkPreviewDto.description is at most 1024 characters',
    dto: CustomLinkPreviewDto,
    base: PREVIEW,
    field: 'description',
    valid: text(1024),
    invalid: text(1025),
  },
  {
    label: 'SendMediaMessageDto.filename is at most 255 characters',
    dto: SendMediaMessageDto,
    base: { chatId: CHAT, url: 'https://example.com/a.pdf' },
    field: 'filename',
    valid: text(255),
    invalid: text(256),
  },
  {
    label: 'SendMediaMessageDto.caption is at most 1024 characters',
    dto: SendMediaMessageDto,
    base: { chatId: CHAT, url: 'https://example.com/a.jpg' },
    field: 'caption',
    valid: text(1024),
    invalid: text(1025),
  },
  {
    label: 'SendPollDto.name is at most 255 characters',
    dto: SendPollDto,
    base: { chatId: CHAT, name: 'Where?', options: ['Park', 'Beach'] },
    field: 'name',
    valid: text(255),
    invalid: text(256),
  },
  {
    label: 'SendPollDto.options entries are at most 100 characters',
    dto: SendPollDto,
    base: { chatId: CHAT, name: 'Where?', options: ['Park', 'Beach'] },
    field: 'options',
    valid: [text(100), 'Beach'],
    invalid: [text(101), 'Beach'],
  },
  {
    label: 'ClickButtonDto.text is at most 4096 characters',
    dto: ClickButtonDto,
    base: { chatId: CHAT, messageId: 'wamid.prompt', buttonId: 'yes' },
    field: 'text',
    valid: text(4096),
    invalid: text(4097),
  },
  {
    label: 'StarMessageDto.star is a boolean',
    dto: StarMessageDto,
    base: { chatId: CHAT, messageId: 'wamid.target' },
    field: 'star',
    valid: false,
    invalid: 'maybe',
  },
];

describe('send and action DTO field limits (docs/06 Constraints)', () => {
  const propertiesFailing = async (row: Row, value: unknown): Promise<string[]> =>
    (await validateDto(row.dto, { ...row.base, [row.field]: value })).map(error => error.property);

  it.each(ROWS)('$label', async row => {
    expect({ case: 'largest valid value', failing: await propertiesFailing(row, row.valid) }).toEqual({
      case: 'largest valid value',
      failing: [],
    });
    expect({ case: 'smallest invalid value', failing: await propertiesFailing(row, row.invalid) }).toEqual({
      case: 'smallest invalid value',
      failing: [row.field],
    });
  });
});
