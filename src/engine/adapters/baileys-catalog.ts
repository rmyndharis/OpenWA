import type { Product as BaileysProduct, WASocket } from '@whiskeysockets/baileys';
import { Catalog, PaginatedProducts, Product, ProductQueryOptions } from '../interfaces/whatsapp-engine.interface';

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
  normalizedSelfJid(): string;
}

/** Fetch page size for the catalog walk; larger pages mean fewer round trips to WhatsApp. */
const CATALOG_PAGE_SIZE = 50;

export class BaileysCatalog {
  constructor(private readonly host: BaileysCatalogHost) {}

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
    const { collections } = await this.sock().getCollections(jid);
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
   */
  private async fetchAllProducts(): Promise<BaileysProduct[]> {
    this.host.ensureReady();
    const jid = this.host.normalizedSelfJid();
    const products: BaileysProduct[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.sock().getCatalog({ jid, limit: CATALOG_PAGE_SIZE, cursor });
      products.push(...page.products);
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
