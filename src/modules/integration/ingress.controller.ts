import { All, Controller, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags, ApiOkResponse, ApiParam, ApiResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators/auth.decorators';
import { ackContentType, safeAckHeaders } from './ingress-ack';
import { IngressService } from './ingress.service';
import { InstanceThrottlerGuard } from './instance-throttler.guard';

// @Public so the global ApiKeyGuard early-returns (providers can't present an API key). The
// controller-level @SkipThrottle below exempts the GLOBAL per-IP guard (see its comment).
// The provider body is read as RAW bytes from req.rawBody (stashed by the json() verify callback in
// main.ts) — it is intentionally NOT DTO-bound, so the global ValidationPipe never 400s on the
// provider's unknown keys, and the exact signed bytes reach the HMAC verifier.
@ApiTags('integration')
@Public()
// The global per-IP throttle SKIPS this route (its medium tier, 100/min by default, sits below the
// per-instance limit's 120/min, so a provider delivering every tenant's webhooks from one shared
// egress IP was 429'd at the IP tier before the instance bound ever fired). Fairness here is the
// InstanceThrottlerGuard's job: keyed on (pluginId, instanceId), a noisy tenant sheds alone.
@SkipThrottle()
@Controller('ingress')
export class IngressController {
  constructor(private readonly ingress: IngressService) {}

  // Express 5 (path-to-regexp v8) has no bare `*` — Nest's route converter rewrites it to the named
  // wildcard `*path`, so the trailing segments land in req.params.path (an array), not req.params[0].
  //
  // InstanceThrottlerGuard carries this route's rate bounds: the global per-IP guard skips this
  // controller (@SkipThrottle above) because its medium tier (100/min) sits below this guard's
  // per-instance default (120/min), which 429'd every tenant of a shared-egress-IP provider at
  // the IP tier before the instance bound ever fired. This guard ignores the bare @SkipThrottle
  // (see its shouldSkip) and enforces TWO buckets: one keyed on (pluginId, instanceId), so a noisy
  // tenant sheds alone, and one keyed on the client IP, because the first key comes from the path
  // the caller supplies and would otherwise leave this @Public route with no bound it cannot walk
  // around. Their limits/ttl (INGRESS_INSTANCE_LIMIT / INGRESS_INSTANCE_TTL / INGRESS_IP_LIMIT) are
  // read directly by the guard itself, NOT via @Throttle: @Throttle metadata is reflected on the
  // route and read by every ThrottlerGuard subclass that walks a tier of that name. See
  // InstanceThrottlerGuard's onModuleInit for how it keeps its tiers fully independent.
  @UseGuards(InstanceThrottlerGuard)
  @All(':pluginId/:instanceId/*path')
  // The wildcard segment is part of the published path template, so it needs a parameter of its own —
  // the handler reads it off the request rather than binding it, which leaves the document with a
  // `{path}` placeholder nothing declares. Awkward to express, not impossible.
  @ApiParam({
    name: 'path',
    type: String,
    description: 'Provider-defined trailing path the plugin claims (may contain slashes).',
    example: 'events/message',
  })
  @ApiOkResponse({
    description:
      'GET verification challenge echo, or a route whose declared ack sets 200. Not the primary success path; see 202. A re-delivery is answered with the same ack as the first delivery, so it is not distinguishable by status.',
  })
  @ApiResponse({
    status: 202,
    description: 'Webhook accepted and queued for async plugin processing (the primary success path).',
  })
  @ApiResponse({ status: 401, description: 'Signature verification failed (missing, stale, or wrong secret).' })
  @ApiResponse({ status: 403, description: 'GET verification challenge failed (verifyToken mismatch).' })
  @ApiResponse({ status: 404, description: 'Unknown pluginId/instanceId, or no route claimed by the plugin.' })
  @ApiResponse({ status: 413, description: 'Request body exceeds the route maxBodyBytes limit.' })
  @ApiResponse({
    status: 429,
    description:
      'Rate limit exceeded: the per-instance bucket (INGRESS_INSTANCE_LIMIT) or the per-client-IP bucket (INGRESS_IP_LIMIT). The `Retry-After-instance` / `Retry-After-ingress-ip` header names which one shed the request, and a plain `Retry-After` carries the same delay for a client that reads only the standard name.',
  })
  @ApiResponse({
    status: 503,
    description:
      "A route whose response contract declares a `session-alive` preflight, when the bound session's engine is not connected. The delivery is not persisted, so the provider's retry is treated as a new one; `Retry-After` carries the delay.",
  })
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
    // Express answers a repeated query parameter with an array, so the Record<string, string> the
    // service is typed against is a promise the framework does not keep. The challenge path feeds
    // these straight into a constant-time compare, which throws on anything that is not a string, so
    // `?token=a&token=b` answered 500. Flattened here, the way the headers above already are: the
    // first value wins, as URLSearchParams.get and most providers' own clients read it. The app runs
    // Express's default 'simple' query parser, which never nests (`?a[b]=c` is the key `a[b]`), so
    // the last arm is only there to keep the mapping total if that setting ever changes.
    const flatQuery: Record<string, string> = Object.fromEntries(
      Object.entries(query as Record<string, unknown>).map(([k, v]) => [
        k,
        Array.isArray(v) ? String(v[0] ?? '') : typeof v === 'string' ? v : '',
      ]),
    );
    const rawBody = req.rawBody?.toString('utf8') ?? '';
    const result = await this.ingress.handle({
      pluginId,
      instanceId,
      route,
      method: req.method,
      headers,
      query: flatQuery,
      rawBody,
    });
    if (result.headers) res.set(safeAckHeaders(result.headers));
    // Both reflections echo provider-controlled strings (hub.challenge, the ack template). Express
    // types a bare send() as text/html, which turns a reflection into XSS material on this origin, so
    // only a non-executable declared type survives and everything else is forced to text/plain. It
    // reads the UNFILTERED headers on purpose: safeAckHeaders fences content-type precisely because
    // this is the one place allowed to decide it.
    res.type(ackContentType(result.headers));
    res.status(result.status).send(result.body ?? '');
  }
}
