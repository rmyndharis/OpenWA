import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ValidateNested,
  IsString,
  IsNotEmpty,
  IsOptional,
  MaxLength,
  IsUrl,
  ValidateIf,
  IsArray,
  ArrayMaxSize,
  IsBoolean,
  Validate,
} from 'class-validator';
import { Type } from 'class-transformer';
import { IsMentionWidConstraint } from './is-mention-wid.validator';
import { ToStrictBoolean } from '../../../common/utils/strict-boolean';

const MENTIONS_DESCRIPTION =
  'WIDs to @mention (e.g. ["62811@c.us"]). The text/caption must also contain the @<number> token.';

// Single source of truth for the text-body cap, shared with the agent-tool input schemas
// (src/core/agent-tools/tools/message.tools.ts) so MCP and REST enforce the same limit.
export const MESSAGE_TEXT_MAX_LENGTH = 4096;

export class CustomLinkPreviewDto {
  @ApiProperty({
    description: 'The URL as it appears in the message text — WhatsApp anchors the preview to it.',
    example: 'https://example.com/launch',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  url!: string;

  @ApiProperty({
    description: 'Required: WhatsApp will not render a preview without a title.',
    example: 'We just launched',
    maxLength: 256,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  title!: string;

  @ApiPropertyOptional({ description: 'Preview description', example: 'Read the announcement.', maxLength: 1024 })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  description?: string;
}

export class SendTextMessageDto {
  @ApiProperty({
    description: 'WhatsApp chat ID (phone@c.us for individual, groupId@g.us for groups)',
    example: '628123456789@c.us',
  })
  @IsString()
  @IsNotEmpty()
  chatId!: string;

  @ApiProperty({
    description: 'Text message content',
    example: 'Hello from OpenWA!',
    maxLength: MESSAGE_TEXT_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MESSAGE_TEXT_MAX_LENGTH)
  text!: string;

  @ApiPropertyOptional({ description: MENTIONS_DESCRIPTION, example: ['628123456789@c.us'], type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1024)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @Validate(IsMentionWidConstraint, { each: true })
  mentions?: string[];

  @ApiPropertyOptional({
    description:
      'Controls the URL preview, and the engines differ. On whatsapp-web.js WhatsApp Web builds one ' +
      'by default and `false` suppresses it. On Baileys previews are OPT-IN: `true` asks the gateway ' +
      'to fetch the page and attach one, while unset or `false` sends none — generating a preview is ' +
      'a blocking outbound fetch per URL in the text, so it is never done unless asked for.',
    example: false,
  })
  // Implicit conversion turns EVERY non-empty string into true, so an unguarded `false` sent as a
  // string would request a preview instead of suppressing one — the opposite of what was asked.
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  linkPreview?: boolean;

  @ApiPropertyOptional({
    type: CustomLinkPreviewDto,
    description:
      'Attach a preview you supply yourself, instead of one fetched from the URL. Nothing is ' +
      'fetched for these, so a preview can be attached even for a URL this server cannot reach. ' +
      '**Baileys only** — whatsapp-web.js takes a boolean and answers `501`. Cannot be combined ' +
      'with `linkPreview: false`, which asks for the opposite.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CustomLinkPreviewDto)
  customLinkPreview?: CustomLinkPreviewDto;
}

/**
 * Request-body examples for `POST send-text`, applied with `@ApiBody` on the controller.
 *
 * Swagger UI does NOT pre-fill "Try it out" from the required properties — its sampler walks EVERY
 * property in the schema, skipping only `deprecated`/`readOnly`/`writeOnly`. So an optional field is
 * always present in the generated body; a property's `example` only decides the VALUE it is given,
 * never whether it appears. Left to the sampler this endpoint offers `linkPreview: false` together
 * with a `customLinkPreview` object — the one combination `MessageService.sendText` rejects outright
 * — so every Try-it click returned `400 linkPreview: false cannot be combined with customLinkPreview`
 * without the caller having typed anything (#1068). An explicit example overrides the sampler
 * entirely, which is the only way to stop an optional property from reaching the default body.
 *
 * Keep every entry here a payload the API actually accepts: `send-message.dto.spec.ts` validates each
 * one against the DTO and asserts it does not trip that guard, so a future field cannot silently
 * reintroduce an unusable default.
 */
export const SEND_TEXT_BODY_EXAMPLES = {
  minimal: {
    summary: 'Plain text message',
    value: { chatId: '628123456789@c.us', text: 'Hello from OpenWA!' },
  },
  withMentions: {
    summary: 'Group message with an @mention (the text must carry the @<number> token)',
    value: { chatId: '120363000000000000@g.us', text: 'Hello @62811', mentions: ['62811@c.us'] },
  },
};

export class SendMediaMessageDto {
  @ApiProperty({
    description: 'WhatsApp chat ID',
    example: '628123456789@c.us',
  })
  @IsString()
  @IsNotEmpty()
  chatId!: string;

  @ApiPropertyOptional({
    description: 'Media URL (http/https)',
    example: 'https://example.com/image.jpg',
  })
  @IsOptional()
  @IsUrl()
  @ValidateIf((o: SendMediaMessageDto) => !o.base64)
  url?: string;

  @ApiPropertyOptional({
    description: 'Base64 encoded media data',
  })
  @IsOptional()
  @IsString()
  @ValidateIf((o: SendMediaMessageDto) => !o.url)
  base64?: string;

  @ApiPropertyOptional({
    description: 'Media MIME type (required when using base64)',
    example: 'image/jpeg',
  })
  @IsOptional()
  @IsString()
  mimetype?: string;

  @ApiPropertyOptional({
    description:
      "Filename for the media. Only rendered on document sends — defaults to 'file' when omitted (a URL-based document send on whatsapp-web.js first derives the URL basename)",
    example: 'image.jpg',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;

  @ApiPropertyOptional({
    description: 'Caption for the media',
    example: 'Check out this image!',
    maxLength: 1024,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  caption?: string;

  @ApiPropertyOptional({ description: MENTIONS_DESCRIPTION, example: ['628123456789@c.us'], type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1024)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @Validate(IsMentionWidConstraint, { each: true })
  mentions?: string[];
}

/**
 * Request-body examples for the media send routes, applied with `@ApiBody` on the controller.
 *
 * Same reason as the text route: Swagger UI's sampler emits EVERY property, so the generated body
 * carried `url` AND `base64` together. `base64` has no `example`, so it arrived as the literal string
 * `"string"` — and `MessageService.buildMediaInput` deliberately lets base64 win over url (a stale
 * example url must never be fetched in place of real bytes), so pressing Execute uploaded four
 * characters of garbage instead of the example image. An explicit example is the only way to keep an
 * optional property out of the body.
 *
 * Only the URL form is offered, and every entry must be submittable as-is: a base64 example would
 * need real bytes pasted in, which is the "click Execute, get an error" trap this exists to remove.
 * `base64` and its `mimetype` requirement stay documented in the schema.
 */
const mediaBodyExample = (url: string, extra: Record<string, unknown> = {}) => ({
  fromUrl: {
    summary: 'Fetch the media from a URL',
    value: { chatId: '628123456789@c.us', url, ...extra },
  },
});

export const SEND_IMAGE_BODY_EXAMPLES = mediaBodyExample('https://example.com/image.jpg', {
  caption: 'Check out this image!',
});
export const SEND_VIDEO_BODY_EXAMPLES = mediaBodyExample('https://example.com/video.mp4');
export const SEND_AUDIO_BODY_EXAMPLES = mediaBodyExample('https://example.com/audio.ogg', { ptt: true });
export const SEND_DOCUMENT_BODY_EXAMPLES = mediaBodyExample('https://example.com/report.pdf', {
  filename: 'report.pdf',
});
export const SEND_STICKER_BODY_EXAMPLES = mediaBodyExample('https://example.com/sticker.png');

export class SendAudioMessageDto extends SendMediaMessageDto {
  @ApiPropertyOptional({
    description:
      'Send as a WhatsApp voice note (PTT — mic bubble + waveform). Provide audio/ogg; codecs=opus ' +
      'bytes for reliable playback; when the mimetype is omitted it defaults to that for voice notes. ' +
      'Expects a JSON boolean. Default false = plain audio file. Only valid on send-audio.',
  })
  @ToStrictBoolean()
  @IsOptional()
  @IsBoolean()
  ptt?: boolean;
}

export class MessageResponseDto {
  @ApiProperty({
    description:
      'The message id, assigned when the gateway accepts the message for sending. A 201 here means the ' +
      'message was handed to the WhatsApp client — it does NOT confirm delivery. WhatsApp does not reject ' +
      'an unregistered recipient synchronously, so a message to a number that is not on WhatsApp still ' +
      'returns 201 with a valid messageId; whether it later delivers, stalls, or is reported as an error ' +
      'reaches you asynchronously, if at all. To confirm a number is on WhatsApp before ' +
      'sending, use GET /api/sessions/{sessionId}/contacts/check/{number}; track real delivery via the ' +
      'message `status` field (sent → delivered → read, or failed if WhatsApp reports an error for it). ' +
      'A message resting at `sent` is not diagnostic on its own: a registered recipient whose device has ' +
      'not come online since the send stays at `sent` too.',
    example: 'true_628123456789@c.us_3EB0123456789',
  })
  messageId!: string;

  @ApiProperty({
    description: 'Unix timestamp (seconds) at which the gateway accepted the message for sending.',
    example: 1706868000,
  })
  timestamp!: number;
}
