import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, Matches, Min, ValidateIf } from 'class-validator';

export class MuteChatDto {
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

  @ApiProperty({
    description:
      'Absolute epoch-MILLISECONDS timestamp at which the mute expires, or `null` to unmute now. ' +
      'Required — omitting it is rejected rather than guessed, because the two plausible readings ' +
      '(unmute vs mute forever) are opposites. To mute indefinitely, send a far-future timestamp. ' +
      'Milliseconds, not seconds: a seconds-scale value is an instant in 1970, so the mute expires ' +
      'immediately while the request still answers 200.',
    example: 1800000000000,
    type: Number,
    nullable: true,
  })
  // `null` is a real instruction (unmute), so it skips the numeric checks rather than failing them.
  // A missing field is NOT null, so it still falls through to @IsInt and is rejected with a 400.
  @ValidateIf((o: MuteChatDto) => o.muteUntil !== null)
  @IsInt()
  @Min(1)
  muteUntil!: number | null;
}
