import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class RequestPairingCodeDto {
  @ApiProperty({
    description: 'Phone number to link, digits only in international format (country code + number).',
    example: '628123456789',
  })
  @IsString()
  @IsNotEmpty()
  // Digits only (no +, spaces, or dashes); 6–15 digits covers E.164.
  @Matches(/^[0-9]{6,15}$/, {
    message: 'phoneNumber must be digits only in international format (country code + number), e.g. 628123456789',
  })
  phoneNumber: string;
}

export class PairingCodeResponseDto {
  @ApiProperty({ description: 'The 8-character pairing code to enter in WhatsApp.', example: 'ABCD1234' })
  pairingCode: string;

  @ApiProperty({ description: 'Current session status.', example: 'qr_ready' })
  status: string;
}
