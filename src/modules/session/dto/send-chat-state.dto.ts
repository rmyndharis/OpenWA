import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import type { ChatState } from '../../../engine/interfaces/whatsapp-engine.interface';
import { CHAT_ID_MAX_LENGTH, CHAT_JID_MESSAGE, CHAT_JID_PATTERN } from '../../message/dto/send-message.dto';
import { ToStrictString } from '../../../common/utils/strict-boolean';

export class SendChatStateDto {
  @ApiProperty({
    maxLength: CHAT_ID_MAX_LENGTH,
    // Engine-neutral on purpose: the chat id may be any localpart@host spelling, and the neutral form
    // the gateway returns (e.g. <number>@c.us) works on either engine.
    // The adapter normalises it; the decorators below check only its length and localpart@host shape.
    description: 'Chat ID in the neutral form the gateway returns, on either engine (e.g. 1234567890@c.us)',
    example: '1234567890@c.us',
  })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  @MaxLength(CHAT_ID_MAX_LENGTH)
  @Matches(CHAT_JID_PATTERN, { message: CHAT_JID_MESSAGE })
  chatId!: string;

  @ApiProperty({
    description: "Presence to send: 'typing' or 'recording' shows the indicator; 'paused' clears it",
    enum: ['typing', 'recording', 'paused'],
    example: 'typing',
  })
  @IsIn(['typing', 'recording', 'paused'])
  state!: ChatState;
}
