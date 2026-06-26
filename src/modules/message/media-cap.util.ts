import { PayloadTooLargeException } from '@nestjs/common';
import { inboundMediaMaxBytes } from '../../engine/adapters/inbound-media-cap';

/**
 * Reject an outbound base64 media blob whose DECODED size exceeds the shared media byte cap
 * (`MEDIA_DOWNLOAD_MAX_BYTES`, default 50 MiB) — the same limit the remote-URL download and inbound
 * media paths already enforce. This closes the asymmetry where base64 sends were bounded only by the
 * coarse whole-request `BODY_SIZE_LIMIT`.
 *
 * `Buffer.byteLength(_, 'base64')` derives the decoded length from the string length and padding, so
 * the check never allocates the decoded buffer (no +33% heap copy of an oversized payload).
 */
export function assertBase64WithinMediaCap(base64: string | null | undefined): void {
  if (!base64) {
    return;
  }
  const maxBytes = inboundMediaMaxBytes();
  if (Buffer.byteLength(base64, 'base64') > maxBytes) {
    // 413 Payload Too Large, matching the documented MESSAGE_MEDIA_TOO_LARGE error code — distinct
    // from a generic 400 so clients can handle an oversized media payload specifically.
    throw new PayloadTooLargeException(`Base64 media exceeds the maximum allowed size of ${maxBytes} bytes`);
  }
}
