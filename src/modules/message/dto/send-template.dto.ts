import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsObject, ValidateIf } from 'class-validator';

export class SendTemplateMessageDto {
  @ApiProperty({
    description: 'WhatsApp chat ID (phone@c.us for individual, groupId@g.us for groups)',
    example: '628123456789@c.us',
  })
  @IsString()
  @IsNotEmpty()
  chatId!: string;

  @ApiPropertyOptional({
    description: 'Template ID to render. Provide either templateId or templateName.',
    example: 'b1c2d3e4-f5a6-7890-bcde-f01234567890',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @ValidateIf((o: SendTemplateMessageDto) => !o.templateName)
  templateId?: string;

  @ApiPropertyOptional({
    description: 'Template name to render. Provide either templateId or templateName.',
    example: 'order-confirmation',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @ValidateIf((o: SendTemplateMessageDto) => !o.templateId)
  templateName?: string;

  @ApiPropertyOptional({
    description: 'Variables substituted into {{placeholder}} tokens in the template',
    example: { customer: 'Alice', orderId: '1234' },
  })
  @IsOptional()
  @IsObject()
  vars?: Record<string, string>;
}
