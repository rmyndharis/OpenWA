import {
  Controller,
  Delete,
  ForbiddenException,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { CurrentApiKey } from '../auth/decorators/auth.decorators';
import { AuthService } from '../auth/auth.service';
import { ApiKey } from '../auth/entities/api-key.entity';
import {
  QUEUES_BOARD_COOKIE_MAX_AGE_SEC,
  QUEUES_BOARD_COOKIE_NAME,
  QUEUES_BOARD_COOKIE_PATH,
} from './queues-board-session.constants';

@Controller('admin/queues-board-session')
@UseGuards(ApiKeyGuard)
export class QueuesBoardSessionController {
  constructor(private readonly authService: AuthService) {}

  @Post()
  @HttpCode(204)
  mint(@Req() req: Request, @CurrentApiKey() apiKey: ApiKey, @Res({ passthrough: true }) res: Response): void {
    if (!this.authService.canAccessOpenWaQueues(apiKey)) {
      throw new ForbiddenException('Admin or companion operator role required');
    }
    const raw =
      (typeof req.headers['x-api-key'] === 'string' && req.headers['x-api-key']) ||
      (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined);
    if (!raw) throw new UnauthorizedException('API key required');
    res.cookie(QUEUES_BOARD_COOKIE_NAME, raw, {
      httpOnly: true,
      maxAge: QUEUES_BOARD_COOKIE_MAX_AGE_SEC * 1000,
      ...this.boardCookieOptions(req),
    });
  }

  @Delete()
  @HttpCode(204)
  clear(@Req() req: Request, @Res({ passthrough: true }) res: Response): void {
    res.clearCookie(QUEUES_BOARD_COOKIE_NAME, this.boardCookieOptions(req));
  }

  /** Shared path/secure/sameSite — clearCookie must match mint or the browser keeps the cookie. */
  private boardCookieOptions(req: Request): { path: string; secure: boolean; sameSite: 'strict' } {
    return {
      path: QUEUES_BOARD_COOKIE_PATH,
      secure: process.env.NODE_ENV === 'production' || req.secure === true,
      sameSite: 'strict',
    };
  }
}
