import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import type { ChatState } from '../../../engine/interfaces/whatsapp-engine.interface';

export class SendChatStateDto {
  @ApiProperty({
    // Engine-neutral on purpose: the chat id is whatever the active engine uses
    // (e.g. <number>@c.us on whatsapp-web.js, <number>@s.whatsapp.net on Baileys).
    // The adapter validates/normalises it — we only require a non-empty string here.
    description: "Chat ID, in the active engine's native format (e.g. 1234567890@c.us)",
    example: '1234567890@c.us',
  })
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @ApiProperty({
    description: "Presence to send: 'typing' or 'recording' shows the indicator; 'paused' clears it",
    enum: ['typing', 'recording', 'paused'],
    example: 'typing',
  })
  @IsIn(['typing', 'recording', 'paused'])
  state: ChatState;
}
