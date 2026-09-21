import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, MaxLength, Validate } from 'class-validator';
import { HasDecodableProxyCredentialsConstraint } from './has-decodable-proxy-credentials.validator';
import type { Session } from '../entities/session.entity';

export type SessionProxyType = 'http' | 'https' | 'socks4' | 'socks5';

const PROTOCOL_TO_PROXY_TYPE: Record<string, SessionProxyType> = {
  'http:': 'http',
  'https:': 'https',
  'socks4:': 'socks4',
  'socks5:': 'socks5',
};

function proxyTypeFromProtocol(protocol: string): SessionProxyType | null {
  return PROTOCOL_TO_PROXY_TYPE[protocol] ?? null;
}

export class SessionProxyResponseDto {
  @ApiProperty({ description: 'Whether a proxy URL is configured for this session', example: true })
  enabled!: boolean;

  @ApiProperty({
    description: 'Proxy protocol derived from the stored URL scheme; `null` when no proxy is set',
    // `null` is IN the enum on purpose. This is an OpenAPI 3.0 document, where `nullable: true`
    // does not widen an enum: a strict validator checks the value against the list and rejects
    // `null` for not being on it. Every session without a proxy answers exactly that, so the most
    // ordinary response on this route contradicted its own schema.
    enum: ['http', 'https', 'socks4', 'socks5', null],
    nullable: true,
    example: 'http',
  })
  proxyType!: SessionProxyType | null;

  @ApiProperty({
    description: 'Proxy host:port parsed from the stored URL — credentials are never returned',
    // Explicit: `string | null` reflects as Object, which would publish this as `type: object`
    // and quietly disarm the cross-client type comparison in check:contract-shapes.
    type: String,
    nullable: true,
    example: 'proxy.example.com:8080',
  })
  proxyHost!: string | null;

  @ApiProperty({
    description: 'Whether the stored proxy URL embeds username/password credentials',
    example: false,
  })
  hasCredentials!: boolean;
}

export class UpdateSessionProxyDto {
  @ApiPropertyOptional({
    description:
      'Per-session egress proxy URL (http/https/socks4/socks5; credentialed form allowed). Send ' +
      '`null` to clear the proxy. Must be a real, reachable proxy — an unreachable value blocks the ' +
      'WhatsApp WebSocket and session start times out (~30s).',
    type: String,
    nullable: true,
    example: 'http://user:pass@proxy.example.com:8080',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @IsUrl(
    {
      protocols: ['http', 'https', 'socks4', 'socks5'],
      require_protocol: true,
      require_tld: false,
      allow_underscores: true,
    },
    { message: 'proxyUrl must be a valid http(s)/socks4/socks5 URL' },
  )
  @Validate(HasDecodableProxyCredentialsConstraint)
  proxyUrl?: string | null;
}

/** Project stored proxy columns onto a safe response — never returns credentials. */
export function projectSessionProxy(session: Pick<Session, 'proxyUrl'>): SessionProxyResponseDto {
  if (!session.proxyUrl) {
    return { enabled: false, proxyType: null, proxyHost: null, hasCredentials: false };
  }

  try {
    const parsed = new URL(session.proxyUrl);
    return {
      enabled: true,
      proxyType: proxyTypeFromProtocol(parsed.protocol),
      proxyHost: parsed.host,
      hasCredentials: !!(parsed.username || parsed.password),
    };
  } catch {
    return {
      enabled: true,
      proxyType: null,
      proxyHost: null,
      hasCredentials: false,
    };
  }
}
