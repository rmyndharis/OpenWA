import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ToStrictString } from '../../../common/utils/strict-boolean';

export class CreateChannelDto {
  @ApiProperty({ description: 'Channel name', example: 'Product updates', maxLength: 100 })
  @ToStrictString()
  @IsString()
  @IsNotEmpty()
  // Bounds a runaway payload rather than mirroring a protocol limit; WhatsApp's own editor stops
  // well short of this.
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    description: 'Channel description',
    example: 'Release notes and downtime notices',
    maxLength: 2048,
  })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxLength(2048)
  description?: string;
}
