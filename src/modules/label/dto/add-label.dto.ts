import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

/** Validated body for adding a label to a chat (was an inline @Body literal). */
export class AddLabelDto {
  @ApiProperty({ description: 'Label ID to add to the chat' })
  @IsString()
  @IsNotEmpty()
  labelId: string;
}
