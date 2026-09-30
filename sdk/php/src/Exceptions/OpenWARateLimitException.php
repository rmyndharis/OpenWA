<?php

declare(strict_types=1);

namespace OpenWA\Exceptions;

/**
 * 429 Too Many Requests — rate limited.
 *
 * The global rate limiter's 429 lifts when its window expires (seconds for the
 * per-second tier, up to an hour for the hourly tier by default), and
 * getRetryAfterSeconds() carries its Retry-After header. A 429 whose
 * getErrorCode() is "SEND_PACING_LIMITED" is not transient: do not retry it
 * before getRetryAfterSeconds(), which then comes from the body and can be hours.
 */
class OpenWARateLimitException extends OpenWAApiException
{
}
