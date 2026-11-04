import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { CHAT_ID_MAX_LENGTH, CHAT_JID_MESSAGE, CHAT_JID_PATTERN } from '../../message/dto/send-message.dto';
import { ToStrictString } from '../../../common/utils/strict-boolean';

/**
 * Deliberately separate from {@link MarkChatReadDto}, which the unread route used to share. The read
 * route accepts `messageIds`; the unread route has nothing to do with them and ignores them, so
 * sharing the class published a field on `POST /chats/unread` that it silently discarded.
 */
export class MarkChatUnreadDto {
  @ApiProperty({
    maxLength: CHAT_ID_MAX_LENGTH,
    description: 'Chat ID in the neutral form the gateway returns, on either engine (e.g. 1234567890@c.us)',
    example: '1234567890@c.us',
  })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(CHAT_ID_MAX_LENGTH)
  // Engine-neutral structural check (localpart@host, no whitespace) so a different engine's JID
  // scheme (e.g. Baileys 1234@s.whatsapp.net) is accepted too; the adapter normalises further.
  @Matches(CHAT_JID_PATTERN, { message: CHAT_JID_MESSAGE })
  chatId!: string;
}
