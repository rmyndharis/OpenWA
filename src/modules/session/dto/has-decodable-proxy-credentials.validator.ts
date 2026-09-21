import { ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';

/**
 * Whether a proxy URL's credentials can be percent-decoded.
 *
 * `@IsUrl` accepts `http://user:pa%ss@proxy:8080`, and so does `new URL()`, which keeps the
 * credentials percent-encoded. Every consumer decodes them, and a lone `%` that begins no valid
 * escape makes `decodeURIComponent` throw `URI malformed`: inside the Baileys WebSocket agent, inside
 * undici's ProxyAgent, inside the whatsapp-web.js Chromium launch, and on the SSRF-guarded fetch of a
 * caller-supplied URL. Three of those four are library code, so the throw surfaces as an opaque
 * failure with nothing naming the credentials, and the session stays unstartable until an operator
 * guesses.
 *
 * Checked at the boundary instead, where the message can say what to do. A literal `%` in a password
 * is written `%25`.
 */
export function hasDecodableProxyCredentials(value: unknown): boolean {
  if (typeof value !== 'string' || value === '') return true; // other validators own shape and emptiness
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return true; // not a URL at all: @IsUrl reports that, and a second message would only confuse
  }
  try {
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return true;
  } catch {
    return false;
  }
}

@ValidatorConstraint({ name: 'hasDecodableProxyCredentials', async: false })
export class HasDecodableProxyCredentialsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return hasDecodableProxyCredentials(value);
  }
  defaultMessage(): string {
    return 'proxyUrl credentials contain an invalid percent-escape; write a literal % as %25';
  }
}
