import { All, Controller, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators/auth.decorators';
import { IngressService } from './ingress.service';

// @Public so the global ApiKeyGuard early-returns (providers can't present an API key), but NOT
// @SkipThrottle — the global IP throttle stays as a coarse guard (per-instance fairness is P1).
// The provider body is read as RAW bytes from req.rawBody (stashed by the json() verify callback in
// main.ts) — it is intentionally NOT DTO-bound, so the global ValidationPipe never 400s on the
// provider's unknown keys, and the exact signed bytes reach the HMAC verifier.
@Public()
@Controller('api/ingress')
export class IngressController {
  constructor(private readonly ingress: IngressService) {}

  @All(':pluginId/:instanceId/*')
  async receive(
    @Param('pluginId') pluginId: string,
    @Param('instanceId') instanceId: string,
    @Query() query: Record<string, string>,
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
  ): Promise<void> {
    const route = (req.params[0] ?? '').split('/')[0] || '';
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(',') : String(v ?? '')]),
    );
    const rawBody = req.rawBody?.toString('utf8') ?? '';
    const result = await this.ingress.handle({
      pluginId,
      instanceId,
      route,
      method: req.method,
      headers,
      query,
      rawBody,
    });
    res.status(result.status).send(result.body ?? '');
  }
}
