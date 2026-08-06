import { DocumentBuilder, OpenAPIObject } from '@nestjs/swagger';

/**
 * Security scheme name for the API key, used both when defining the scheme and
 * when applying it as a global requirement so Swagger UI sends the header.
 */
export const API_KEY_SECURITY_SCHEME = 'X-API-Key';

/**
 * Security scheme name for the METRICS_TOKEN bearer that gates `GET /api/metrics`.
 * The endpoint is @Public() at the API-key guard and enforces the token itself, so the
 * operation carries this scheme (which overrides the document's global X-API-Key
 * requirement per OpenAPI 3) instead of the API-key one.
 */
export const METRICS_BEARER_SCHEME = 'metrics-bearer';

// Routes whose controllers are @Public() — the ApiKeyGuard skips them at runtime, but the
// global X-API-Key requirement applied below would otherwise make the spec claim they need a
// key. Mirror the @Public() decorators: add a path here when you add one there.
export const PUBLIC_PATHS = [
  '/api/health',
  '/api/health/live',
  '/api/health/ready',
  '/api/infra/health',
  '/api/ingress/{pluginId}/{instanceId}/{path}',
];

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'trace', 'search'] as const;

type PathItem = Record<string, { security?: unknown } | undefined>;

/**
 * Set `security: []` on every operation of a @Public route so the published spec reflects
 * that no API key is required (an empty `security` array overrides the document's global
 * X-API-Key requirement per OpenAPI 3). Mutates and returns the document.
 */
export function exemptPublicOperations(document: OpenAPIObject): OpenAPIObject {
  for (const path of PUBLIC_PATHS) {
    const item = document.paths?.[path] as PathItem | undefined;
    if (!item) continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (op) op.security = [];
    }
  }
  return document;
}

/**
 * Builds the OpenAPI document configuration for the OpenWA API.
 */
export function createSwaggerConfig(): Omit<OpenAPIObject, 'paths'> {
  // Source the API version from package.json so it tracks releases automatically — no manual bump, no drift.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { version } = require('../../package.json') as { version: string };
  return (
    new DocumentBuilder()
      .setTitle('OpenWA API')
      .setDescription('Open Source WhatsApp API Gateway - Free, Self-Hosted HTTP API')
      .setVersion(version)
      .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, API_KEY_SECURITY_SCHEME)
      // The METRICS_TOKEN bearer gates only GET /api/metrics (applied per-operation there —
      // NOT as a global requirement, since every other route uses the API key).
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'opaque',
          description: 'METRICS_TOKEN for the GET /api/metrics scrape endpoint',
        },
        METRICS_BEARER_SCHEME,
      )
      // Apply the scheme globally so Swagger UI sends the key with every request
      // (mirrors the global ApiKeyGuard). Without this, "Authorize" is cosmetic.
      .addSecurityRequirements(API_KEY_SECURITY_SCHEME)
      .setContact('OpenWA', 'https://github.com/rmyndharis/OpenWA', 'yudhi@rmyndharis.com')
      .addTag('sessions', 'WhatsApp session management')
      .addTag('messages', 'Send and manage messages')
      .addTag('webhooks', 'Webhook configuration')
      .addTag('contacts', 'Contact management')
      .addTag('groups', 'Group management')
      .addTag('labels', 'Label management (WhatsApp Business)')
      .addTag('channels', 'Channel/Newsletter management')
      .addTag('catalog', 'Product catalog (WhatsApp Business)')
      .addTag('status', 'Status/Stories')
      .addTag('calls', 'Call handling')
      .addTag('profile', 'Own profile management')
      .addTag('search', 'Global message search')
      .addTag('statistics', 'Usage statistics')
      .addTag('templates', 'Message templates')
      .addTag('plugins', 'Plugin management')
      .addTag('settings', 'Application settings')
      .addTag('infrastructure', 'Infrastructure & datastore management')
      .addTag('integration', 'Integration Fabric (provider webhooks & instances)')
      .addTag('auth', 'API key management')
      .addTag('audit', 'Audit log')
      .addTag('metrics', 'Prometheus metrics')
      .addTag('health', 'Health check endpoints')
      // ORDER MATTERS. Swagger UI resolves "Try it" against servers[0], substituting the variable
      // defaults — it does not consider the origin the page was served from. A templated server
      // alone therefore aimed every request at `http://localhost:2785`, so on any deployment that
      // is not exactly that (a LAN address, a different PORT, a TLS proxy) Try-it called the
      // reader's own machine and failed with "Failed to fetch" — the browser's CSP `connect-src
      // 'self'` rejects the cross-origin call before it is even sent (#1068). A relative URL is
      // resolved against the document's own location, which is what OpenAPI 3 specifies and what
      // the spec did implicitly before it declared any server at all.
      //
      // So: relative first, and keep the templated absolute one second. Static consumers of
      // openapi.json still get a concrete base URL to display (#975), and the host/port editor
      // stays in the Servers dropdown for anyone pointing the docs at a different instance.
      .addServer('/', 'This instance (the origin serving these docs)')
      .addServer('http://{host}:{port}', 'Another instance (set host and port)', {
        host: { default: 'localhost' },
        port: { default: '2785', description: 'PORT env var' },
      })
      .build()
  );
}
