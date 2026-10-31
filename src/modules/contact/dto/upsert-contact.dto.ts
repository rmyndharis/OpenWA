import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ToStrictString } from '../../../common/utils/strict-boolean';

/** Cap on each addressbook name part. Independent of CONTACT_NAME_MAX_LENGTH (255) on the send-contact DTO. */
export const ADDRESSBOOK_NAME_MAX_LENGTH = 100;

export class UpsertContactDto {
  @ApiProperty({ description: "The contact's first name.", minLength: 1, maxLength: ADDRESSBOOK_NAME_MAX_LENGTH })
  @ToStrictString()
  @IsString()
  @MinLength(1)
  @MaxLength(ADDRESSBOOK_NAME_MAX_LENGTH)
  firstName!: string;

  @ApiPropertyOptional({
    description: "The contact's last name. Omit for a single-name contact — WhatsApp allows those.",
    maxLength: ADDRESSBOOK_NAME_MAX_LENGTH,
  })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(ADDRESSBOOK_NAME_MAX_LENGTH)
  lastName?: string;
}
