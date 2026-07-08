import { IsBoolean, IsNotEmpty, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IngressUrl } from '../ingress-url';

// Safe charset: also prevents an instanceId containing ':' (which would collide the P1 ordering key).
const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export class CreateInstanceDto {
  @ApiProperty({
    description:
      'Operator-chosen instance id (unique within the plugin). Namespaces the ingress URL and the instance secret.',
    example: 'chatwoot-prod-1',
  })
  @IsString()
  @Matches(INSTANCE_ID_PATTERN, { message: 'instanceId must match ^[a-zA-Z0-9_-]{1,64}$' })
  instanceId: string;

  @ApiPropertyOptional({
    description: 'Session id the instance is scoped to. Omit for all sessions.',
    example: '8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'sessionScope must not be empty (omit it for all sessions)' })
  @MaxLength(256)
  sessionScope?: string;

  @ApiPropertyOptional({
    description: 'Token echoed back for the provider webhook verification handshake. Auto-generated when omitted.',
    example: 'a1b2c3d4e5f6',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  verifyToken?: string;

  // Operator-supplied ingress HMAC secret (e.g. the provider's webhook secret). When present it must be
  // a real value (>= 16 chars) — an empty/short secret would make the public ingress signature forgeable.
  // Omit to auto-generate a random 64-hex secret.
  @ApiPropertyOptional({
    description:
      'Ingress HMAC secret shared with the provider. Omit to auto-generate a random 64-hex secret. Masked (****) on every read.',
    writeOnly: true,
    example: 'super-secret-provider-webhook-key',
  })
  @IsOptional()
  @IsString()
  @MinLength(16, { message: 'secret must be at least 16 characters' })
  @MaxLength(512)
  secret?: string;

  @ApiPropertyOptional({
    description: 'Per-instance config slice passed to the adapter (shape defined by the plugin).',
    example: { apiKey: 'chatwoot-key', inboxId: 42 },
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class UpdateInstanceDto {
  @ApiPropertyOptional({
    description: 'Whether the instance is enabled (ingress accepted, dispatch active).',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Session id the instance is scoped to. Omit for all sessions.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'sessionScope must not be empty (omit it for all sessions)' })
  @MaxLength(256)
  sessionScope?: string;

  @ApiPropertyOptional({ description: 'Per-instance config slice passed to the adapter.' })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

// A class (not an interface) so @nestjs/swagger can reflect it into the published spec — the
// integration-instance responses are otherwise opaque to generated clients.
export class InstanceView {
  @ApiProperty({ description: 'Instance row id.' })
  id: string;

  @ApiProperty({ description: 'Plugin id this instance belongs to.' })
  pluginId: string;

  @ApiProperty({ description: 'Operator-chosen instance id (unique within the plugin).' })
  instanceId: string;

  @ApiPropertyOptional({
    description: 'Session id the instance is scoped to, or null for all sessions.',
    nullable: true,
  })
  sessionScope: string | null;

  @ApiProperty({
    description:
      "Ingress HMAC secret. Masked ('***') on every read; plaintext returned only once on create/regenerate-secret.",
  })
  secret: string;

  @ApiPropertyOptional({
    description: "Provider verify-token. Masked ('***') on reads when set; plaintext on create/regenerate-secret.",
    nullable: true,
  })
  verifyToken: string | null;

  @ApiPropertyOptional({
    description: 'Per-instance config slice passed to the adapter, or null.',
    nullable: true,
    type: Object,
  })
  config: Record<string, unknown> | null;

  @ApiProperty({ description: 'Whether ingress is accepted and dispatch is active.' })
  enabled: boolean;

  @ApiProperty({ description: 'Creation timestamp.' })
  createdAt: Date;

  @ApiProperty({ description: 'Last update timestamp.' })
  updatedAt: Date;

  @ApiProperty({
    description: 'Ingress URLs the provider posts webhook deliveries to.',
    type: () => IngressUrl,
    isArray: true,
  })
  ingressUrls: IngressUrl[];
}

export type MintedInstance = InstanceView; // identical shape; `secret` carries the plaintext once
