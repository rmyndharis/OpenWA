import { Controller, Delete, Get, HttpCode, HttpStatus, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import {
  CapabilityAgnostic,
  CurrentApiKey,
  HeaderAuthOnly,
  Public,
  SignedOutProbe,
} from './decorators/auth.decorators';
import { ApiKey } from './entities/api-key.entity';
import { BrowserSessionLogoutResponseDto, BrowserSessionResponseDto } from './dto';
import { BrowserSessionService } from './browser-session.service';
import {
  assertBrowserCsrfSafe,
  extractBrowserSessionCookie,
  formatSessionClearCookie,
  formatSessionSetCookie,
  isSecureCookieRequest,
  rightmostHeaderEntry,
} from './browser-session.util';
import { EngineFactory } from '../../engine/engine.factory';
import { presentedApiKey } from '../../common/security/bearer-token';
import { resolveClientIp } from '../../common/utils/ip';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuthService } from './auth.service';
import { createLogger } from '../../common/services/logger.service';
import { apiKeyDeniedCapabilities } from './api-key-permissions';

@ApiTags('auth')
@Controller('auth')
export class BrowserSessionController {
  private readonly logger = createLogger('BrowserSessionController');
  private insecureCookieWarned = false;

  constructor(
    private readonly browserSessionService: BrowserSessionService,
    private readonly engineFactory: EngineFactory,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly authService: AuthService,
  ) {}

  // The client is resolved here rather than read from the guard, which skips the public logout route.
  private auditContext(req: Request, apiKey: ApiKey | undefined) {
    return {
      apiKey,
      ipAddress: resolveClientIp(req, this.configService.get<string[]>('security.trustedProxies') ?? []),
      userAgent: req.headers?.['user-agent'],
      method: req.method,
      path: req.path,
    };
  }

  private async revokeAndAudit(req: Request, token: string): Promise<void> {
    const ended = await this.browserSessionService.revokeByToken(token);
    if (!ended) return;
    // Filed under the key the session belonged to, which on a replacing login is not the caller's key. The revoke
    // has landed: a lookup that fails costs the row its key name, never the logout or the sign-in.
    const owner = await this.authService.findAuthorizationStates([ended.apiKeyId]).then(
      ([found]) => found,
      () => undefined,
    );
    await this.auditService.logInfo(AuditAction.BROWSER_SESSION_ENDED, {
      ...this.auditContext(req, owner ?? ({ id: ended.apiKeyId } as ApiKey)),
      metadata: { browserSessionId: ended.id },
    });
  }

  @Post('session')
  @CapabilityAgnostic()
  @HeaderAuthOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange an API key header for an HttpOnly browser session cookie' })
  @ApiHeader({ name: 'X-API-Key', description: 'API key to exchange for a browser session' })
  @ApiResponse({ status: 200, description: 'Browser session established', type: BrowserSessionResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid or missing API key header' })
  @ApiResponse({
    status: 403,
    description:
      'The key is valid but refused here: its allowedIps exclude this client, or it is restricted to selected chats',
  })
  async createSession(
    @CurrentApiKey() apiKey: ApiKey | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BrowserSessionResponseDto> {
    if (!apiKey || !presentedApiKey(req.headers)) {
      throw new UnauthorizedException('API key header is required');
    }
    const priorToken = extractBrowserSessionCookie(req.headers?.cookie);
    if (priorToken) {
      await this.revokeAndAudit(req, priorToken);
    }
    const { token, session, ttlMs } = await this.browserSessionService.createSession(apiKey);
    await this.auditService.logInfo(AuditAction.BROWSER_SESSION_CREATED, {
      ...this.auditContext(req, apiKey),
      metadata: { browserSessionId: session.id },
    });
    const trustedProxies = this.configService.get<string[]>('security.trustedProxies') ?? [];
    const secureOverride = this.configService.get<boolean | undefined>('auth.dashboardSessionCookieSecure');
    const secure = isSecureCookieRequest(req, trustedProxies, secureOverride);
    // A sign-in forwarded as https whose cookie still lacks Secure came through a proxy TRUSTED_PROXIES does not
    // name: the only point where a TLS proxy and plain HTTP can be told apart. Said once per process.
    if (
      !secure &&
      !this.insecureCookieWarned &&
      secureOverride !== false &&
      process.env.DASHBOARD_SESSION_COOKIE_SECURE?.trim() !== 'false' &&
      // The entry the nearest proxy appended, as the Secure decision reads it: a leading one is the client's.
      rightmostHeaderEntry(req.headers['x-forwarded-proto'])?.toLowerCase() === 'https'
    ) {
      this.insecureCookieWarned = true;
      this.logger.warn(
        'A dashboard sign-in arrived through a proxy that forwards https, but the session cookie was issued ' +
          'without Secure because the proxy is not listed in TRUSTED_PROXIES. Add the proxy to TRUSTED_PROXIES, ' +
          'or set DASHBOARD_SESSION_COOKIE_SECURE=true.',
        { action: 'session_cookie_not_secure' },
      );
    }
    res.setHeader('Set-Cookie', formatSessionSetCookie(token, Math.floor(ttlMs / 1000), secure));
    res.setHeader('Cache-Control', 'no-store');
    return {
      valid: true,
      role: apiKey.role,
      engineType: this.engineFactory.getCurrentEngine(),
      scoped: (apiKey.allowedSessions?.length ?? 0) > 0,
      deniedPermissions: apiKeyDeniedCapabilities(apiKey),
      apiKeyId: apiKey.id,
    };
  }

  @Get('session')
  @SignedOutProbe()
  @CapabilityAgnostic()
  @ApiOperation({ summary: 'Validate the active browser session cookie or API key header' })
  @ApiResponse({ status: 200, description: 'Active session details', type: BrowserSessionResponseDto })
  @ApiResponse({ status: 401, description: 'Missing, expired, or revoked session' })
  @ApiResponse({ status: 403, description: 'Session key refused by IP or chat restrictions' })
  getSession(
    @CurrentApiKey() apiKey: ApiKey | undefined,
    @Res({ passthrough: true }) res: Response,
  ): BrowserSessionResponseDto {
    if (!apiKey) {
      throw new UnauthorizedException('Session is required');
    }
    res.setHeader('Cache-Control', 'no-store');
    return {
      valid: true,
      role: apiKey.role,
      engineType: this.engineFactory.getCurrentEngine(),
      scoped: (apiKey.allowedSessions?.length ?? 0) > 0,
      deniedPermissions: apiKeyDeniedCapabilities(apiKey),
      apiKeyId: apiKey.id,
    };
  }

  @Delete('session')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke the current browser session and clear the session cookie' })
  @ApiResponse({ status: 200, description: 'Session cleared', type: BrowserSessionLogoutResponseDto })
  @ApiResponse({ status: 403, description: 'CSRF check failed for a cookie-authenticated logout request' })
  async deleteSession(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BrowserSessionLogoutResponseDto> {
    const trustedProxies = this.configService.get<string[]>('security.trustedProxies') ?? [];
    const token = extractBrowserSessionCookie(req.headers?.cookie);
    if (token) {
      assertBrowserCsrfSafe(req, trustedProxies);
      await this.revokeAndAudit(req, token);
    }
    const secureOverride = this.configService.get<boolean | undefined>('auth.dashboardSessionCookieSecure');
    const secure = isSecureCookieRequest(req, trustedProxies, secureOverride);
    res.setHeader('Set-Cookie', formatSessionClearCookie(secure));
    res.setHeader('Cache-Control', 'no-store');
    return { ok: true };
  }
}
