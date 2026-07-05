import { IsBoolean, IsNotEmpty, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { IngressUrl } from '../ingress-url';

// Safe charset: also prevents an instanceId containing ':' (which would collide the P1 ordering key).
const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export class CreateInstanceDto {
  @IsString()
  @Matches(INSTANCE_ID_PATTERN, { message: 'instanceId must match ^[a-zA-Z0-9_-]{1,64}$' })
  instanceId: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'sessionScope must not be empty (omit it for all sessions)' })
  @MaxLength(256)
  sessionScope?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  verifyToken?: string;

  // Operator-supplied ingress HMAC secret (e.g. the provider's webhook secret). When present it must be
  // a real value (>= 16 chars) — an empty/short secret would make the public ingress signature forgeable.
  // Omit to auto-generate a random 64-hex secret.
  @IsOptional()
  @IsString()
  @MinLength(16, { message: 'secret must be at least 16 characters' })
  @MaxLength(512)
  secret?: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export class UpdateInstanceDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'sessionScope must not be empty (omit it for all sessions)' })
  @MaxLength(256)
  sessionScope?: string;

  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}

export interface InstanceView {
  id: string;
  pluginId: string;
  instanceId: string;
  sessionScope: string | null;
  secret: string; // masked ('***') on reads
  verifyToken: string | null; // masked ('***') on reads when set
  config: Record<string, unknown> | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  ingressUrls: IngressUrl[];
}

export type MintedInstance = InstanceView; // identical shape; `secret` carries the plaintext once
