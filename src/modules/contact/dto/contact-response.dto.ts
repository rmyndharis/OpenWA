import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response shapes for the contacts routes. These describe what the handlers already return —
 * the payload is the raw handler value, not an envelope — so that a change to the shape shows up
 * as a diff in the committed OpenAPI snapshot instead of reaching clients unannounced.
 */
export class ContactDto {
  @ApiProperty({
    description:
      "Contact id in the active engine's native format. On Baileys this is frequently an `@lid` " +
      'rather than a phone-number JID; use GET /contacts/{contactId}/phone to resolve one.',
    example: '628123456789@c.us',
  })
  id!: string;

  @ApiPropertyOptional({
    description: "The name from the account's own addressbook. Absent for a contact that was never saved.",
    example: 'Ada Lovelace',
  })
  name?: string;

  @ApiPropertyOptional({
    description: 'The display name the contact set for themselves. Present even when the contact is not saved.',
    example: 'Ada',
  })
  pushName?: string;

  @ApiProperty({ description: 'MSISDN digits, without a leading + or any separators.', example: '628123456789' })
  number!: string;

  @ApiProperty({ description: "Whether the entry exists in the account's addressbook.", example: true })
  isMyContact!: boolean;

  @ApiProperty({ description: 'Whether this account has blocked the contact.', example: false })
  isBlocked!: boolean;

  @ApiPropertyOptional({
    description: 'Profile picture URL. Absent when the contact has none or their privacy settings hide it.',
    example: 'https://pps.whatsapp.net/v/t61.24694-24/12345_678_910_n.jpg',
  })
  profilePicUrl?: string;
}

export class ProfilePictureResponseDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Profile picture URL, or null when the contact has none or their privacy settings hide it.',
    example: 'https://pps.whatsapp.net/v/t61.24694-24/12345_678_910_n.jpg',
  })
  url!: string | null;
}

export class ProfilePicturesResponseDto {
  @ApiProperty({
    description:
      'Map of the requested contact ids to their picture URL. An id resolves to null when the ' +
      'contact has no picture, hides it, or its individual lookup failed — a per-id failure does ' +
      'not fail the batch. Ids beyond the first 50 are not looked up and are absent from the map.',
    example: { '628123456789@c.us': 'https://pps.whatsapp.net/v/t61.24694-24/12345_678_910_n.jpg' },
    additionalProperties: { type: 'string', nullable: true },
  })
  // An inline index signature, not Record<>: emitDecoratorMetadata wraps a NAMED type in a
  // `typeof X !== "undefined" && X ? … : Object` runtime guard, and since a type-only name is never
  // a value one arm of that guard can never execute — an uncoverable branch in every DTO that uses one.
  pictures!: { [contactId: string]: string | null };
}

export class NumberCheckResponseDto {
  @ApiProperty({ description: 'The number exactly as supplied in the path.', example: '628123456789' })
  number!: string;

  @ApiProperty({ description: 'Whether the number is a registered WhatsApp account.', example: true })
  exists!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "The canonical chat id in the engine's native format, or null when the number is not registered.",
    example: '628123456789@c.us',
  })
  whatsappId!: string | null;
}

export class ResolvedPhoneResponseDto {
  @ApiProperty({ description: 'The contact id exactly as supplied in the path.', example: '12345678901234@lid' })
  contactId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'MSISDN digits for the contact, or null when the engine has not learned the mapping. ' +
      'Best-effort: a null here is not a statement that the contact has no number.',
    example: '628123456789',
  })
  phone!: string | null;
}

export class ContactAckResponseDto {
  @ApiProperty({ description: 'Always true — a failure is reported as a non-2xx status, not as false.', example: true })
  success!: boolean;

  @ApiProperty({ description: 'Human-readable confirmation of what was done.', example: 'Contact saved' })
  message!: string;
}
