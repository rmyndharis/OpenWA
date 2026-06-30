import {
  IsString,
  IsOptional,
  ValidateNested,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  Matches,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

class StatusMediaInput {
  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsString()
  base64?: string;

  @IsOptional()
  @IsString()
  mimetype?: string;
}

export class SendImageStatusDto {
  @ValidateNested()
  @Type(() => StatusMediaInput)
  image: StatusMediaInput;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  caption?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(256)
  @IsString({ each: true })
  @Matches(/^\d+@(c\.us|lid)$/, { each: true, message: 'Invalid recipient JID' })
  recipients: string[];
}

export class SendVideoStatusDto {
  @ValidateNested()
  @Type(() => StatusMediaInput)
  video: StatusMediaInput;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  caption?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(256)
  @IsString({ each: true })
  @Matches(/^\d+@(c\.us|lid)$/, { each: true, message: 'Invalid recipient JID' })
  recipients: string[];
}
