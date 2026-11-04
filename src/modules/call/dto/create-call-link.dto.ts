import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Max, Min } from 'class-validator';
import { ToStrictNumber, ToStrictString } from '../../../common/utils/strict-boolean';

/** The largest epoch-ms value a JS Date can hold; anything above it is an Invalid Date. */
const MAX_DATE_MS = 8_640_000_000_000_000;

export class CreateCallLinkDto {
  @ApiProperty({
    description: "Which kind of call the link opens. WhatsApp's own URL path for `audio` is `/voice/`.",
    enum: ['audio', 'video'],
    example: 'video',
  })
  @ToStrictString()
  @IsString()
  @IsIn(['audio', 'video'])
  type!: 'audio' | 'video';

  @ApiProperty({
    description:
      'Absolute epoch-MILLISECONDS timestamp the call is scheduled to start at. Required: ' +
      'whatsapp-web.js generates an event-linked call and has no notion of "no start time", so a ' +
      'link for right now is `Date.now()` rather than an omitted field.',
    example: 1800000000000,
    type: 'integer',
    minimum: 1,
    maximum: MAX_DATE_MS,
  })
  // A JSON `true` would otherwise convert to 1 (a start time in 1970) instead of failing @IsInt().
  @ToStrictNumber()
  @IsInt()
  @Min(1)
  @Max(MAX_DATE_MS)
  startTime!: number;
}
