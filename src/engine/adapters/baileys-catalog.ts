import type { Product as BaileysProduct, WASocket } from '@whiskeysockets/baileys';
import { Catalog, PaginatedProducts, Product, ProductQueryOptions } from '../interfaces/whatsapp-engine.interface';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { withQueryDeadline } from './baileys-query-deadline';
import { type createLogger } from '../../common/services/logger.service';

/**
 * Catalog-domain operations extracted from BaileysAdapter (#905). makeBusinessSocket already
 * exposes getCatalog/getCollections — these are adapter mappings, not library workarounds.
 * The adapter keeps the public methods as thin forwarders and injects this narrow host surface
 * via closures, so the delegate never touches lifecycle state directly.
 */
export interface BaileysCatalogHost {
  ensureReady(): void;
  /** Post-ensureReady socket handle — call host.ensureReady() first. */
  getSocket(): WASocket;
  readonly logger: ReturnType<typeof createLogger>;
  normalizedSelfJid(): string;
}

/** Fetch page size for the catalog walk; larger pages mean fewer round trips to WhatsApp. */
const CATALOG_PAGE_SIZE = 50;

/**
 * Whole-request budget for a catalog read, spent across every page of the walk rather than
 * per query. Anchored to MEDIA_DOWNLOAD_TIMEOUT_MS (inbound-media-cap.ts), this repo's existing
 * number for one bounded network round trip over WhatsApp. It must stay below Baileys'
 * defaultQueryTimeoutMs (60s) to be observable at all, and below session.proxyTimeoutMs so a
 * multi-node deployment does not race two deadlines.
 */
export const CATALOG_QUERY_BUDGET_MS = 30_000;

export class BaileysCatalog {
  constructor(
    private readonly host: BaileysCatalogHost,
    private readonly budgetMs: number = CATALOG_QUERY_BUDGET_MS,
  ) {}

  /** Spend part of one request-wide budget on a single query, and say so when it runs out. */
  private async bounded<T>(work: Promise<T>, deadline: number): Promise<T> {
    try {
      return await withQueryDeadline(work, deadline - Date.now(), 'WhatsApp did not answer the catalog query in time');
    } catch (error) {
      if (error instanceof EngineTransportError) {
        // Baileys' own "timed out waiting for message" warn is silent at the default
        // BAILEYS_LOG_LEVEL, so without this line the 503 has no explanation anywhere.
        this.host.logger.warn('Catalog query exceeded its budget', { budgetMs: this.budgetMs });
      }
      throw error;
    }
  }

  /** Post-ensureReady socket handle. */
  private sock(): WASocket {
    return this.host.getSocket();
  }

  /**
   * Baileys' getCatalog returns products + cursor only; the catalog metadata our Catalog type
   * expects is synthesized from the first collection (the only named grouping the library
   * exposes). A business without collections has no catalog to describe — null.
   */
  async getCatalog(): Promise<Catalog | null> {
    this.host.ensureReady();
    const jid = this.host.normalizedSelfJid();
    const { collections } = await this.bounded(this.sock().getCollections(jid), Date.now() + this.budgetMs);
    const first = collections[0];
    if (!first) {
      return null;
    }
    const phone = jid.split('@')[0];
    return {
      id: first.id,
      name: first.name,
      productCount: first.products.length,
      url: `https://wa.me/c/${phone}`,
    };
  }

  async getProducts(options: ProductQueryOptions = {}): Promise<PaginatedProducts> {
    const all = (await this.fetchAllProducts()).map(mapProduct);
    const page = options.page ?? 1;
    const limit = options.limit ?? 20;
    return {
      products: all.slice((page - 1) * limit, page * limit),
      pagination: {
        page,
        limit,
        total: all.length,
        totalPages: Math.ceil(all.length / limit),
      },
    };
  }

  async getProduct(productId: string): Promise<Product | null> {
    const found = (await this.fetchAllProducts()).find(p => p.id === productId);
    return found ? mapProduct(found) : null;
  }

  /**
   * ponytail: walks the whole cursor chain on every call (no cursor cache), so page N costs the
   * full catalog. WhatsApp caps catalogs at ~500 products; if profiling shows the walk matters,
   * cache pages keyed by cursor and serve offsets from the cache.
   *
   * The budget is computed once and shared by every page: a per-query deadline would multiply by
   * the page count, making a ten-page walk slower than the 60s stall it replaces.
   */
  private async fetchAllProducts(): Promise<BaileysProduct[]> {
    this.host.ensureReady();
    const jid = this.host.normalizedSelfJid();
    const deadline = Date.now() + this.budgetMs;
    const products: BaileysProduct[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bounded(this.sock().getCatalog({ jid, limit: CATALOG_PAGE_SIZE, cursor }), deadline);
      products.push(...page.products);
      // A server echoing back the cursor it was handed would otherwise spin this loop until the
      // process runs out of heap — the accumulator grows on every pass.
      if (page.nextPageCursor === cursor) {
        break;
      }
      cursor = page.nextPageCursor;
    } while (cursor);
    return products;
  }
}

/**
 * Map Baileys' product node onto the engine-neutral Product: priceFormatted is synthesized
 * (Baileys carries only price + currency), the imageUrls map collapses to its first URL, and
 * availability is the library's 'in stock' literal.
 */
function mapProduct(p: BaileysProduct): Product {
  return {
    id: p.id,
    name: p.name,
    description: p.description || undefined,
    price: p.price,
    currency: p.currency,
    priceFormatted: formatPrice(p.price, p.currency),
    imageUrl: Object.values(p.imageUrls ?? {})[0],
    url: p.url ?? '',
    isAvailable: p.availability === 'in stock',
    retailerId: p.retailerId,
  };
}

function formatPrice(price: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(price);
  } catch {
    // Unknown/invalid ISO currency code — Intl throws RangeError; fall back to a plain pair.
    return `${currency} ${price}`;
  }
}
