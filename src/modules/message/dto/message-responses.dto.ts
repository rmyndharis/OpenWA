import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { MessageType } from '../../../engine/interfaces/whatsapp-engine.interface';
import type { ChatKind } from '../../../engine/identity/wa-id';
import { MessageDirection, MessageStatus } from '../entities/message.entity';

/**
 * Response shapes for the message read/action routes — the raw handler value, no envelope.
 * Decorated properties avoid named utility types: emitDecoratorMetadata wraps a named type in a
 * runtime guard whose other arm can never execute, leaving an uncoverable branch.
 */

const MESSAGE_TYPES: MessageType[] = [
  'text',
  'image',
  'video',
  'audio',
  'voice',
  'document',
  'sticker',
  'location',
  'contact',
  'poll',
  'call',
  'revoked',
  'order',
  'product',
  'masked',
  'unknown',
];

const CHAT_KINDS: ChatKind[] = ['individual', 'group', 'channel', 'status', 'broadcast', 'unknown'];

export class MessageActionResponseDto {
  @ApiProperty({ description: 'Always true — a failure is reported as a non-2xx status, not as false.', example: true })
  success!: boolean;
}

/** OpenAPI mirror of the persisted `Message` row served by the list route. */
export class MessageListItemDto {
  @ApiProperty({ example: '0a941dac-a965-45e7-b318-74ae8be134f0' })
  id!: string;

  @ApiProperty({ example: '0a941dac-a965-45e7-b318-74ae8be134f0' })
  sessionId!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'WhatsApp message id, once the engine has assigned one.',
    example: 'true_628123456789@c.us_3EB0123456789',
  })
  waMessageId?: string | null;

  @ApiProperty({ example: '628123456789@c.us' })
  chatId!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Human-readable chat name when known (contact pushName, group subject).',
    example: 'Alice',
  })
  chatName?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Group participant who posted the message (`from` is the group JID there).',
    example: '628123456789@c.us',
  })
  author?: string | null;

  @ApiProperty({ example: '628123456789@c.us' })
  from!: string;

  @ApiProperty({ example: '628987654321@c.us' })
  to!: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Message text body.', example: 'hi' })
  body?: string | null;

  @ApiProperty({ description: 'Engine-neutral message type.', example: 'text' })
  type!: string;

  @ApiProperty({ enum: MessageDirection, example: MessageDirection.INCOMING })
  direction!: MessageDirection;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Unix seconds the message was sent, when the engine reported one.',
    example: 1700000010,
  })
  timestamp?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Engine-specific extras (media inline copy, poll data, …). Absent when none were stored.',
    additionalProperties: true,
  })
  metadata?: { [key: string]: unknown } | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Storage key of the archived media, when one was archived.',
  })
  mediaPath?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Mimetype of the archived media.' })
  mediaMimetype?: string | null;

  @ApiProperty({ enum: MessageStatus, example: MessageStatus.DELIVERED })
  status!: MessageStatus;

  @ApiProperty({ type: String, format: 'date-time', example: '2026-08-13T09:00:00Z' })
  createdAt!: Date;
}

export class MessageListResponseDto {
  @ApiProperty({ type: [MessageListItemDto], description: 'Newest first.' })
  messages!: MessageListItemDto[];

  @ApiProperty({ description: 'Total rows matching the filters (before pagination).', example: 132 })
  total!: number;
}

/** Synchronous sender-contact fields carried on a history message (see the engine `MessageContact`). */
export class ChatHistoryContactDto {
  @ApiPropertyOptional({ description: 'Sender JID (`…@c.us` or a `…@lid` privacy id).', example: '628123456789@c.us' })
  id?: string;

  @ApiPropertyOptional({ description: 'Phone digits, best-effort.', example: '628123456789' })
  number?: string;

  @ApiPropertyOptional({ example: 'Alice' })
  name?: string;

  @ApiPropertyOptional({ example: 'Alice' })
  pushName?: string;

  @ApiPropertyOptional({ example: 'Al' })
  shortName?: string;

  @ApiPropertyOptional({ description: 'Engine contact type token.', example: 'in' })
  type?: string;

  @ApiPropertyOptional({ description: 'Saved in the account address book.', example: true })
  isMyContact?: boolean;

  @ApiPropertyOptional({ description: 'Is a WhatsApp user.', example: true })
  isWAContact?: boolean;

  @ApiPropertyOptional({ example: false })
  isBusiness?: boolean;

  @ApiPropertyOptional({ example: false })
  isEnterprise?: boolean;

  @ApiPropertyOptional({ description: 'Business verified name.' })
  verifiedName?: string;

  @ApiPropertyOptional({ description: 'Business verification level.', example: 2 })
  verifiedLevel?: number;

  @ApiPropertyOptional({ example: false })
  isBlocked?: boolean;

  @ApiPropertyOptional({ type: [String], description: 'Label ids (CRM); names are not resolved.' })
  labels?: string[];
}

export class ChatHistoryMediaDto {
  @ApiProperty({ example: 'image/jpeg' })
  mimetype!: string;

  @ApiPropertyOptional({ example: 'photo.jpg' })
  filename?: string;

  @ApiPropertyOptional({ description: 'Base64 payload; absent when the blob was omitted.' })
  data?: string;

  @ApiPropertyOptional({ description: 'True when the blob was dropped by a size cap, timeout, or saturation.' })
  omitted?: boolean;

  @ApiPropertyOptional({ description: 'Decoded byte size of the media; always set when omitted.', example: 102400 })
  sizeBytes?: number;
}

