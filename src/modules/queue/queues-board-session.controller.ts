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
import { Request, Response } from 'express';
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
    const secure = process.env.NODE_ENV === 'production' || req.secure === true;
    res.cookie(QUEUES_BOARD_COOKIE_NAME, raw, {
      httpOnly: true,
      sameSite: 'strict',
      path: QUEUES_BOARD_COOKIE_PATH,
      maxAge: QUEUES_BOARD_COOKIE_MAX_AGE_SEC * 1000,
      secure,
    });
  }

  @Delete()
  @HttpCode(204)
  clear(@Res({ passthrough: true }) res: Response): void {
    res.clearCookie(QUEUES_BOARD_COOKIE_NAME, { path: QUEUES_BOARD_COOKIE_PATH });
  }
}
