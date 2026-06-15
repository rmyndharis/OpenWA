import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

/** Validated body for subscribing to a channel (was an inline @Body literal). */
export class SubscribeChannelDto {
  @ApiProperty({ description: 'Channel invite code' })
  @IsString()
  @IsNotEmpty()
  inviteCode: string;
}
