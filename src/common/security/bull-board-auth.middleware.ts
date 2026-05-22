import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../../modules/auth/auth.service';
import { ApiKeyRole } from '../../modules/auth/entities/api-key.entity';

@Injectable()
export class BullBoardAuthMiddleware implements NestMiddleware {
  constructor(private readonly authService: AuthService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const xApiKey = req.headers['x-api-key'] as string;
    const authHeader = req.headers['authorization'];
    const rawKey = xApiKey || (authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined);

    if (!rawKey) {
      res.status(401).json({ message: 'API key required' });
      return;
    }

    try {
      const apiKey = await this.authService.validateApiKey(rawKey);
      if (!this.authService.hasPermission(apiKey, ApiKeyRole.ADMIN)) {
        res.status(403).json({ message: 'Admin role required' });
        return;
      }
      next();
    } catch {
      res.status(401).json({ message: 'Invalid API key' });
    }
  }
}
