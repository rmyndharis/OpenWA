import {
  IsString,
  IsOptional,
  IsInt,
  Min,
  Max,
  Matches,
  MaxLength,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';

export class SendTextStatusDto {
  @IsString()
  @MaxLength(4096)
  text: string;

  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'backgroundColor must be a hex color (e.g., #25D366)' })
  backgroundColor?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  font?: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(256)
  @IsString({ each: true })
  @Matches(/^\d+@(c\.us|lid)$/, { each: true, message: 'Invalid recipient JID' })
  recipients: string[];
}
