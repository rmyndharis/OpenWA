<?php

declare(strict_types=1);

namespace OpenWA;

use GuzzleHttp\ClientInterface;
use OpenWA\Exceptions\OpenWAException;
use OpenWA\Http\HttpExecutor;
use OpenWA\Resources\CatalogResource;
use OpenWA\Resources\CallsResource;
use OpenWA\Resources\MediaResource;
use OpenWA\Resources\ChannelsResource;
use OpenWA\Resources\ChatsResource;
use OpenWA\Resources\ContactsResource;
use OpenWA\Resources\GroupsResource;
use OpenWA\Resources\HealthResource;
use OpenWA\Resources\LabelsResource;
use OpenWA\Resources\MessagesResource;
use OpenWA\Resources\ProfileResource;
use OpenWA\Resources\SearchResource;
use OpenWA\Resources\SessionsResource;
use OpenWA\Resources\StatusResource;
use OpenWA\Resources\TemplatesResource;
use OpenWA\Resources\WebhooksResource;

/**
 * OpenWA PHP SDK — client core.
 *
 * The single entry point. It owns an {@see HttpExecutor} (which wraps a Guzzle
 * client with an injectable handler) and exposes domain resources as
 * properties:
 *
 * ```php
 * use OpenWA\Client;
 *
 * $client = new Client([
 *     'baseUrl' => 'http://localhost:2785',
 *     'apiKey'  => 'owa_k1_…',
 * ]);
 *
 * // Sessions are addressed by the UUID that create() returns, not by name.
 * $session = $client->sessions->create(['name' => 'my-session']);
 * $client->sessions->start($session['id']);
 * // Link the account before sending: scan sessions->getQrCode (or use sessions->requestPairingCode for a number with no linked session),
 * // then wait for status 'ready'. An unlinked session answers the send with 409.
 * $result = $client->messages->sendText($session['id'], [
 *     'chatId' => '628123456789@c.us',
 *     'text'   => 'Hello from the OpenWA PHP SDK!',
 * ]);
 * echo $result['messageId'];
 * ```
 *
 * For testing, inject a Guzzle client whose handler is a MockHandler.
 */
class Client
{
    private HttpExecutor $http;

    public SessionsResource $sessions;
    public MessagesResource $messages;
    public SearchResource $search;
    public ContactsResource $contacts;
    public GroupsResource $groups;
    public WebhooksResource $webhooks;
    public ChatsResource $chats;
    public StatusResource $status;
    public HealthResource $health;
    public LabelsResource $labels;
    public ChannelsResource $channels;
    public CatalogResource $catalog;
    public TemplatesResource $templates;
    public ProfileResource $profile;
    public CallsResource $calls;
    public MediaResource $media;

    /**
     * @param array{
     *     baseUrl:string,
     *     apiKey:string,
     *     timeout?:float,
     *     httpClient?:?\GuzzleHttp\ClientInterface|null,
     *     defaultHeaders?:array<string,scalar|null|non-empty-array<array-key,scalar|null>>,
     *     allowInsecureHttp?:bool
     * } $config
     *
     * @throws OpenWAException If baseUrl or apiKey is missing, the key holds a control or non-ASCII
     *         character (a surrounding space or newline is trimmed), or a default header name is not an
     *         HTTP token or its value holds such a character.
     */
    public function __construct(#[\SensitiveParameter] array $config)
    {
        if (empty($config['baseUrl'])) {
            throw new OpenWAException('OpenWA Client: baseUrl is required');
        }
        // A key read from a secret file usually ends in a newline, which the HTTP layer refuses with an error
        // that quotes the whole key. Trim it, and refuse a control or non-ASCII character left inside: the
        // gateway takes any printable ASCII, a space included, and the other clients send it as it is.
        $apiKey = is_string($config['apiKey'] ?? null) ? trim($config['apiKey']) : ($config['apiKey'] ?? '');
        if (empty($apiKey)) {
            throw new OpenWAException('OpenWA Client: apiKey is required');
        }
        if (!is_string($apiKey) || preg_match('/\A[\x20-\x7e]+\z/', $apiKey) !== 1) {
            throw new OpenWAException(
                'OpenWA Client: apiKey contains a control or non-ASCII character; check for a stray newline'
            );
        }

        if (empty($config['allowInsecureHttp'])) {
            self::warnIfInsecureHttp($config['baseUrl']);
        }

        // Before the executor exists: its constructor frame holds the key, which a trace shows in part on
        // PHP before 8.2, where #[\SensitiveParameter] does nothing.
        HttpExecutor::checkDefaultHeaders(is_array($config['defaultHeaders'] ?? null) ? $config['defaultHeaders'] : []);

        $this->http = new HttpExecutor(
            $config['baseUrl'],
            $apiKey,
            $config['timeout'] ?? 30.0,
            $config['httpClient'] ?? null,
            $config['defaultHeaders'] ?? [],
        );

        $this->sessions = new SessionsResource($this->http);
        $this->messages = new MessagesResource($this->http);
        $this->search = new SearchResource($this->http);
        $this->contacts = new ContactsResource($this->http);
        $this->groups = new GroupsResource($this->http);
        $this->webhooks = new WebhooksResource($this->http);
        $this->chats = new ChatsResource($this->http);
        $this->status = new StatusResource($this->http);
        $this->health = new HealthResource($this->http);
        $this->labels = new LabelsResource($this->http);
        $this->channels = new ChannelsResource($this->http);
        $this->catalog = new CatalogResource($this->http);
        $this->templates = new TemplatesResource($this->http);
        $this->profile = new ProfileResource($this->http);
        $this->calls = new CallsResource($this->http);
        $this->media = new MediaResource($this->http);
    }

    /**
     * Warn (not throw) when baseUrl is http:// and the host is not localhost. The API key is sent
     * as an X-API-Key header on every request — over plaintext http to a non-local host that's
     * cleartext on the wire. Warning (not refusing) keeps local dev and TLS-terminating-proxy
     * topologies working. It goes to error_log(), not trigger_error(): Laravel, Symfony and
     * PHPUnit's failOnWarning turn a PHP warning into an exception, which would make the client
     * impossible to construct. Set allowInsecureHttp to skip the check.
     */
    private static function warnIfInsecureHttp(string $url): void
    {
        $scheme = \parse_url($url, \PHP_URL_SCHEME);
        $host = \parse_url($url, \PHP_URL_HOST);
        // parse_url keeps the case as written, and both scheme and host are case-insensitive.
        if (\is_string($scheme) && \strtolower($scheme) === 'http' && \is_string($host)) {
            $host = \strtolower(\trim($host, '[]'));
            if (!\in_array($host, ['localhost', '127.0.0.1', '::1'], true)) {
                \error_log(
                    "OpenWA Client: baseUrl uses an insecure http:// URL (host: {$host}). "
                    . 'The API key will be sent in cleartext. Use https:// in production.'
                );
            }
        }
    }

    /** Validate the configured API key and resolve its role. */
    public function auth(): array
    {
        return $this->http->request('POST', '/api/auth/validate') ?? [];
    }

    /**
     * Issue a raw request against the API (advanced use).
     *
     * @param string              $path   Path beginning with /, e.g. /api/sessions.
     * @param array<string,mixed> $query  Query parameters (null values skipped).
     * @param mixed|null          $body   JSON-serializable request body.
     * @return mixed Decoded JSON, or null for empty/204 responses.
     */
    public function request(string $method, string $path, array $query = [], mixed $body = null): mixed
    {
        return $this->http->request($method, $path, $query, $body, null, true);
    }
}
