import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateChannelDto {
  @ApiProperty({ description: 'Channel name', example: 'Product updates', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  // Bounds a runaway payload rather than mirroring a protocol limit; WhatsApp's own editor stops
  // well short of this.
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ description: 'Channel description', example: 'Release notes and downtime notices' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  description?: string;
}
