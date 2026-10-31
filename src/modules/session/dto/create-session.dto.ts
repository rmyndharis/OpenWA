import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsObject, IsOptional, IsString, IsUrl, Matches, MaxLength, MinLength, Validate } from 'class-validator';
import { ToStrictString } from '../../../common/utils/strict-boolean';
import { MaxCodePoints } from '../../../common/validation/max-code-points';
import { HasDecodableProxyCredentialsConstraint } from './has-decodable-proxy-credentials.validator';
import { normaliseSessionConfig, RecognisedSessionConfigConstraint } from './recognised-session-config.validator';

export class CreateSessionDto {
  @ApiProperty({
    description: 'Unique name for the session (alphanumeric and hyphens only)',
    example: 'my-bot',
    minLength: 3,
    maxLength: 50,
  })
  @ToStrictString()
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  @Matches(/^[a-zA-Z0-9-]+$/, {
    message: 'Session name can only contain letters, numbers, and hyphens',
  })
  name!: string;

  @ApiPropertyOptional({
    description:
      'Session configuration. Only three keys are read: autoRejectCalls (boolean, default false, ' +
      'Baileys engine only) rejects incoming calls as soon as they ring, and the call.received event is still emitted ' +
      'first; maxReconnectAttempts (0-20, default unlimited) caps consecutive reconnects (the count ' +
      'restarts once the session has stayed READY for 5 minutes) and ' +
      'reconnectBaseDelay (1000-300000 ms, default 5000) sets the backoff base, both for the ' +
      "gateway's own reconnect only (on Baileys the engine retries a transient drop itself, with a " +
      'fixed backoff and no cap). Anything else is ' +
      'stored but ignored. All three can be changed later with PATCH /api/sessions/{sessionId}/config ' +
      'without a restart: autoRejectCalls applies from the next incoming call, the two reconnect settings ' +
      'from the next session start.',
    example: { autoRejectCalls: false, maxReconnectAttempts: 5, reconnectBaseDelay: 5000 },
  })
  @Transform(({ value }) => normaliseSessionConfig(value))
  @IsOptional()
  @IsObject()
  @Validate(RecognisedSessionConfigConstraint)
  config?: Record<string, unknown>;

  // Phase 3: Proxy per session
  @ApiPropertyOptional({
    description:
      'Optional per-session egress proxy URL (http/https/socks4/socks5; credentialed form ' +
      '"http://user:pass@host" allowed). Must be a REAL, REACHABLE proxy — an unreachable value ' +
      'silently blocks the WhatsApp WebSocket (no QR is ever delivered). On whatsapp-web.js the session ' +
      'start then times out (~30s → 504 Gateway Timeout); on Baileys the start succeeds and the session ' +
      'keeps retrying the connection. Leave unset unless your network cannot reach WhatsApp directly. ' +
      'Setting it requires an ADMIN key (403 otherwise).',
    maxLength: 255,
  })
  @IsOptional()
  @ToStrictString()
  @IsString()
  @MaxCodePoints(255)
  // Reject a malformed/non-proxy URL at the boundary (credentialed http://user:pass@host and
  // socks4/5 still validate). The host is intentionally NOT SSRF-blocked here — a per-session proxy
  // is trusted egress that only an ADMIN key may set, and a loopback proxy sidecar is a legitimate setup.
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
  @Validate(HasDecodableProxyCredentialsConstraint)
  proxyUrl?: string;

  @ApiPropertyOptional({
    description: 'Deprecated and ignored: the proxyUrl scheme selects the proxy protocol. Accepted for compatibility.',
    enum: ['http', 'https', 'socks4', 'socks5'],
    deprecated: true,
  })
  @IsOptional()
  @IsIn(['http', 'https', 'socks4', 'socks5'])
  proxyType?: 'http' | 'https' | 'socks4' | 'socks5';
}
