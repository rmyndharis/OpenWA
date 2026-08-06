<?php

declare(strict_types=1);

namespace OpenWA\Exceptions;

/** 429 Too Many Requests — rate limited. */
class OpenWARateLimitException extends OpenWAApiException
{
}
