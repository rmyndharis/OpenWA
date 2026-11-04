import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { inboundMediaMaxBytes } from '../../engine';
import { isMediaUrl, MEDIA_URL_MESSAGE } from '../../common/media/media-url';

/**
 * Accept the historical `data:<mime>;base64,<payload>` form without passing its metadata prefix to
 * an engine as if it were encoded bytes. Plain base64 is returned unchanged.
 */
export function stripBase64DataUri(base64: string | null | undefined): string | undefined {
  if (base64 == null) return undefined;
  const match = /^data:[^,]*;base64,/i.exec(base64);
  return match ? base64.slice(match[0].length) : base64;
}

/**
 * Reject an outbound base64 media blob whose DECODED size exceeds the shared media byte cap
 * (`MEDIA_DOWNLOAD_MAX_BYTES`, default 50 MiB) — the same limit the remote-URL download and inbound
 * media paths already enforce. This closes the asymmetry where base64 sends were bounded only by the
 * coarse whole-request `BODY_SIZE_LIMIT`.
 *
 * `Buffer.byteLength(_, 'base64')` derives the decoded length from the string length and padding, so
 * the check never allocates the decoded buffer (no +33% heap copy of an oversized payload).
 *
 * `capBytes` lowers the cap for a field that needs less (a link preview's thumbnail); it only tightens.
 */
export function assertBase64WithinMediaCap(base64: string | null | undefined, capBytes?: number): void {
  const normalized = stripBase64DataUri(base64);
  if (!normalized) {
    return;
  }
  const maxBytes = Math.min(capBytes ?? Number.POSITIVE_INFINITY, inboundMediaMaxBytes());
  if (Buffer.byteLength(normalized, 'base64') > maxBytes) {
    // 413 Payload Too Large, matching the documented MESSAGE_MEDIA_TOO_LARGE error code — distinct
    // from a generic 400 so clients can handle an oversized media payload specifically.
    throw new PayloadTooLargeException(`Base64 media exceeds the maximum allowed size of ${maxBytes} bytes`);
  }
}

/** Room for a `data:<mime>;base64,` prefix, which the exact check strips, when only the length is known. */
const DATA_URI_PREFIX_ALLOWANCE_CHARS = 256;

/**
 * The same refusal as {@link assertBase64WithinMediaCap}, for a base64 string that has not been built yet and
 * is known only by its length (a template renders to it). Refuses only a length certain to decode past the cap,
 * after allowing for a data URI prefix; whatever is borderline passes, and the exact check on the finished
 * string decides.
 */
export function assertBase64LengthWithinMediaCap(chars: number): void {
  const maxBytes = inboundMediaMaxBytes();
  if (Math.floor(((chars - DATA_URI_PREFIX_ALLOWANCE_CHARS) * 3) / 4) > maxBytes) {
    throw new PayloadTooLargeException(`Base64 media exceeds the maximum allowed size of ${maxBytes} bytes`);
  }
}

/** A request body that carries media as a URL, as base64, or as both. */
export interface MediaBody {
  url?: string;
  base64?: string;
  mimetype?: string;
}

export interface MediaBodyOptions {
  /** The type used when the body names none. */
  fallbackMimetype: string;
  /** A base64 body has to name its type; a URL is typed by what it answers with. */
  requireMimetypeForBase64?: boolean;
  /**
   * A body without base64 has to carry an absolute http(s) URL, since both engines decode anything
   * else as base64. The DTO checks this too, but a plugin send and a hook rewrite reach the service
   * without it.
   */
  checkUrl?: boolean;
}

/**
 * The media a url-or-base64 body stands for, checked the way every media write checks it. One of the two
 * has to be given, and base64 wins when it holds data: a stale `url` left in a body (a Swagger example, say)
 * must not be fetched in its place (#670). Base64 is bounded to the media byte cap before it is persisted or
 * handed to an engine; a URL is capped while it streams. The checks run in the order listed in the options.
 */
export function resolveMediaBody(
  body: MediaBody | undefined,
  options: MediaBodyOptions,
): { mimetype: string; data: string } {
  const base64 = stripBase64DataUri(body?.base64);
  const url = body?.url;
  if (!url && !base64) {
    throw new BadRequestException('Either url or base64 must be provided');
  }
  if (options.checkUrl && !base64 && !isMediaUrl(url)) {
    throw new BadRequestException(MEDIA_URL_MESSAGE);
  }
  if (options.requireMimetypeForBase64 && base64 && !body?.mimetype) {
    throw new BadRequestException('mimetype is required when using base64 data');
  }
  assertBase64WithinMediaCap(base64);
  return { mimetype: body?.mimetype || options.fallbackMimetype, data: base64 || url! };
}
