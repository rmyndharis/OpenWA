import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import { MESSAGE_TEXT_MAX_LENGTH } from './send-message.dto';

export const CTA_BUTTON_TEXT_MAX_LENGTH = 128;
export const CTA_HEADER_MAX_LENGTH = 128;
export const CTA_FOOTER_MAX_LENGTH = 128;

export class SendInteractiveCtaDto {
  @ApiProperty({
    description: 'WhatsApp chat ID (phone@c.us for individual, groupId@g.us for groups)',
    example: '628123456789@c.us',
  })
  @IsString()
  @IsNotEmpty()
  chatId!: string;

  @ApiProperty({
    description: 'Message body text',
    example: 'Check out our latest product launch and exclusive discounts!',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(MESSAGE_TEXT_MAX_LENGTH)
  body!: string;

  @ApiProperty({
    description: 'Text label shown on the CTA button',
    example: 'Visit Website',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(CTA_BUTTON_TEXT_MAX_LENGTH)
  displayText!: string;

  @ApiProperty({
    description: 'Destination URL opened when recipient taps the CTA button',
    example: 'https://example.com/promo',
  })
  @IsUrl({ require_protocol: true })
  @IsNotEmpty()
  url!: string;

  @ApiPropertyOptional({
    description: 'Optional merchant / redirect URL',
    example: 'https://example.com/store',
  })
  @IsOptional()
  @IsUrl({ require_protocol: true })
  merchantUrl?: string;

  @ApiPropertyOptional({
    description: 'Optional header text displayed above the body',
    example: 'Special Announcement',
  })
  @IsOptional()
  @IsString()
  @MaxLength(CTA_HEADER_MAX_LENGTH)
  header?: string;

  @ApiPropertyOptional({
    description: 'Optional footer text displayed below the body',
    example: 'Terms and conditions apply',
  })
  @IsOptional()
  @IsString()
  @MaxLength(CTA_FOOTER_MAX_LENGTH)
  footer?: string;

  @ApiPropertyOptional({
    description: 'Quoted message ID to reply to',
    example: 'false_628123456789@c.us_3EB01234567890ABCDEF',
  })
  @IsOptional()
  @IsString()
  quotedMessageId?: string;
}

export const SEND_INTERACTIVE_CTA_BODY_EXAMPLES = {
  minimal: {
    summary: 'Send an interactive CTA URL message',
    value: {
      chatId: '628123456789@c.us',
      body: 'Check out our latest product launch and exclusive discounts!',
      displayText: 'Visit Website',
      url: 'https://example.com/promo',
    },
  },
};
