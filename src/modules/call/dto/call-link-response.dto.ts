import { ApiProperty } from '@nestjs/swagger';

export class CallLinkResponseDto {
  @ApiProperty({
    description: 'The shareable WhatsApp call link.',
    example: 'https://call.whatsapp.com/video/XxXxXxXxXxXxXx',
  })
  link!: string;
}
