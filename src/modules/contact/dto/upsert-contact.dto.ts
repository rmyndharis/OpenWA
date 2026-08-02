import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpsertContactDto {
  @ApiPropertyOptional({ description: 'Full display name to save for this contact' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  fullName?: string;

  @ApiPropertyOptional({ description: 'First name to save for this contact' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  firstName?: string;
}
