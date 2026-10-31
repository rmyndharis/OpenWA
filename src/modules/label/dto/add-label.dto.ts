import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';
import { ToStrictString } from '../../../common/utils/strict-boolean';

/** Validated body for adding a label to a chat (was an inline @Body literal). */
export class AddLabelDto {
  @ApiProperty({ description: 'Label ID to add to the chat' })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  labelId!: string;
}
