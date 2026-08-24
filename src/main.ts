// The env loader MUST be the first import: it populates process.env from .env / data/.env.generated
// before any other module is evaluated, so modules that read process.env at import time (e.g. the
// webhook Worker's @Processor connection) see the configured values rather than pre-dotenv defaults.
import './config/load-env';
import { NestFactory } from '@nestjs/core';
import { INestApplication, ShutdownSignal } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule, DASHBOARD_DIST, dashboardServingEnabled, dashboardBuildPresent } from './app.module';
import { ShutdownService } from './common/services/shutdown.service';
import { LoggerService, LogLevel, createLogger } from './common/services/logger.service';
import { createSwaggerConfig, dropUnexpressibleOperations, exemptPublicOperations } from './config/swagger.config';
import { registerUncaughtExceptionMonitor, registerUnhandledRejectionHandler } from './config/process-error-monitor';
import { runBootstrapOrExit } from './config/bootstrap-fatal';
import { resolveStorageRoot } from './config/storage-root';
import { applyHttpTimeouts, HttpTimeoutConfig, HttpTimeoutSink } from './config/http-timeouts';
import { applyGlobalValidation } from './config/app-validation';
import { configureApp } from './configure-app';
import {
  isSwaggerEnabled,
  isDashboardCspUpgradeTrapLikely,
  assertNoDefaultSecretsInProduction,
  isApiKeyPepperMissingInProduction,
  isNodeEnvUnset,
} from './config/bootstrap-security';
import { BullBoardAuthMiddleware } from './common/security/bull-board-auth.middleware';
import { AuthService } from './modules/auth/auth.service';
import { AuditService } from './modules/audit/audit.service';
import { Request, Response, NextFunction } from 'express';
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

  // Advisory (not enforced): an unset/blank NODE_ENV is the deliberate local-dev default, but it
  // silently degrades four controls to their dev posture (the default-secret guard, wildcard CORS,
  // Swagger UI, validation error detail) — warn so a production deployment that simply forgot the
  // variable can tell. The defaults themselves stay unchanged.
  if (isNodeEnvUnset(process.env.NODE_ENV)) {
    bootstrapLogger.warn(
      'NODE_ENV is not set: running with development defaults — the default-secret guard is skipped, ' +
        'wildcard CORS is allowed, Swagger UI is served, and validation error detail is exposed. ' +
        'Set NODE_ENV=production for a production deployment.',
    );
  }

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

  // The production HTTP surface: in-flight body budget, body parsers, request context, the CSP
  // nonce, helmet, the SPA document handler and CORS. Extracted so the e2e lane runs the SAME
  // stack instead of a copy of it (src/config/configure-app.ts).
  const { bodyLimit, inflightBudgetBytes } = configureApp(app);
  bootstrapLogger.log(`Request body caps: ${bodyLimit} per request, ${inflightBudgetBytes} bytes aggregate in flight`);

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

  // Shared production/e2e prefix and DTO validation contract.
  applyGlobalValidation(app);

  // Swagger documentation. ENABLE_SWAGGER wins; otherwise default on outside production, off in
  // production (the API schema is reconnaissance surface — production opts in with ENABLE_SWAGGER=true).
  const swaggerEnabled = isSwaggerEnabled(process.env.ENABLE_SWAGGER, process.env.NODE_ENV);
  if (swaggerEnabled) {
    const config = createSwaggerConfig();
    const document = SwaggerModule.createDocument(app, config);
    // Same two passes, in the same order, as scripts/export-openapi.ts. The document is produced in
    // TWO places — here for the live /api/docs and there for the committed snapshot — and fixing only
    // the snapshot leaves a running gateway serving a document that fails schema validation.
    dropUnexpressibleOperations(document);
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
