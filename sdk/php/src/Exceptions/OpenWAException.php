<?php

declare(strict_types=1);

namespace OpenWA\Exceptions;

/**
 * Base class for errors the OpenWA SDK throws for an API response or a timeout.
 *
 * A transport failure (a refused or reset connection, a DNS failure, a body cut short) surfaces as Guzzle's
 * `GuzzleHttp\Exception\TransferException`, and an invalid argument (an empty or dot id, a raw path without a
 * leading "/" or with a dot segment, an invalid idempotency key) throws `\InvalidArgumentException`.
 */
class OpenWAException extends \Exception
{
}
