/**
 * Client-side checks for the webhook forms' custom headers and signing secret, mirroring
 * `IsHeaderMap` and the secret bounds in src/modules/webhook/dto so a bad value is caught inline
 * instead of coming back as a raw validation message. Errors are i18n keys.
 */

export interface HeaderRow {
  name: string;
  value: string;
}

export type HeaderMapResult = { ok: true; headers: Record<string, string> } | { ok: false; error: string };

const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const MAX_HEADERS = 50;
const MAX_VALUE_LENGTH = 1024;

// The gateway accepts these names but drops them at delivery (sanitizeCustomHeaders in
// deliver-once.ts), so a row naming one would be saved and silently never sent.
function isDroppedAtDelivery(name: string): boolean {
  return (
    /^(content-type|x-openwa-)/i.test(name) ||
    /^(connection|content-length|expect|keep-alive|te|trailer|transfer-encoding|upgrade|user-agent)$/i.test(name)
  );
}

// Header values go out as Latin-1 bytes: control characters, DEL and anything above U+00FF are refused.
function hasInvalidValueChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c > 0xff) return true;
  }
  return false;
}

/** Build the `headers` map from the editor rows. Fully blank rows are skipped; values are sent as typed. */
export function buildHeaderMap(rows: readonly HeaderRow[]): HeaderMapResult {
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const { name, value } of rows) {
    if (!name && !value) continue;
    if (!HEADER_NAME.test(name)) return { ok: false, error: 'webhooks.auth.errors.headerName' };
    if (isDroppedAtDelivery(name)) return { ok: false, error: 'webhooks.auth.errors.headerReserved' };
    if (seen.has(name.toLowerCase())) return { ok: false, error: 'webhooks.auth.errors.headerDuplicate' };
    if (value.length > MAX_VALUE_LENGTH || hasInvalidValueChar(value)) {
      return { ok: false, error: 'webhooks.auth.errors.headerValue' };
    }
    seen.add(name.toLowerCase());
    headers[name] = value;
  }
  if (seen.size > MAX_HEADERS) return { ok: false, error: 'webhooks.auth.errors.tooMany' };
  return { ok: true, headers };
}

/** Null when the secret is acceptable: empty (not sent) or 16 to 255 characters. Never trimmed. */
export function secretError(secret: string): string | null {
  if (secret === '' || (secret.length >= 16 && secret.length <= 255)) return null;
  return 'webhooks.auth.errors.secretLength';
}

/** A random signing secret: 32 bytes as 64 hex characters. getRandomValues also works over plain HTTP. */
export function generateSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}
