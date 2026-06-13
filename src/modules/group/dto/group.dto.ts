import { ApiProperty } from '@nestjs/swagger';
import { IsArray, ArrayNotEmpty, IsString, IsNotEmpty } from 'class-validator';

export class CreateGroupDto {
  @ApiProperty({ description: 'Group subject/name' })
  @IsString()
  @IsNotEmpty()
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
  @ApiProperty({ description: 'New group subject/name' })
  @IsString()
  @IsNotEmpty()
  subject: string;
}

export class GroupDescriptionDto {
  @ApiProperty({ description: 'New group description (may be empty to clear it)' })
  @IsString()
  description: string;
}
