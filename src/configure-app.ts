import { INestApplication, Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import helmet from 'helmet';
import { Request, Response, NextFunction, json, urlencoded } from 'express';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { extname, join } from 'path';
import { DASHBOARD_DIST, dashboardServingEnabled, dashboardBuildPresent } from './app.module';
import {
  createInflightBodyBudget,
  parseBodyLimitBytes,
  resolveInflightBodyBudgetBytes,
} from './config/inflight-body-budget';
import { ActiveKeyIndex } from './modules/auth/active-key-index';
import { requestContextMiddleware } from './common/middleware/request-context.middleware';
import { createLogger } from './common/services/logger.service';
import { ShutdownService } from './common/services/shutdown.service';
import { injectDashboardCspNonce } from './config/dashboard-csp';
import { resolveCorsPolicy, isUpgradeInsecureRequestsEnabled, resolveBodyLimit } from './config/bootstrap-security';
import { resolveRequestTimeoutMs } from './config/http-timeouts';

/** Where the bundled dashboard documents come from, and whether to serve them at all. */
export interface DashboardSource {
  distDir: string;
  enabled: boolean;
}

export interface ConfigureAppOptions {
  /**
   * Defaults to what app.module resolved at import time. An e2e overrides it to point the REAL
   * document handler at a fixture directory: the path is a module constant derived from __dirname,
   * so without this seam a suite could only re-implement the handler, and a divergence between the
   * copy and the original would pass.
   */
  dashboard?: DashboardSource;
}

/** The request-body caps this applied, so the caller can log them. */
export interface AppliedBodyCaps {
  bodyLimit: string;
  inflightBudgetBytes: number;
}

/**
 * Everything the production HTTP surface installs on the Express app: request context, the CSP
 * nonce, helmet, the SPA document handler, CORS, the encoded-NUL refusal, the in-flight body budget,
 * the body parsers and the trailing-slash DELETE refusal.
 *
 * It lives here rather than inside bootstrap() so the e2e lane can run the SAME stack. main.ts
 * boots on import, so a suite cannot import it; the whole stack was therefore executed by nothing,
 * and the one suite that needed the document handler carried its own copy of it.
 *
 * ORDER IS LOAD-BEARING. The budget must precede the parsers (a refused connection must not buffer
 * a byte), and the nonce must precede helmet (the CSP directive reads res.locals.cspNonce). Request
 * context, helmet and CORS must precede both: the budget answers its 503/415 itself and a parser
 * error skips every later non-error middleware, so a rejection registered ahead of them reaches a
 * cross-origin browser as an opaque network error, without the request id.
 */
export function configureApp(app: INestApplication, options: ConfigureAppOptions = {}): AppliedBodyCaps {
  const dashboard: DashboardSource = options.dashboard ?? {
    distDir: DASHBOARD_DIST,
    enabled: dashboardServingEnabled && dashboardBuildPresent,
  };

  // Assign a request id to every inbound request (X-Request-ID), echo it on the response, and run
  // the whole downstream chain inside its scope so every log line + audit row carries it.
  app.use(requestContextMiddleware);

  // Give every response a CSP nonce. A bundled dashboard document receives its own value in a meta
  // element below; plugin config UIs copy it only onto inline scripts in their opaque sandboxed iframe.
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.locals.cspNonce = randomBytes(18).toString('base64url');
    next();
  });

  // Enhanced Security Headers
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // The dashboard bundles its fonts, so no third-party style or font origin is allowed. The Bull Board
          // UI (/api/admin/queues) links IBM Plex from Google Fonts; that stylesheet is blocked and it falls
          // back to system fonts.
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'", (_req, res) => `'nonce-${(res as Response).locals.cspNonce as string}'`],
          // `blob:` is needed for the outgoing image-attachment preview, which the dashboard renders
          // from a URL.createObjectURL(file) blob before the message is sent (Chats.tsx).
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          // Chat media (voice notes, video) is served to the dashboard as data: URIs. Without an
          // explicit media-src, <audio>/<video> fall back to default-src 'self' and are blocked.
          // Mirror imgSrc so audio/video render the same way images already do.
          mediaSrc: ["'self'", 'data:', 'blob:', 'https:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          // Auto-upgrade HTTP→HTTPS in production, unless CSP_UPGRADE_INSECURE_REQUESTS opts out for an
          // HTTP-only private-network deployment (otherwise the browser forces the dashboard to https). (#611)
          upgradeInsecureRequests: isUpgradeInsecureRequestsEnabled(
            process.env.CSP_UPGRADE_INSECURE_REQUESTS,
            process.env.NODE_ENV,
          )
            ? []
            : null,
        },
      },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      },
      noSniff: true,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      // Disable for API usage
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Serve SPA documents dynamically so the nonce embedded in this exact document matches its CSP
  // response header. A shared cookie is deliberately avoided: a second dashboard tab could overwrite
  // it and make the first tab's srcdoc scripts fail CSP. Assets and Nest-owned routes fall through.
  if (dashboard.enabled && existsSync(join(dashboard.distDir, 'index.html'))) {
    const dashboardIndex = readFileSync(join(dashboard.distDir, 'index.html'), 'utf8');
    app.use((req: Request, res: Response, next: NextFunction) => {
      // Lowercased because routing matches these prefixes case-insensitively.
      const path = req.path.toLowerCase();
      const excluded =
        path.startsWith('/api/') ||
        path === '/api' ||
        path.startsWith('/socket.io/') ||
        path === '/socket.io' ||
        path.startsWith('/mcp/') ||
        path === '/mcp' ||
        path.startsWith('/assets/');
      const documentRequest =
        req.method === 'GET' &&
        !excluded &&
        ((req.headers.accept ?? '').includes('text/html') || extname(req.path) === '');
      if (!documentRequest) return next();

      res.setHeader('Cache-Control', 'no-store');
      res.type('html').send(injectDashboardCspNonce(dashboardIndex, res.locals.cspNonce as string));
    });
  }

  // CORS Configuration (#221 hardening)
  const corsPolicy = resolveCorsPolicy(process.env.CORS_ORIGINS, process.env.NODE_ENV);
  if (process.env.NODE_ENV === 'production' && corsPolicy.origins.length === 0 && !corsPolicy.allowAnyOrigin) {
    createLogger('Bootstrap').warn(
      'No explicit CORS_ORIGINS in production (wildcard "*" is refused): cross-origin browser ' +
        'requests will be blocked. Set CORS_ORIGINS to your dashboard origin(s).',
    );
  }
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      // Allow requests with no origin (mobile apps, Postman, server-to-server)
      if (!origin) return callback(null, true);

      if (corsPolicy.allowAnyOrigin || corsPolicy.origins.includes(origin)) {
        callback(null, true);
      } else {
        // Deny WITHOUT throwing. Throwing here surfaced as a 500 Internal Server Error (#250).
        // Returning false simply omits the CORS headers: the browser blocks a true cross-origin
        // request itself (correct), while same-origin requests — e.g. the bundled dashboard served
        // through the proxy, which the browser never subjects to CORS — keep working. A genuine
        // cross-origin dashboard still needs its origin in CORS_ORIGINS.
        callback(null, false);
      }
    },
    credentials: corsPolicy.credentials,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    // Idempotency-Key is the opt-in retry guard on the send routes (SendIdempotencyInterceptor).
    allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization', 'X-Request-ID', 'Idempotency-Key'],
    // The throttlers are named (short/medium/long, plus ingress-ip on ingress), so @nestjs/throttler
    // suffixes every rate-limit header with the throttler name; IngressService emits the per-instance
    // bucket's headers under the same `-instance` suffix. Expose the suffixed names so browser clients
    // can actually read them, plus the plain `Retry-After` (added by the guard, or by IngressService
    // for the instance bucket), which is not CORS-safelisted either.
    exposedHeaders: [
      'X-RateLimit-Limit-short',
      'X-RateLimit-Remaining-short',
      'X-RateLimit-Reset-short',
      'X-RateLimit-Limit-medium',
      'X-RateLimit-Remaining-medium',
      'X-RateLimit-Reset-medium',
      'X-RateLimit-Limit-long',
      'X-RateLimit-Remaining-long',
      'X-RateLimit-Reset-long',
      'X-RateLimit-Limit-instance',
      'X-RateLimit-Remaining-instance',
      'X-RateLimit-Reset-instance',
      'X-RateLimit-Limit-ingress-ip',
      'X-RateLimit-Remaining-ingress-ip',
      'X-RateLimit-Reset-ingress-ip',
      'Retry-After',
      'Retry-After-short',
      'Retry-After-medium',
      'Retry-After-long',
      'Retry-After-instance',
      'Retry-After-ingress-ip',
      // Marks a send answered from a stored Idempotency-Key response rather than sent again.
      'Idempotent-Replayed',
    ],
    maxAge: 86400, // 24 hours
  });

  // Express decodes %00 in a path parameter or the query to U+0000, which PostgreSQL rejects in every text
  // parameter, so the lookup behind the route failed with 500 (on the public ingress route too, which
  // resolves its instance before anything else). No route takes one. After CORS, so a browser can read it.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!req.originalUrl.includes('%00')) return next();
    res.status(400).json({ statusCode: 400, message: 'URL must not contain an encoded NUL', error: 'Bad Request' });
  });

  // Providers some test modules lack. Looked up through ModuleRef: a failed app.get() aborts the
  // process instead of throwing.
  const optional = <T>(token: Type<T>): T | undefined => {
    try {
      return app.get(ModuleRef).get(token, { strict: false });
    } catch {
      return undefined;
    }
  };

  // Once the shutdown grace has elapsed, teardown runs every destroy hook before the listener
  // closes, and a request admitted then would run against services being torn down. Refuse new
  // requests from that point; admitted ones run to completion. The health probes stay answered so
  // readiness keeps reporting its draining state. Ahead of the budget, so no body is read.
  const shutdown = optional(ShutdownService);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!shutdown?.isTearingDown()) return next();
    const path = req.path.toLowerCase();
    if (path === '/api/health' || path.startsWith('/api/health/')) return next();
    res.status(503).set('Connection', 'close').json({
      statusCode: 503,
      message: 'Server is shutting down',
      error: 'Service Unavailable',
    });
  });

  // Aggregate in-flight body budget (DoS hardening): once too many body bytes are being buffered
  // across ALL connections, new requests get 503 + Retry-After without their body being read.
  // This is a deliberate PRE-GUARD: the throttler/auth guards run at the Nest routing layer —
  // AFTER middleware and body buffering — so they can never stop slow-body memory pinning, and
  // this must run BEFORE the body parser so a rejected connection never buffers a byte. The
  // per-request BODY_SIZE_LIMIT below is a separate, unchanged cap on each admitted request.
  const inflightBudgetBytes = resolveInflightBodyBudgetBytes(
    process.env.INFLIGHT_BODY_BUDGET_BYTES,
    process.env.BODY_SIZE_LIMIT,
  );
  // Cap request body size (DoS hardening). Media sends carry base64 in the JSON body,
  // so the default is generous; tune with BODY_SIZE_LIMIT.
  const bodyLimit = resolveBodyLimit(process.env.BODY_SIZE_LIMIT);
  // Requests without a recognised API key share a pool of a quarter of the budget, never less than
  // two BODY_SIZE_LIMIT bodies (half the default budget). With no AuthModule in the app (some test
  // modules) every request is unrecognised, which is the stricter side.
  const keyIndex = optional(ActiveKeyIndex);
  app.use(
    createInflightBodyBudget(inflightBudgetBytes, {
      trustedProxies: (process.env.TRUSTED_PROXIES || '')
        .split(',')
        .map(p => p.trim())
        .filter(Boolean),
      classify: (req, clientIp) => keyIndex?.recognise(req.headers, clientIp),
      bodyLimitBytes: parseBodyLimitBytes(bodyLimit),
      requestTimeoutMs: resolveRequestTimeoutMs(process.env.REQUEST_TIMEOUT_MS),
    }).middleware,
  );
  // The `verify` callback stashes the EXACT bytes json() received on req.rawBody, byte-identical to
  // what a provider signed, so the @Public ingress controller can HMAC-verify over the raw body
  // (JSON.stringify(req.body) is NOT byte-identical). Cheap for every route; non-ingress routes ignore it.
  // `inflate: false` is a backstop, not the guard: the budget middleware above already refuses a
  // compressed body with 415 before a byte is read. It sits here so a future reordering of these
  // parsers relative to that middleware cannot silently reopen the gap — an inflated body is
  // charged to the budget at its compressed size and bounded by nothing. Every other parser in the
  // process must carry the same flag for that argument to hold; the MCP route-level fallback
  // (src/modules/mcp/mcp.server.ts) does.
  app.use(
    json({
      limit: bodyLimit,
      inflate: false,
      verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(
    urlencoded({
      extended: true,
      limit: bodyLimit,
      inflate: false,
      // Form-encoded webhook providers also sign the exact wire bytes. Use the same capture contract
      // as json(); other content types remain unsupported rather than installing a global catch-all.
      verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  // A DELETE path ending in '/' names no resource. Non-strict routing would still match it to the
  // route without the slash, so a client that normalises `<parent>/<child>/..` down to `<parent>/`
  // would delete the parent. Only DELETE under /api/ is refused: a trailing slash on other methods
  // keeps working, and /mcp handles its own DELETE. /api/ingress/ is exempt: it forwards every
  // method to a plugin route picked by its first wildcard segment and deletes nothing. The prefix
  // is compared case-insensitively because routing matches it that way. Registered after helmet
  // and CORS so the 404 carries their headers; routes mount later, at init, so it still runs
  // before routing.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const path = req.path.toLowerCase();
    if (
      req.method === 'DELETE' &&
      path.startsWith('/api/') &&
      !path.startsWith('/api/ingress/') &&
      path.endsWith('/')
    ) {
      res.status(404).json({ statusCode: 404, message: `Cannot DELETE ${req.path}`, error: 'Not Found' });
      return;
    }
    next();
  });

  return { bodyLimit, inflightBudgetBytes };
}
