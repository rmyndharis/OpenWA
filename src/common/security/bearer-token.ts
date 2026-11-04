/**
 * The credential of an `Authorization: Bearer <token>` header, or `undefined` for any other shape.
 * The scheme is matched case-insensitively (RFC 7235 section 2.1), so every surface that reads the
 * header accepts the same spellings.
 */
export function bearerToken(header: string | undefined): string | undefined {
  return header ? /^bearer\s+(\S+)\s*$/i.exec(header)?.[1] : undefined;
}

/** The headers an API key can arrive in; Express and Node both type them like this. */
interface KeyHeaders {
  'x-api-key'?: string | string[];
  authorization?: string | string[];
}

/**
 * The API key a request presents: the `X-API-Key` header, else an `Authorization: Bearer` token. The REST
 * guard, the health probe, Bull Board, the key index and the MCP gate read it through here, so none of
 * them can disagree on what the credential is; the `/events` handshake reads `auth.apiKey`, then
 * `x-api-key`, on its own. An empty value is as good as absent. Node joins a repeated `X-API-Key` into one
 * string (`first, second`), which is no key on any surface, while a repeated `Authorization` keeps its
 * first value. The array branch of `first` is for a headers object built by hand, as the unit tests do.
 */
export function presentedApiKey(headers: KeyHeaders): string | undefined {
  const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);
  return first(headers['x-api-key']) || bearerToken(first(headers.authorization));
}
