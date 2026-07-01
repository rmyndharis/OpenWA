// The env loader MUST be the first import: it populates process.env from .env / data/.env.generated
// before any other module is evaluated, so modules that read process.env at import time (e.g. the
// webhook Worker's @Processor connection) see the configured values rather than pre-dotenv defaults.
import './config/load-env';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule, DASHBOARD_DIST, dashboardServingEnabled, dashboardBuildPresent } from './app.module';
import { ShutdownService } from './common/services/shutdown.service';
import { LoggerService, LogLevel, createLogger } from './common/services/logger.service';
import { createSwaggerConfig } from './config/swagger.config';
import {
  resolveCorsPolicy,
  isSwaggerEnabled,
  resolveBodyLimit,
  assertNoDefaultSecretsInProduction,
  isApiKeyPepperMissingInProduction,
} from './config/bootstrap-security';
import { BullBoardAuthMiddleware } from './common/security/bull-board-auth.middleware';
import { AuthService } from './modules/auth/auth.service';
import { Request, Response, NextFunction, json, urlencoded } from 'express';

async function bootstrap() {
  // Apply the operator-configured log verbosity (LOG_LEVEL) before anything logs. Unset/invalid → INFO.
  const requestedLevel = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (requestedLevel && (Object.values(LogLevel) as string[]).includes(requestedLevel)) {
    LoggerService.setLogLevel(requestedLevel as LogLevel);
  }

  // Backstop for promise rejections that escaped a local handler (e.g. a fire-and-forget engine-event
  // dispatch). Node terminates the process on an unhandled rejection by default; for a long-running
  // self-hosted gateway we'd rather log it and stay up than let one stray rejection kill all sessions.
  const bootstrapLogger = createLogger('Bootstrap');
  process.on('unhandledRejection', (reason: unknown) => {
    bootstrapLogger.error('Unhandled promise rejection', reason instanceof Error ? reason.stack : String(reason));
  });

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

  // Disable Nest's default body parser so we can set an explicit size cap below.
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Cap request body size (DoS hardening). Media sends carry base64 in the JSON body,
  // so the default is generous; tune with BODY_SIZE_LIMIT.
  const bodyLimit = resolveBodyLimit(process.env.BODY_SIZE_LIMIT);
  // The `verify` callback stashes the EXACT bytes json() received on req.rawBody, byte-identical to
  // what a provider signed, so the @Public ingress controller can HMAC-verify over the raw body
  // (JSON.stringify(req.body) is NOT byte-identical). Cheap for every route; non-ingress routes ignore it.
  app.use(
    json({
      limit: bodyLimit,
      verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(urlencoded({ extended: true, limit: bodyLimit }));

  // Enable shutdown hooks for graceful shutdown
  app.enableShutdownHooks();

  // Wire up graceful shutdown service
  const shutdownService = app.get(ShutdownService);
  shutdownService.setShutdownCallback(async () => {
    await app.close();
  });

  // On a termination signal, flip readiness to 503 immediately so the load
  // balancer/orchestrator stops routing new traffic. This only sets a flag — NestJS's
  // own shutdown hooks (enabled above) still perform the actual app.close()/teardown.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => shutdownService.markShuttingDown());
  }

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
          scriptSrc: ["'self'"],
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
          upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
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
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    maxAge: 86400, // 24 hours
  });

  // Global prefix
  app.setGlobalPrefix('api');

  // Enhanced Validation pipe with security options
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strip properties not in DTO
      forbidNonWhitelisted: true, // Throw error on unknown properties
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
      disableErrorMessages: process.env.NODE_ENV === 'production', // Hide details in prod
    }),
  );

  // Swagger documentation. ENABLE_SWAGGER wins; otherwise default on outside production, off in
  // production (the API schema is reconnaissance surface — production opts in with ENABLE_SWAGGER=true).
  const swaggerEnabled = isSwaggerEnabled(process.env.ENABLE_SWAGGER, process.env.NODE_ENV);
  if (swaggerEnabled) {
    const config = createSwaggerConfig();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  // Protect the Bull Board queue UI (/api/admin/queues). It is mounted by
  // @bull-board/nestjs as raw Express middleware that the global ApiKeyGuard
  // does not cover; registering this before app.listen() ensures it runs ahead
  // of the Bull Board router. Requires a valid ADMIN API key.
  const bullBoardAuth = new BullBoardAuthMiddleware(app.get(AuthService), app.get(ConfigService));
  app.use('/api/admin/queues', (req: Request, res: Response, next: NextFunction) => {
    void bullBoardAuth.use(req, res, next);
  });

  const port = process.env.PORT || 2785;
  await app.listen(port);

  console.log(`🚀 OpenWA is running on: http://localhost:${port}`);
  if (swaggerEnabled) {
    console.log(`📚 Swagger docs: http://localhost:${port}/api/docs`);
  }

  // Make the dashboard-serving outcome explicit so a missing build (no UI on `/`)
  // is obvious instead of a silent 404.
  if (!dashboardServingEnabled) {
    console.log('🖥️  Dashboard: serving disabled (SERVE_DASHBOARD=false); API only');
  } else if (dashboardBuildPresent) {
    console.log(`🖥️  Dashboard: serving bundled UI at http://localhost:${port}`);
  } else {
    console.warn(
      `⚠️  Dashboard: no build at ${DASHBOARD_DIST} - UI disabled (API still serves /api). ` +
        'Run `npm run build:all` to bundle it, or use the Vite dev server (`npm run dev`).',
    );
  }
}

void bootstrap();
