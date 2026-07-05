import type { IncomingMessage } from '../interfaces/whatsapp-engine.interface';

/** Default inbound media cap: 50 MiB. Shares MEDIA_DOWNLOAD_MAX_BYTES with the outbound download cap. */
const DEFAULT_INBOUND_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

/** Resolved inbound media byte cap; a non-positive/garbage override falls back to the default. */
export function inboundMediaMaxBytes(): number {
  const parsed = Number.parseInt(process.env.MEDIA_DOWNLOAD_MAX_BYTES ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_INBOUND_MEDIA_MAX_BYTES;
}

/** Default number of inbound media downloads processed at once. */
const DEFAULT_INBOUND_MEDIA_CONCURRENCY = 4;

/**
 * Max inbound media downloads processed concurrently. Each download materialises a full decrypted
 * buffer in heap, so an unbounded fire-and-forget loop lets a sender flood the gateway with N parallel
 * multi-MB allocations; this bounds N. Override via INBOUND_MEDIA_CONCURRENCY; garbage falls back.
 */
export function inboundMediaConcurrency(): number {
  const parsed = Number.parseInt(process.env.INBOUND_MEDIA_CONCURRENCY ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_INBOUND_MEDIA_CONCURRENCY;
}

/** Default inbound media download timeout: 30s. Shares MEDIA_DOWNLOAD_TIMEOUT_MS with the outbound download. */
const DEFAULT_INBOUND_MEDIA_TIMEOUT_MS = 30_000;

/** Resolved per-download wall-clock timeout; a non-positive/garbage override falls back to the default. */
export function inboundMediaTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.MEDIA_DOWNLOAD_TIMEOUT_MS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_INBOUND_MEDIA_TIMEOUT_MS;
}

/**
 * Bound an inbound media download by a wall-clock deadline. The byte cap and concurrency limiter don't
 * bound TIME: a remote sender can trickle bytes slowly (never tripping the cap) and hold a concurrency
 * slot indefinitely — a slow-loris on the inbound pipeline. On timeout `onTimeout` runs — a best-effort
 * hook to abort the source where it's abortable (e.g. destroy a Baileys stream) — and the result resolves
 * `null`, the same "no usable media" sentinel the byte-cap abort returns. A non-abortable source (the wwjs
 * `downloadMedia()`) can't be stopped, so that caller must instead hold its concurrency slot until the real
 * download settles. A late rejection from the abandoned download is swallowed so it can't surface as an
 * unhandled rejection after the race has already settled.
 */
export function withInboundDownloadTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
  });
  // Defuse a post-settle rejection from the download we may stop awaiting.
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Whether inbound media download is enabled. When false, the engine skips downloading media from
 * incoming messages entirely — no decryption, no memory allocation, no storage. Override via
 * MEDIA_DOWNLOAD_ENABLED; accepts 'false', '0', or 'no' (case-insensitive, whitespace-tolerant) to disable.
 */
export function isMediaDownloadEnabled(): boolean {
  const val = (process.env.MEDIA_DOWNLOAD_ENABLED ?? '').trim().toLowerCase();
  return val !== 'false' && val !== '0' && val !== 'no';
}

/**
 * Coerce a sender-declared media size (a protobuf `fileLength`, which may be a number, a Long-like
 * `{ toNumber() }`, a numeric string, or absent) to a finite byte count. Unknown/garbage → 0, i.e.
 * "don't pre-gate" (the streaming abort is the backstop), never NaN.
 */
export function coerceDeclaredSize(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value && typeof (value as { toNumber?: () => number }).toNumber === 'function') {
    const n = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

type InboundMedia = NonNullable<IncomingMessage['media']>;

/**
 * SECONDARY guard on inbound media from an untrusted sender. Within the limit, keep it (base64 via
 * `toBase64`). Over the limit, drop the blob and return a marker `{ mimetype, filename?, omitted,
 * sizeBytes }` so the `media` field stays present (n8n/dashboard contract) while the multi-MB base64
 * is never encoded, persisted, webhooked, or broadcast — the durable amplification.
 *
 * `toBase64` is a lazy callback so an over-cap payload is never base64-encoded (the +33% copy). NOTE:
 * this runs AFTER the bytes are in heap, so it does NOT bound the decrypted-download allocation — the
 * caller must do that with the pre-download declared-size gate + the streaming abort + the concurrency
 * limiter. This is the last line, not the OOM guard for the download itself.
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
