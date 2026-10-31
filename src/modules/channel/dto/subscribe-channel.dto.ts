import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';
import { ToStrictString } from '../../../common/utils/strict-boolean';

/** Validated body for subscribing to a channel (was an inline @Body literal). */
export class SubscribeChannelDto {
  @ApiProperty({ description: 'Channel invite code' })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  inviteCode!: string;
}
