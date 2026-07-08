import { DocumentBuilder, OpenAPIObject } from '@nestjs/swagger';

/**
 * Security scheme name for the API key, used both when defining the scheme and
 * when applying it as a global requirement so Swagger UI sends the header.
 */
export const API_KEY_SECURITY_SCHEME = 'X-API-Key';

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
      .build()
  );
}
