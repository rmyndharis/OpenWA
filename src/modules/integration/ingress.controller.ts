import { All, Controller, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators/auth.decorators';
import { IngressService } from './ingress.service';
import { InstanceThrottlerGuard } from './instance-throttler.guard';

// @Public so the global ApiKeyGuard early-returns (providers can't present an API key), but NOT
// @SkipThrottle — the global IP throttle stays as a coarse guard (per-instance fairness is P1).
// The provider body is read as RAW bytes from req.rawBody (stashed by the json() verify callback in
// main.ts) — it is intentionally NOT DTO-bound, so the global ValidationPipe never 400s on the
// provider's unknown keys, and the exact signed bytes reach the HMAC verifier.
@Public()
@Controller('ingress')
export class IngressController {
  constructor(private readonly ingress: IngressService) {}

  // Express 5 (path-to-regexp v8) has no bare `*` — Nest's route converter rewrites it to the named
  // wildcard `*path`, so the trailing segments land in req.params.path (an array), not req.params[0].
  //
  // InstanceThrottlerGuard runs IN ADDITION to the global per-IP ProxyAwareThrottlerGuard (an
  // APP_GUARD, so it still applies here) — two independent buckets, keyed differently, both enforced.
  // Its limit/ttl (INGRESS_INSTANCE_LIMIT / INGRESS_INSTANCE_TTL) are read directly by the guard
  // itself, NOT via @Throttle: @Throttle metadata is reflected on the route and read by every
  // ThrottlerGuard subclass that walks a tier of that name, including the global per-IP guard — so a
  // route-level override here would silently retarget the global guard's tolerance too. See
  // InstanceThrottlerGuard's onModuleInit for how it keeps its tier fully independent.
  @UseGuards(InstanceThrottlerGuard)
  @All(':pluginId/:instanceId/*path')
  async receive(
    @Param('pluginId') pluginId: string,
    @Param('instanceId') instanceId: string,
    @Query() query: Record<string, string>,
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
  ): Promise<void> {
    const wildcard = (req.params as Record<string, string | string[] | undefined>).path;
    const segments = Array.isArray(wildcard)
      ? wildcard
      : typeof wildcard === 'string'
        ? wildcard.split('/').filter(Boolean)
        : [];
    const route = segments[0] ?? '';
    const headers: Record<string, string> = Object.fromEntries(
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
