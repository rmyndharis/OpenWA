import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class MarkChatReadDto {
  @ApiProperty({
    description: "Chat ID in the active engine's native format (e.g. 1234567890@c.us on whatsapp-web.js)",
    example: '1234567890@c.us',
  })
  @IsString()
  @IsNotEmpty()
  // Engine-neutral structural check (localpart@host, no whitespace) so a different engine's JID
  // scheme (e.g. Baileys 1234@s.whatsapp.net) is accepted too; the adapter validates/normalises
  // further for its own engine. Keeps the early-400 on obvious garbage without coupling to wwebjs.
  @Matches(/^[^\s@]+@[^\s@]+$/, {
    message: 'chatId must be a valid chat JID in the form localpart@host',
  })
  chatId: string;
}
