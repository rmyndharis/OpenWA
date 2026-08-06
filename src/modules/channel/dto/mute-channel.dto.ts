import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { ToStrictBoolean } from '../../../common/utils/strict-boolean';

export class MuteChannelDto {
  @ApiProperty({
    description: 'True to mute the channel, false to unmute it. Subscription is unaffected either way.',
    example: true,
  })
  // The global pipe runs with implicit conversion, which turns EVERY non-empty string into true —
  // so an unguarded `false` sent as a string would mute instead of unmuting.
  @ToStrictBoolean()
  @IsBoolean()
  mute!: boolean;
}
