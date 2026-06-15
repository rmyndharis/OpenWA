import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class MarkChatReadDto {
  @ApiProperty({
    description: 'WhatsApp chat ID to mark as read (e.g., 1234567890@c.us or 1234567890-123@g.us)',
    example: '1234567890@c.us',
  })
  @IsString()
  @IsNotEmpty()
  // Reject malformed IDs early with a clear 400 instead of a silent no-op at the engine layer.
  @Matches(/^[0-9-]+@[cg]\.us$/, {
    message: 'chatId must be a valid WhatsApp JID (e.g. 1234567890@c.us or 1234567890-123@g.us)',
  })
  chatId: string;
}
