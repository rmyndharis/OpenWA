<?php

declare(strict_types=1);

namespace OpenWA\Exceptions;

/** 403 Forbidden: the API key's role or scope (session, IP or chat allow-list) refuses the call. */
class OpenWAForbiddenException extends OpenWAApiException
{
}
