import { Controller, Delete, Get, HttpCode, HttpStatus, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { CurrentApiKey, HeaderAuthOnly, Public } from './decorators/auth.decorators';
import { ApiKey } from './entities/api-key.entity';
import { BrowserSessionLogoutResponseDto, BrowserSessionResponseDto } from './dto';
import { BrowserSessionService } from './browser-session.service';
import {
  assertBrowserCsrfSafe,
  extractBrowserSessionCookie,
  formatSessionClearCookie,
  formatSessionSetCookie,
  isSecureCookieRequest,
} from './browser-session.util';
import { EngineFactory } from '../../engine/engine.factory';
import { presentedApiKey } from '../../common/security/bearer-token';

@ApiTags('auth')
@Controller('auth')
export class BrowserSessionController {
  constructor(
    private readonly browserSessionService: BrowserSessionService,
    private readonly engineFactory: EngineFactory,
    private readonly configService: ConfigService,
  ) {}

  @Post('session')
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
      await this.browserSessionService.revokeByToken(priorToken);
    }
    const { token, ttlMs } = await this.browserSessionService.createSession(apiKey);
    const trustedProxies = this.configService.get<string[]>('security.trustedProxies') ?? [];
    const secureOverride = this.configService.get<boolean | undefined>('auth.dashboardSessionCookieSecure');
    const secure = isSecureCookieRequest(req, trustedProxies, secureOverride);
    res.setHeader('Set-Cookie', formatSessionSetCookie(token, Math.floor(ttlMs / 1000), secure));
    res.setHeader('Cache-Control', 'no-store');
    return {
      valid: true,
      role: apiKey.role,
      engineType: this.engineFactory.getCurrentEngine(),
      scoped: (apiKey.allowedSessions?.length ?? 0) > 0,
      apiKeyId: apiKey.id,
    };
  }

  @Get('session')
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
      await this.browserSessionService.revokeByToken(token);
    }
    const secureOverride = this.configService.get<boolean | undefined>('auth.dashboardSessionCookieSecure');
    const secure = isSecureCookieRequest(req, trustedProxies, secureOverride);
    res.setHeader('Set-Cookie', formatSessionClearCookie(secure));
    res.setHeader('Cache-Control', 'no-store');
    return { ok: true };
  }
}
