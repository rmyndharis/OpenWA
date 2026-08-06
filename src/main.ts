// The env loader MUST be the first import: it populates process.env from .env / data/.env.generated
// before any other module is evaluated, so modules that read process.env at import time (e.g. the
// webhook Worker's @Processor connection) see the configured values rather than pre-dotenv defaults.
import './config/load-env';
import { NestFactory } from '@nestjs/core';
import { INestApplication, ShutdownSignal } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule, DASHBOARD_DIST, dashboardServingEnabled, dashboardBuildPresent } from './app.module';
import { ShutdownService } from './common/services/shutdown.service';
import { LoggerService, LogLevel, createLogger } from './common/services/logger.service';
import { createSwaggerConfig, exemptPublicOperations } from './config/swagger.config';
import { registerUncaughtExceptionMonitor, registerUnhandledRejectionHandler } from './config/process-error-monitor';
import { runBootstrapOrExit } from './config/bootstrap-fatal';
import { resolveStorageRoot } from './config/storage-root';
import { applyHttpTimeouts, HttpTimeoutConfig, HttpTimeoutSink } from './config/http-timeouts';
import { createInflightBodyBudget, resolveInflightBodyBudgetBytes } from './config/inflight-body-budget';
import { applyGlobalValidation } from './config/app-validation';
import { requestContextMiddleware } from './common/middleware/request-context.middleware';
import { injectDashboardCspNonce } from './config/dashboard-csp';
import {
  resolveCorsPolicy,
  isSwaggerEnabled,
  isUpgradeInsecureRequestsEnabled,
  isDashboardCspUpgradeTrapLikely,
  resolveBodyLimit,
  assertNoDefaultSecretsInProduction,
  isApiKeyPepperMissingInProduction,
} from './config/bootstrap-security';
import { BullBoardAuthMiddleware } from './common/security/bull-board-auth.middleware';
import { AuthService } from './modules/auth/auth.service';
import { AuditService } from './modules/audit/audit.service';
import { Request, Response, NextFunction, json, urlencoded } from 'express';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { extname, join } from 'path';
import { RedisIoAdapter } from './modules/events/redis-io.adapter';

// The created app, exposed at module scope so the fatal handler below can run a best-effort teardown
// (engine sessions, Redis/pg) when bootstrap fails AFTER NestFactory.create succeeded — notably a
// listen() bind failure (EADDRINUSE), where full init already ran.
let appInstance: INestApplication | undefined;

