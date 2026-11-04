import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { ToStrictBoolean, ToStrictString } from '../../../common/utils/strict-boolean';
import { CHAT_ID_MAX_LENGTH } from '../../message/dto/send-message.dto';

export class ArchiveChatDto {
  @ApiProperty({
    maxLength: CHAT_ID_MAX_LENGTH,
    description: 'Chat ID in the neutral form the gateway returns, on either engine (e.g. 1234567890-123@g.us)',
    example: '1234567890-123@g.us',
  })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(CHAT_ID_MAX_LENGTH)
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
