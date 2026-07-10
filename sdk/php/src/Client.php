<?php

declare(strict_types=1);

namespace OpenWA;

use GuzzleHttp\ClientInterface;
use OpenWA\Exceptions\OpenWAException;
use OpenWA\Http\HttpExecutor;
use OpenWA\Resources\CatalogResource;
use OpenWA\Resources\ChannelsResource;
use OpenWA\Resources\ChatsResource;
use OpenWA\Resources\ContactsResource;
use OpenWA\Resources\GroupsResource;
use OpenWA\Resources\HealthResource;
use OpenWA\Resources\LabelsResource;
use OpenWA\Resources\MessagesResource;
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
 * $client->sessions->start('my-session');
 * $result = $client->messages->sendText('my-session', [
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

    /**
     * @param array{
     *     baseUrl:string,
     *     apiKey:string,
     *     timeout?:float,
     *     httpClient?:?\GuzzleHttp\ClientInterface|null,
     *     defaultHeaders?:array<string,string>
     * } $config
     *
     * @throws OpenWAException If baseUrl or apiKey is missing.
     */
    public function __construct(array $config)
    {
        if (empty($config['baseUrl'])) {
            throw new OpenWAException('OpenWA Client: baseUrl is required');
        }
        if (empty($config['apiKey'])) {
            throw new OpenWAException('OpenWA Client: apiKey is required');
        }

        self::warnIfInsecureHttp($config['baseUrl']);

        $this->http = new HttpExecutor(
            $config['baseUrl'],
            $config['apiKey'],
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
    }

    /**
     * Warn (not throw) when baseUrl is http:// and the host is not localhost. The API key is sent
     * as an X-API-Key header on every request — over plaintext http to a non-local host that's
     * cleartext on the wire. Warning (not refusing) keeps local dev and TLS-terminating-proxy
     * topologies working.
     */
    private static function warnIfInsecureHttp(string $url): void
    {
        $scheme = \parse_url($url, \PHP_URL_SCHEME);
        $host = \parse_url($url, \PHP_URL_HOST);
        if ($scheme === 'http' && $host !== null && $host !== false) {
            $host = \trim($host, '[]');
            if (!\in_array($host, ['localhost', '127.0.0.1', '::1'], true)) {
                \trigger_error(
                    "OpenWA Client: baseUrl uses an insecure http:// URL (host: {$host}). "
                    . 'The API key will be sent in cleartext. Use https:// in production.',
                    \E_USER_WARNING
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
        return $this->http->request($method, $path, $query, $body);
    }
}