async function bootstrap() {
  // Apply the operator-configured log verbosity (LOG_LEVEL) before anything logs. Unset/invalid → INFO.
  const requestedLevel = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (requestedLevel && (Object.values(LogLevel) as string[]).includes(requestedLevel)) {
    LoggerService.setLogLevel(requestedLevel as LogLevel);
  }

  // Backstop for promise rejections that escaped a local handler (e.g. a fire-and-forget engine-event
  // dispatch), including the expected engine-teardown case it downgrades to a warning (see the helper).
  const bootstrapLogger = createLogger('Bootstrap');
  registerUnhandledRejectionHandler(bootstrapLogger);

  // A synchronous throw from a non-promise context (e.g. a sync timer callback) is fatal — Node prints a
  // raw stack to stderr, bypassing the structured log pipeline, and exits(1). Route the stack through the
  // logger WITHOUT swallowing the exception, so the crash-and-restart posture is unchanged (see the helper).
  registerUncaughtExceptionMonitor(bootstrapLogger);

  // Fail fast: never start production with default/placeholder secrets.
  assertNoDefaultSecretsInProduction({
    nodeEnv: process.env.NODE_ENV,
    databaseType: process.env.DATABASE_TYPE,
    databasePassword: process.env.DATABASE_PASSWORD,
    postgresBuiltIn: process.env.POSTGRES_BUILTIN,
    databaseHost: process.env.DATABASE_HOST,
    storageType: process.env.STORAGE_TYPE,
    minioBuiltIn: process.env.MINIO_BUILTIN,
    s3Endpoint: process.env.S3_ENDPOINT,
    // Mirror storage.service's canonical-with-legacy fallback so the guard inspects the var the app
    // actually uses (it reads S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY first).
    s3AccessKey: process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY,
    s3SecretKey: process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY,
    apiMasterKey: process.env.API_MASTER_KEY,
    allowDevApiKey: process.env.ALLOW_DEV_API_KEY,
    redisPassword: process.env.REDIS_PASSWORD,
  });

  // Advisory (not enforced): without API_KEY_PEPPER, stored API-key hashes use plain SHA-256. Enabling
  // a pepper re-hashes keys and invalidates existing ones, so we only nudge the operator (see api-key-hash.ts).
  if (isApiKeyPepperMissingInProduction(process.env.NODE_ENV, process.env.API_KEY_PEPPER)) {
    bootstrapLogger.warn(
      'API_KEY_PEPPER is not set in production: stored API-key hashes use plain SHA-256. ' +
        'Set API_KEY_PEPPER and re-issue keys to enable HMAC hashing.',
    );
  }

  // Fail fast on a media storage root the app cannot write to, BEFORE Nest builds the module graph:
  // StorageService only checks that the root EXISTS, so a root owned by another user passes boot and
  // fails later on the first media write instead (#1065). Runs ahead of NestFactory.create so
  // configuration.ts reads the resolved value.
  process.env.STORAGE_LOCAL_PATH = resolveStorageRoot({
    configured: process.env.STORAGE_LOCAL_PATH,
    logger: bootstrapLogger,
  });

  // Disable Nest's default body parser so we can set an explicit size cap below.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  appInstance = app;

  // Cross-replica WebSocket fan-out: when Redis is enabled, broadcasts reach clients on every
  // replica, not just this process. Set before the gateway's namespace is created so it inherits
  // the adapter. Inert (plain in-memory adapter) without REDIS_ENABLED, so single-node pays nothing.
  app.useWebSocketAdapter(new RedisIoAdapter(app));

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
  app.use(createInflightBodyBudget(inflightBudgetBytes).middleware);

  // Cap request body size (DoS hardening). Media sends carry base64 in the JSON body,
  // so the default is generous; tune with BODY_SIZE_LIMIT.
  const bodyLimit = resolveBodyLimit(process.env.BODY_SIZE_LIMIT);
  bootstrapLogger.log(`Request body caps: ${bodyLimit} per request, ${inflightBudgetBytes} bytes aggregate in flight`);
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

  // Let Nest own every shutdown signal EXCEPT SIGTERM/SIGINT — those we route through the bounded
  // drain below, so a load balancer / orchestrator observes readiness=503 and stops routing BEFORE
  // teardown begins. (enableShutdownHooks with an EMPTY array registers ALL signals; this filtered
  // list is non-empty, so the exclusion is honoured.)
  app.enableShutdownHooks(
    Object.values(ShutdownSignal).filter(s => s !== ShutdownSignal.SIGTERM && s !== ShutdownSignal.SIGINT),
  );

  // Wire up graceful shutdown service
  const shutdownService = app.get(ShutdownService);
  shutdownService.setShutdownCallback(async () => {
    await app.close();
  });

  // On SIGTERM/SIGINT: drain gracefully. shutdown() flips readiness to 503 immediately (the LB stops
  // routing), keeps serving in-flight requests for a bounded grace, then runs app.close() (the SAME
  // Nest lifecycle hooks Nest's own handler would run) and exits deterministically. A SECOND signal
  // forces an immediate exit — a dev double-Ctrl+C, or an operator not willing to wait out a wedged
  // teardown. The gate is a dedicated "a signal already arrived" flag, NOT isShuttingDown() (which an
  // admin restart also sets) — so a first real signal during an admin-restart grace still drains
  // gracefully instead of hard-exiting.
  let signalReceived = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (signalReceived) {
        process.exit(130);
      }
      signalReceived = true;
      shutdownService.shutdown();
    });
  }

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
  if (dashboardServingEnabled && dashboardBuildPresent) {
    const dashboardIndex = readFileSync(join(DASHBOARD_DIST, 'index.html'), 'utf8');
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
    // The throttlers are named (short/medium/long, plus instance on ingress), so @nestjs/throttler
    // suffixes every rate-limit header with the throttler name — the unsuffixed variants are never
    // sent. Expose the suffixed names so browser clients can actually read them.
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
      'Retry-After-short',
      'Retry-After-medium',
      'Retry-After-long',
      'Retry-After-instance',
    ],
    maxAge: 86400, // 24 hours
  });

  // Shared production/e2e prefix and DTO validation contract.
  applyGlobalValidation(app);

  // Swagger documentation. ENABLE_SWAGGER wins; otherwise default on outside production, off in
  // production (the API schema is reconnaissance surface — production opts in with ENABLE_SWAGGER=true).
  const swaggerEnabled = isSwaggerEnabled(process.env.ENABLE_SWAGGER, process.env.NODE_ENV);
  if (swaggerEnabled) {
    const config = createSwaggerConfig();
    const document = SwaggerModule.createDocument(app, config);
    exemptPublicOperations(document);
    SwaggerModule.setup('api/docs', app, document);
  }

  // Protect the Bull Board queue UI (/api/admin/queues). It is mounted by
  // @bull-board/nestjs as raw Express middleware that the global ApiKeyGuard
  // does not cover; registering this before app.listen() ensures it runs ahead
  // of the Bull Board router. Requires a valid ADMIN API key. The middleware also
  // writes the audit trail for this mount (auth failures + queue mutations).
  const bullBoardAuth = new BullBoardAuthMiddleware(
    app.get(AuthService),
    app.get(ConfigService),
    app.get(AuditService),
  );
  app.use('/api/admin/queues', (req: Request, res: Response, next: NextFunction) => {
    void bullBoardAuth.use(req, res, next);
  });

  // Apply explicit HTTP server timeouts so they are operator-tunable (REQUEST_TIMEOUT_MS /
  // HEADERS_TIMEOUT_MS / KEEPALIVE_TIMEOUT_MS) and observable at boot, instead of Node's implicit
  // defaults. Done after the adapter exists and before listen(). Target MUST be the http.Server
  // (app.getHttpServer()) — NOT getHttpAdapter().getInstance(), which is the Express APPLICATION
  // (a function with no requestTimeout/headersTimeout/keepAliveTimeout props); writing onto it is
  // inert. The timeouts only take effect on the real server.
  const appliedHttpTimeouts = applyHttpTimeouts(
    app.getHttpServer() as HttpTimeoutSink,
    app.get(ConfigService).get<HttpTimeoutConfig>('http')!,
  );
  bootstrapLogger.log(
    `HTTP server timeouts applied: requestTimeout=${appliedHttpTimeouts.requestTimeoutMs}ms ` +
      `headersTimeout=${appliedHttpTimeouts.headersTimeoutMs}ms keepAliveTimeout=${appliedHttpTimeouts.keepAliveTimeoutMs}ms`,
  );

  const port = process.env.PORT || 2785;
  await app.listen(port);

  // Advertise the configured public URL, matching the AuthService banner (auth.service.ts). A bare
  // `localhost` literal here contradicted that banner and read as "the UI is pinned to localhost",
  // sending #731 chasing BASE_URL/BIND_HOST/API_PORT instead of the real cause.
  const publicUrl = process.env.BASE_URL || `http://localhost:${port}`;

  console.log(`🚀 OpenWA is running on: ${publicUrl}`);
  if (swaggerEnabled) {
    console.log(`📚 Swagger docs: ${publicUrl}/api/docs`);
  }

  // Make the dashboard-serving outcome explicit so a missing build (no UI on `/`)
  // is obvious instead of a silent 404.
  if (!dashboardServingEnabled) {
    console.log('🖥️  Dashboard: serving disabled (SERVE_DASHBOARD=false); API only');
  } else if (dashboardBuildPresent) {
    console.log(`🖥️  Dashboard: serving bundled UI at ${publicUrl}`);
  } else {
    console.warn(
      `⚠️  Dashboard: no build at ${DASHBOARD_DIST} - UI disabled (API still serves /api). ` +
        'Run `npm run build:all` to bundle it, or use the Vite dev server (`npm run dev`).',
    );
  }

  // The upgrade-insecure-requests trap (#731): the browser upgrades the UI's own script fetches to
  // https and a non-TLS server can't answer them, so the dashboard renders blank with nothing in the
  // server log. We can't tell a TLS proxy from direct HTTP at boot (`trust proxy` is off), so this
  // fires for both and the text says who should ignore it.
  if (
    isDashboardCspUpgradeTrapLikely({
      nodeEnv: process.env.NODE_ENV,
      cspEnv: process.env.CSP_UPGRADE_INSECURE_REQUESTS,
      dashboardServed: dashboardServingEnabled && dashboardBuildPresent,
    })
  ) {
    console.warn(
      '⚠️  Dashboard: CSP upgrade-insecure-requests is ON (production default). If this instance is ' +
        "reached over plain HTTP, the browser will upgrade the UI's scripts to https:// and the " +
        'dashboard will render blank. Behind a TLS proxy? Ignore this. Serving direct HTTP? Set ' +
        'CSP_UPGRADE_INSECURE_REQUESTS=false.',
    );
  }
}

// A failed bootstrap MUST terminate the process with a non-zero code, not just set `process.exitCode`:
// listen() runs the FULL init (sessions, Redis, pg, Chromium) before binding the port, so a bind failure
// (EADDRINUSE) would otherwise leave a zombie process — no HTTP port, yet still holding the event loop
// open and running WhatsApp sessions, invisible to Docker's restart policy. runBootstrapOrExit logs the
// failure, runs a bounded best-effort app.close() teardown, then exits(1); a successful boot returns
// without touching exit. Puppeteer's own `exit` handlers kill any browser children still up.
void runBootstrapOrExit(bootstrap, {
  logger: createLogger('Bootstrap'),
  closeApp: () => (appInstance ? appInstance.close() : Promise.resolve()),
});
