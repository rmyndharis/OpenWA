<?php

declare(strict_types=1);

namespace OpenWA\Exceptions;

/**
 * 503 Service Unavailable: the gateway could not complete the request right now.
 *
 * The path to WhatsApp failed (WhatsApp never replied, the socket was down, or the request budget
 * ran out), the gateway is draining or short of a dependency, or, on Baileys, WhatsApp itself
 * throttled (code 429) or timed out (code 408) the request; a throttle or timeout names its code in
 * the message. Retryable, but back off and retry later instead of at once: repeating a throttled
 * request straight away prolongs the throttle. A catalog 503 can persist because WhatsApp may never
 * answer that query, so bound any retry.
 *
 * On a send or a single write, a throttle turned the request away before it ran, so nothing was
 * sent or applied. A send also sent nothing when its recipient lookup failed, its connection closed
 * before the message was written, or its media or preview image URL could not be fetched through
 * the session's proxy. Each of these frees a keyed send's Idempotency-Key for the retry. A group
 * settings update with several fields applies them one at a time, so a 503 on a later field, a
 * throttle included, leaves the earlier ones applied; the message lists them after "already
 * applied:", so re-read the settings before retrying, or send one field per request. Any other
 * timeout proves nothing: the write may still have been applied, and a keyed send keeps its key taken. The
 * non-idempotent sends are deliberately left unbounded by the gateway so a slow WhatsApp reply
 * never answers one, and in a multi-node deployment a forward that fails before reaching the owner
 * node answers 503. A 503 from the owner itself is relayed unchanged and keeps its meaning, so a
 * bounded write (group, channel, contact or profile change) that timed out may still have been
 * applied; re-read the state before repeating it. A forward that fails after the request was sent
 * answers 502 or 504 instead (a plain OpenWAApiException): the owner may already have carried it
 * out, so do not repeat a non-idempotent send on those unchecked.
 */
class OpenWAServiceUnavailableException extends OpenWAApiException
{
}
