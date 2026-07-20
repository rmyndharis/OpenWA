import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, MaxLength, MinLength, Matches, IsIn, IsUrl } from 'class-validator';

export class CreateSessionDto {
  @ApiProperty({
    description: 'Unique name for the session (alphanumeric and hyphens only)',
    example: 'my-bot',
    minLength: 3,
    maxLength: 50,
  })
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  @Matches(/^[a-zA-Z0-9-]+$/, {
    message: 'Session name can only contain letters, numbers, and hyphens',
  })
  name: string;

  @ApiPropertyOptional({
    description:
      'Session configuration options. Set autoRejectCalls (boolean, default false) to ' +
      'automatically reject incoming calls — the call.received event is still emitted.',
    example: { autoReconnect: true },
  })
  @IsOptional()
  config?: Record<string, unknown>;

  // Phase 3: Proxy per session
  @ApiPropertyOptional({
    description:
      'Optional per-session egress proxy URL (http/https/socks4/socks5; credentialed form ' +
      '"http://user:pass@host" allowed). Must be a REAL, REACHABLE proxy — an unreachable value ' +
      'silently blocks the WhatsApp WebSocket (no QR is ever delivered) and the session start times ' +
      'out (~30s → 504 Gateway Timeout). Leave unset unless your network cannot reach WhatsApp directly.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  // Reject a malformed/non-proxy URL at the boundary (credentialed http://user:pass@host and
  // socks4/5 still validate). The host is intentionally NOT SSRF-blocked here — a per-session proxy
  // is operator-chosen egress, and a loopback proxy sidecar is a legitimate setup.
  // require_tld:false + allow_underscores:true so single-label container hostnames (e.g. `squid`,
  // `localhost`) and IP-literal proxies validate, matching the engine's URL-parse check.
  @IsUrl(
    {
      protocols: ['http', 'https', 'socks4', 'socks5'],
      require_protocol: true,
      require_tld: false,
      allow_underscores: true,
    },
    { message: 'proxyUrl must be a valid http(s)/socks4/socks5 URL' },
  )
  proxyUrl?: string;

  @ApiPropertyOptional({
    description: 'Proxy type',
    enum: ['http', 'https', 'socks4', 'socks5'],
    example: 'http',
  })
  @IsOptional()
  @IsIn(['http', 'https', 'socks4', 'socks5'])
  proxyType?: 'http' | 'https' | 'socks4' | 'socks5';
}
