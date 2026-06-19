import { DocumentBuilder, OpenAPIObject } from '@nestjs/swagger';

/**
 * Security scheme name for the API key, used both when defining the scheme and
 * when applying it as a global requirement so Swagger UI sends the header.
 */
export const API_KEY_SECURITY_SCHEME = 'X-API-Key';

/**
 * Builds the OpenAPI document configuration for the OpenWA API.
 */
export function createSwaggerConfig(): Omit<OpenAPIObject, 'paths'> {
  return (
    new DocumentBuilder()
      .setTitle('OpenWA API')
      .setDescription('Open Source WhatsApp API Gateway - Free, Self-Hosted HTTP API')
      .setVersion('0.4.4')
      .addApiKey({ type: 'apiKey', name: 'X-API-Key', in: 'header' }, API_KEY_SECURITY_SCHEME)
      // Apply the scheme globally so Swagger UI sends the key with every request
      // (mirrors the global ApiKeyGuard). Without this, "Authorize" is cosmetic.
      .addSecurityRequirements(API_KEY_SECURITY_SCHEME)
      .addTag('sessions', 'WhatsApp session management')
      .addTag('messages', 'Send and manage messages')
      .addTag('webhooks', 'Webhook configuration')
      .addTag('contacts', 'Contact management')
      .addTag('groups', 'Group management')
      .addTag('labels', 'Label management (WhatsApp Business)')
      .addTag('channels', 'Channel/Newsletter management')
      .addTag('health', 'Health check endpoints')
      .build()
  );
}
