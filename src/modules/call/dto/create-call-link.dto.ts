import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Min } from 'class-validator';

export class CreateCallLinkDto {
  @ApiProperty({
    description: "Which kind of call the link opens. WhatsApp's own URL path for `audio` is `/voice/`.",
    enum: ['audio', 'video'],
    example: 'video',
  })
  @IsString()
  @IsIn(['audio', 'video'])
  type!: 'audio' | 'video';

  @ApiProperty({
    description:
      'Absolute epoch-MILLISECONDS timestamp the call is scheduled to start at. Required: ' +
      'whatsapp-web.js generates an event-linked call and has no notion of "no start time", so a ' +
      'link for right now is `Date.now()` rather than an omitted field.',
    example: 1800000000000,
  })
  @IsInt()
  @Min(1)
  startTime!: number;
}
