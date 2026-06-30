import { ApiProperty } from '@nestjs/swagger';
import { IsArray, ArrayNotEmpty, IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class CreateGroupDto {
  @ApiProperty({ description: 'Group subject/name', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({ description: 'Participant WhatsApp IDs (e.g. 628123456789@c.us)', type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  participants: string[];
}

export class ParticipantsDto {
  @ApiProperty({ description: 'Participant WhatsApp IDs (e.g. 628123456789@c.us)', type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  participants: string[];
}

export class GroupSubjectDto {
  @ApiProperty({ description: 'New group subject/name', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  subject: string;
}

export class GroupDescriptionDto {
  @ApiProperty({ description: 'New group description (may be empty to clear it)', maxLength: 1024 })
  @IsString()
  @MaxLength(1024)
  description: string;
}
