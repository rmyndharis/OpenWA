import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class DemoteChannelAdminDto {
  @ApiProperty({
    description:
      'WhatsApp ID of the admin to demote back to a subscriber — a phone number, `<phone>@c.us` ' +
      'or `<lid>@lid`; a bare number is qualified for you. Anything that does not name an ' +
      'individual is rejected with 400 rather than handed to WhatsApp.',
    example: '628123456789@c.us',
  })
  @IsString()
  @IsNotEmpty()
  userId!: string;
}
