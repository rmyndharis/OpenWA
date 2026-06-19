import type { IncomingMessage } from '../interfaces/whatsapp-engine.interface';

/** Default inbound media cap: 50 MiB. Shares MEDIA_DOWNLOAD_MAX_BYTES with the outbound download cap. */
const DEFAULT_INBOUND_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

/** Resolved inbound media byte cap; a non-positive/garbage override falls back to the default. */
export function inboundMediaMaxBytes(): number {
  const parsed = Number.parseInt(process.env.MEDIA_DOWNLOAD_MAX_BYTES ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_INBOUND_MEDIA_MAX_BYTES;
}

type InboundMedia = NonNullable<IncomingMessage['media']>;

/**
 * Cap inbound media from an untrusted sender. Within the limit, keep it (base64 encoded via
 * `toBase64`). Over the limit, drop the blob and return a marker `{ mimetype, filename?, omitted,
 * sizeBytes }` so the `media` field stays present (n8n/dashboard contract) while the multi-MB
 * base64 is never encoded, persisted, webhooked, or broadcast.
 *
 * `toBase64` is a lazy callback so an over-cap payload is never base64-encoded — that +33% heap
 * copy is exactly the OOM vector this guards against.
 */
export function capInboundMedia(args: {
  mimetype: string;
  filename?: string;
  sizeBytes: number;
  toBase64: () => string;
  maxBytes?: number;
}): InboundMedia {
  const max = args.maxBytes ?? inboundMediaMaxBytes();
  if (args.sizeBytes > max) {
    return { mimetype: args.mimetype, filename: args.filename, omitted: true, sizeBytes: args.sizeBytes };
  }
  return { mimetype: args.mimetype, filename: args.filename, data: args.toBase64() };
}
