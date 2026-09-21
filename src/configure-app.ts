import { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import { Request, Response, NextFunction, json, urlencoded } from 'express';
import { randomBytes } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { extname, join } from 'path';
import { DASHBOARD_DIST, dashboardServingEnabled, dashboardBuildPresent } from './app.module';
import { createInflightBodyBudget, resolveInflightBodyBudgetBytes } from './config/inflight-body-budget';
import { requestContextMiddleware } from './common/middleware/request-context.middleware';
import { injectDashboardCspNonce } from './config/dashboard-csp';
import { resolveCorsPolicy, isUpgradeInsecureRequestsEnabled, resolveBodyLimit } from './config/bootstrap-security';

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
 * Everything the production HTTP surface installs on the Express app: the in-flight body budget,
 * the body parsers, request context, the CSP nonce, helmet, the SPA document handler and CORS.
 *
 * It lives here rather than inside bootstrap() so the e2e lane can run the SAME stack. main.ts
 * boots on import, so a suite cannot import it; the whole stack was therefore executed by nothing,
 * and the one suite that needed the document handler carried its own copy of it.
 *
 * ORDER IS LOAD-BEARING. The budget must precede the parsers (a refused connection must not buffer
 * a byte), and the nonce must precede helmet (the CSP directive reads res.locals.cspNonce).
 */
export function configureApp(app: INestApplication, options: ConfigureAppOptions = {}): AppliedBodyCaps {
  const dashboard: DashboardSource = options.dashboard ?? {
    distDir: DASHBOARD_DIST,
    enabled: dashboardServingEnabled && dashboardBuildPresent,
  };

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
  app.use(
    createInflightBodyBudget(inflightBudgetBytes, {
      trustedProxies: (process.env.TRUSTED_PROXIES || '')
        .split(',')
        .map(p => p.trim())
        .filter(Boolean),
    }).middleware,
  );

  // Cap request body size (DoS hardening). Media sends carry base64 in the JSON body,
  // so the default is generous; tune with BODY_SIZE_LIMIT.
  const bodyLimit = resolveBodyLimit(process.env.BODY_SIZE_LIMIT);
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
          // The bundled dashboard pulls webfonts from Google Fonts (CSS from fonts.googleapis.com,
          // font files from fonts.gstatic.com). Now that NestJS serves the dashboard under this CSP,
          // allow those origins or the @import'd fonts are blocked and the UI falls back to system fonts.
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          scriptSrc: ["'self'", (_req, res) => `'nonce-${(res as Response).locals.cspNonce as string}'`],
          // `blob:` is needed for the outgoing image-attachment preview, which the dashboard renders
          // from a URL.createObjectURL(file) blob before the message is sent (Chats.tsx).
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          // Chat media (voice notes, video) is served to the dashboard as data: URIs. Without an
          // explicit media-src, <audio>/<video> fall back to default-src 'self' and are blocked.
          // Mirror imgSrc so audio/video render the same way images already do.
          mediaSrc: ["'self'", 'data:', 'blob:', 'https:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
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
      const excluded =
        req.path.startsWith('/api/') ||
        req.path === '/api' ||
        req.path.startsWith('/socket.io/') ||
        req.path === '/socket.io' ||
        req.path.startsWith('/mcp/') ||
        req.path === '/mcp' ||
        req.path.startsWith('/assets/');
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
    console.warn(
      '[Bootstrap] No explicit CORS_ORIGINS in production (wildcard "*" is refused): cross-origin browser ' +
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
    allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization', 'X-Request-ID'],
    // The throttlers are named (short/medium/long, plus instance and ingress-ip on ingress), so
    // @nestjs/throttler suffixes every rate-limit header with the throttler name. Expose the suffixed
    // names so browser clients can actually read them, plus the plain `Retry-After` the guard adds
    // on top of them, which is not CORS-safelisted either.
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
    ],
    maxAge: 86400, // 24 hours
  });

  return { bodyLimit, inflightBudgetBytes };
}
