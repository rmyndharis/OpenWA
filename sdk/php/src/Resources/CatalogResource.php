<?php

declare(strict_types=1);

namespace OpenWA\Resources;

use OpenWA\Http\HttpExecutor;

/**
 * Catalog resource — WhatsApp Business catalog, products, and product sends.
 *
 * Backed by src/modules/catalog/catalog.controller.ts (@Controller('sessions/:sessionId')).
 * NOTE: the catalog controller is mounted under the session root, so catalog
 * reads are /catalog... while product sends share the messages namespace
 * (/messages/send-product).
 */
class CatalogResource
{
    private HttpExecutor $http;

    public function __construct(HttpExecutor $http)
    {
        $this->http = $http;
    }

    /**
     * The catalog summary, or null when the account has no catalog collection to describe.
     * Baileys only; whatsapp-web.js answers 501.
     *
     * @return array<string,mixed>|null
     */
    public function info(string $sessionId): ?array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/catalog");
    }

    /**
     * List catalog products (paginated). Returns a page shaped
     * {products: list, pagination: {page, limit, total, totalPages}} — iterate over the `products`
     * field, not the result itself. Consistent with the JavaScript, Python, and Java SDKs.
     * Baileys only; whatsapp-web.js answers 501.
     *
     * @param array<string,mixed> $query  e.g. ['page' => 1, 'limit' => 20].
     * @return array{products: array<int,array<string,mixed>>, pagination: array<string,mixed>}
     */
    public function products(string $sessionId, array $query = []): array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/catalog/products", $query)
            ?? ['products' => [], 'pagination' => []];
    }

    /**
     * One catalog product, or null when no product in the catalog carries that id.
     * Baileys only; whatsapp-web.js answers 501.
     *
     * @return array<string,mixed>|null
     */
    public function product(string $sessionId, string $productId): ?array
    {
        return $this->http->request('GET', "/api/sessions/{$this->http->encodeSegment($sessionId)}/catalog/products/{$this->http->encodeSegment($productId)}");
    }

    /**
     * Send a product message. Requires an OPERATOR-level key. Shares the messages path.
     * Baileys only; whatsapp-web.js answers 501.
     *
     * @param array<string,mixed> $body  chatId + productId required; body optional.
     * @return array<string,mixed>
     */
    public function sendProduct(string $sessionId, array $body): array
    {
        return $this->http->request('POST', "/api/sessions/{$this->http->encodeSegment($sessionId)}/messages/send-product", [], $body);
    }
}
