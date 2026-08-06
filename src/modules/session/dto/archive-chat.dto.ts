import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsString, Matches } from 'class-validator';
import { ToStrictBoolean } from '../../../common/utils/strict-boolean';

export class ArchiveChatDto {
  @ApiProperty({
    description: "Chat ID in the active engine's native format (e.g. 1234567890-123@g.us on whatsapp-web.js)",
    example: '1234567890-123@g.us',
  })
  @IsString()
  @IsNotEmpty()
  // Engine-neutral structural check (localpart@host, no whitespace) so a different engine's JID scheme
  // (e.g. Baileys `…@s.whatsapp.net`) is accepted too; the adapter validates/normalises for its engine.
  @Matches(/^[^\s@]+@[^\s@]+$/, {
    message: 'chatId must be a valid chat JID in the form localpart@host',
  })
  chatId!: string;

  @ApiProperty({ description: 'true to archive, false to unarchive.' })
  // Read strictly: under the pipe's implicit conversion the string "false" would become boolean
  // true, archiving a chat the caller asked to restore.
  @ToStrictBoolean()
  @IsBoolean()
  archive!: boolean;
}