export class ChatHistoryQuotedMessageDto {
  @ApiProperty({ example: 'true_628123456789@c.us_3EB0123456789' })
  id!: string;

  @ApiProperty({ example: 'original text' })
  body!: string;
}

export class ChatHistoryLocationDto {
  @ApiProperty({ example: -6.2088 })
  latitude!: number;

  @ApiProperty({ example: 106.8456 })
  longitude!: number;

  @ApiPropertyOptional({ example: 'Monas' })
  description?: string;

  @ApiPropertyOptional({ example: 'Jakarta' })
  address?: string;

  @ApiPropertyOptional({ example: 'https://maps.example.com/…' })
  url?: string;
}

export class ChatHistoryCallDto {
  @ApiProperty({ description: 'Video (true) vs voice (false) call.', example: false })
  video!: boolean;

  @ApiProperty({ description: 'Whether an incoming call went unanswered.', example: true })
  missed!: boolean;
}

export class ChatHistoryOrderDto {
  @ApiProperty({
    description: 'Id of the cart the customer placed from the business catalog.',
    example: '1000000000000001',
  })
  orderId!: string;

  @ApiPropertyOptional({
    description: 'Opaque single-order credential that accompanies `orderId`. Pass through unchanged; do not log it.',
  })
  token?: string;
}

export class ChatHistoryProductDto {
  @ApiProperty({ description: 'Id of the shared catalog product.', example: '2000000000000002' })
  productId!: string;

  @ApiPropertyOptional({ example: 'Sample product' })
  title?: string;

  @ApiPropertyOptional({ example: 'A sample product description.' })
  description?: string;

  @ApiPropertyOptional({ description: "JID of the catalog's owner.", example: '628123456789@c.us' })
  businessOwnerJid?: string;
}

/** OpenAPI mirror of the engine `IncomingMessage` served by the live chat-history route. */
export class ChatHistoryMessageDto {
  @ApiProperty({ example: 'true_628123456789@c.us_3EB0123456789' })
  id!: string;

  @ApiProperty({ example: '628123456789@c.us' })
  from!: string;

  @ApiProperty({ example: '628987654321@c.us' })
  to!: string;

  @ApiProperty({ example: '628123456789@c.us' })
  chatId!: string;

  @ApiProperty({ example: 'hi' })
  body!: string;

  @ApiProperty({ enum: MESSAGE_TYPES, description: 'Engine-neutral message type.', example: 'text' })
  type!: MessageType;

  @ApiProperty({ description: 'Unix seconds the message was sent.', example: 1700000010 })
  timestamp!: number;

  @ApiProperty({ example: false })
  fromMe!: boolean;

  @ApiProperty({ example: false })
  isGroup!: boolean;

  @ApiProperty({ enum: CHAT_KINDS, description: 'User-facing chat kind of the conversation.', example: 'individual' })
  kind!: ChatKind;

  @ApiPropertyOptional({ description: 'True for a status/story broadcast.', example: false })
  isStatusBroadcast?: boolean;

  @ApiPropertyOptional({ description: 'Disappearing-messages timer in seconds; 0 or absent means off.', example: 0 })
  ephemeralDuration?: number;

  @ApiPropertyOptional({
    description: 'Group participant who actually sent it (`from` is the group JID there).',
    example: '628123456789@c.us',
  })
  author?: string;

  @ApiPropertyOptional({ type: [String], description: 'WIDs @mentioned in the message.' })
  mentionedIds?: string[];

  @ApiPropertyOptional({ type: ChatHistoryCallDto, description: 'Set for `call` messages.' })
  call?: ChatHistoryCallDto;

  @ApiPropertyOptional({ description: 'Sender is identified by a privacy id rather than a phone number.' })
  isLidSender?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Best-effort phone digits of a privacy-id sender, when resolved.',
    example: null,
  })
  senderPhone?: string | null;

  @ApiPropertyOptional({ type: ChatHistoryContactDto, description: 'Sender contact info, best-effort.' })
  contact?: ChatHistoryContactDto;

  @ApiPropertyOptional({ description: 'Text-status background as `#RRGGBB`.', example: '#FF5733' })
  backgroundColor?: string;

  @ApiPropertyOptional({ description: 'Text-status WhatsApp font index.', example: 1 })
  font?: number;

  @ApiPropertyOptional({ type: ChatHistoryMediaDto })
  media?: ChatHistoryMediaDto;

  @ApiPropertyOptional({ type: ChatHistoryQuotedMessageDto })
  quotedMessage?: ChatHistoryQuotedMessageDto;

  @ApiPropertyOptional({ type: ChatHistoryLocationDto })
  location?: ChatHistoryLocationDto;

  @ApiPropertyOptional({ type: ChatHistoryOrderDto, description: 'Set for `order` messages.' })
  order?: ChatHistoryOrderDto;

  @ApiPropertyOptional({ type: ChatHistoryProductDto, description: 'Set for `product` messages.' })
  product?: ChatHistoryProductDto;
}

export class MessageReactionSenderDto {
  @ApiProperty({ example: '628123456789@c.us' })
  senderId!: string;

  @ApiProperty({ example: '👍' })
  emoji!: string;

  @ApiProperty({ description: 'Unix seconds the reaction was placed.', example: 1700000010 })
  timestamp!: number;
}

/** OpenAPI mirror of the engine `MessageReaction` served by the reactions route. */
export class MessageReactionDto {
  @ApiProperty({ description: 'The emoji this entry groups.', example: '👍' })
  emoji!: string;

  @ApiProperty({ type: [MessageReactionSenderDto], description: 'Who placed this emoji.' })
  senders!: MessageReactionSenderDto[];
}
