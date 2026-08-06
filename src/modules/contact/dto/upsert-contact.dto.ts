import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Cap on each addressbook name part. Mirrors CONTACT_NAME_MAX_LENGTH on the send-contact DTO. */
export const ADDRESSBOOK_NAME_MAX_LENGTH = 100;

export class UpsertContactDto {
  @ApiProperty({ description: "The contact's first name.", maxLength: ADDRESSBOOK_NAME_MAX_LENGTH })
  @IsString()
  @MinLength(1)
  @MaxLength(ADDRESSBOOK_NAME_MAX_LENGTH)
  firstName!: string;

  @ApiPropertyOptional({
    description: "The contact's last name. Omit for a single-name contact — WhatsApp allows those.",
    maxLength: ADDRESSBOOK_NAME_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(ADDRESSBOOK_NAME_MAX_LENGTH)
  lastName?: string;
}
