import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, Matches, Max, Min, ValidateIf, MaxLength } from 'class-validator';
import { CHAT_ID_MAX_LENGTH } from '../../message/dto/send-message.dto';
import { ToStrictString } from '../../../common/utils/strict-boolean';

/**
 * The largest integer a JSON number carries exactly, and the bound on `muteUntil`. Both engines take every
 * value up to it: whatsapp-web.js converts the value through Date, so past the last JavaScript date
 * (8.64e15) the date is invalid and the call becomes a mute with no end, which is what a client sending
 * this value for "forever" means, and Baileys writes the number exactly into an int64. Past it a number is
 * no longer an exact integer, and the int64 wraps from 2^63 (1e300 encodes as 0).
 */
export const MUTE_UNTIL_MAX = Number.MAX_SAFE_INTEGER;

export class MuteChatDto {
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

  @ApiProperty({
    description:
      'Absolute epoch-MILLISECONDS timestamp at which the mute expires, or `null` to unmute now. ' +
      'Required — omitting it is rejected rather than guessed, because the two plausible readings ' +
      '(unmute vs mute forever) are opposites. To mute indefinitely, send a far-future timestamp, no later ' +
      'than 9007199254740991 (Number.MAX_SAFE_INTEGER, the largest integer a JSON number carries exactly). ' +
      'Milliseconds, not seconds: a seconds-scale value is an instant in 1970, so the mute expires ' +
      'immediately while the request still answers 200.',
    example: 1800000000000,
    type: 'integer',
    nullable: true,
    minimum: 1,
    maximum: MUTE_UNTIL_MAX,
  })
  // `null` is a real instruction (unmute), so it skips the numeric checks rather than failing them.
  // A missing field is NOT null, so it still falls through to @IsInt and is rejected with a 400.
  @ValidateIf((o: MuteChatDto) => o.muteUntil !== null)
  @IsInt()
  @Min(1)
  @Max(MUTE_UNTIL_MAX)
  muteUntil!: number | null;
}
