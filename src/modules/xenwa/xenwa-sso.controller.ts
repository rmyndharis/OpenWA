import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/decorators/auth.decorators';
import { EngineFactory } from '../../engine/engine.factory';
import { XenwaService } from './xenwa.service';
import { XenwaHandoffDto, XenwaSsoDto } from './dto/xenwa.dto';

/**
 * XenAI Tech single sign-on. Public by necessity (the caller has no API key yet); the signed,
 * single-use, 60-second token is the credential.
 *
 * Flow: XenAI Tech auto-submits a form POST with `token` here → the token is verified and its nonce
 * burned → the user is created/updated and their managed key ensured → 303 to `/?xenwa_handoff=<code>`
 * → the dashboard exchanges the one-time code for the API key. The key never travels in a URL, and the
 * token never does either on the POST path (GET is accepted for simple links but leaves it in logs).
 */
@ApiExcludeController()
@Controller('xenwa')
export class XenwaSsoController {
  constructor(
    private readonly xenwa: XenwaService,
    private readonly engineFactory: EngineFactory,
  ) {}

  @Public()
  @Get('config')
  config() {
    return this.xenwa.publicConfig();
  }

  @Public()
  @Post('sso')
  @HttpCode(HttpStatus.SEE_OTHER)
  async ssoPost(@Body() dto: XenwaSsoDto, @Res() res: Response): Promise<void> {
    await this.finish(dto.token, res);
  }

  @Public()
  @Get('sso')
  async ssoGet(@Query('token') token: string | undefined, @Res() res: Response): Promise<void> {
    await this.finish(typeof token === 'string' ? token : '', res);
  }

  private async finish(token: string, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const code = await this.xenwa.consumeSsoToken(token);
      res.redirect(303, `/?xenwa_handoff=${encodeURIComponent(code)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sign-in failed';
      res.redirect(303, `/?xenwa_error=${encodeURIComponent(message.slice(0, 200))}`);
    }
  }

  @Public()
  @Post('sso/exchange')
  @HttpCode(HttpStatus.OK)
  exchange(@Body() dto: XenwaHandoffDto, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const { apiKey, role } = this.xenwa.exchangeHandoff(dto.code);
    return { apiKey, role, engineType: this.engineFactory.getCurrentEngine() };
  }
}
