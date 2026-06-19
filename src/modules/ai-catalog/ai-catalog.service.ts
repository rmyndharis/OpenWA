import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { CatalogItem } from './entities/catalog-item.entity';
import { LlmService } from '../llm/llm.service';
import { HookManager } from '../../core/hooks/hook-manager.service';
import { HookContext, HookResult } from '../../core/hooks/hook.interfaces';
import { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';

export interface ImportResult {
  created: number;
  updated: number;
  errors: string[];
}

export interface CatalogAnswer {
  answer: string;
  matchedItems: CatalogItem[];
  confidence: 'high' | 'medium' | 'low' | 'no-match';
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') { inQuotes = !inQuotes; }
    else if (char === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else { current += char; }
  }
  result.push(current.trim());
  return result;
}

@Injectable()
export class AiCatalogService implements OnModuleInit {
  private readonly logger = new Logger(AiCatalogService.name);

  constructor(
    @InjectRepository(CatalogItem, 'data')
    private readonly repo: Repository<CatalogItem>,
    private readonly llm: LlmService,
    private readonly hookManager: HookManager,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    // ponytail: always register; env var is checked at message-receive time
    this.hookManager.register('ai-catalog', 'message:received', ctx => this.onMessage(ctx as HookContext<IncomingMessage>), 10);
  }

  private async onMessage(ctx: HookContext<IncomingMessage>): Promise<HookResult> {
    if (this.config.get('CATALOG_AUTO_REPLY') !== 'true') return { continue: true };

    const msg = ctx.data;
    if (ctx.source !== 'Engine' || !ctx.sessionId || msg.fromMe || msg.isGroup || !msg.body) {
      return { continue: true };
    }

    try {
      const answer = await this.answerQuery(ctx.sessionId, msg.body);
      if (answer.confidence === 'no-match') return { continue: true };
      // Return modified data so downstream handlers know the message was handled
      return { continue: false, data: { ...msg, _catalogAnswer: answer } as unknown as IncomingMessage };
    } catch (err) {
      this.logger.error('Catalog hook error', err);
      return { continue: true };
    }
  }

  async importCsv(sessionId: string, csvContent: string): Promise<ImportResult> {
    const lines = csvContent.trim().split('\n').filter(l => l.trim());
    if (lines.length < 2) return { created: 0, updated: 0, errors: ['CSV has no data rows'] };

    const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase().replace(/^"|"$/g, ''));
    const result: ImportResult = { created: 0, updated: 0, errors: [] };

    for (let i = 1; i < lines.length; i++) {
      try {
        const values = parseCsvLine(lines[i]);
        const row: Record<string, string> = {};
        headers.forEach((h, idx) => { row[h] = (values[idx] ?? '').replace(/^"|"$/g, ''); });

        const knownKeys = new Set(['sku', 'name', 'description', 'price', 'currency', 'category', 'stock']);
        const attrs: Record<string, string> = {};
        for (const k of Object.keys(row)) {
          if (!knownKeys.has(k) && row[k]) attrs[k] = row[k];
        }

        await this.upsertItem(sessionId, {
          sku: row['sku'] || `row-${i}`,
          name: row['name'] || '',
          description: row['description'] || '',
          price: row['price'] ? parseFloat(row['price']) : undefined,
          currency: row['currency'] || undefined,
          category: row['category'] || undefined,
          stock: row['stock'] || undefined,
          attributes: Object.keys(attrs).length ? JSON.stringify(attrs) : undefined,
        }, result);
      } catch (e) {
        result.errors.push(`Row ${i}: ${(e as Error).message}`);
      }
    }

    return result;
  }

  async importJson(sessionId: string, items: Partial<CatalogItem>[]): Promise<ImportResult> {
    const result: ImportResult = { created: 0, updated: 0, errors: [] };
    for (let i = 0; i < items.length; i++) {
      try {
        await this.upsertItem(sessionId, items[i], result);
      } catch (e) {
        result.errors.push(`Item ${i}: ${(e as Error).message}`);
      }
    }
    return result;
  }

  private async upsertItem(sessionId: string, data: Partial<CatalogItem>, result: ImportResult): Promise<void> {
    const existing = data.sku ? await this.repo.findOne({ where: { sessionId, sku: data.sku } }) : null;
    if (existing) {
      await this.repo.save({ ...existing, ...data, sessionId, embeddingJson: null });
      result.updated++;
    } else {
      await this.repo.save(this.repo.create({ ...data, sessionId, available: data.available ?? true }));
      result.created++;
    }
  }

  async embedAll(sessionId: string): Promise<void> {
    const items = await this.repo.find({ where: { sessionId } });
    for (const item of items) {
      if (item.embeddingJson) continue;
      const text = `${item.name} ${item.description} ${item.category ?? ''} ${item.attributes ?? ''}`;
      try {
        const embedding = await this.llm.embed(text);
        await this.repo.save({ ...item, embeddingJson: JSON.stringify(embedding) });
      } catch (e) {
        this.logger.warn(`Embed failed for ${item.sku}: ${(e as Error).message}`);
      }
    }
  }

  async search(sessionId: string, query: string, topK = 5): Promise<CatalogItem[]> {
    const items = await this.repo.find({ where: { sessionId, available: true } });
    const embedded = items.filter(i => i.embeddingJson);
    if (!embedded.length) return [];

    const queryVec = await this.llm.embed(query);
    const scored = embedded.map(item => ({
      item,
      score: cosineSimilarity(queryVec, JSON.parse(item.embeddingJson!)),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(s => s.item);
  }

  async answerQuery(sessionId: string, question: string): Promise<CatalogAnswer> {
    const matched = await this.search(sessionId, question, 5);
    if (!matched.length) return { answer: "I'm sorry, I couldn't find any matching products in our catalog.", matchedItems: [], confidence: 'no-match' };

    const itemList = matched.map(i =>
      `- ${i.name} (${i.sku}): ${i.description}. Price: ${i.price ?? 'N/A'} ${i.currency ?? ''}. Status: ${i.stock || (i.available ? 'in-stock' : 'out-of-stock')}. Attributes: ${i.attributes ?? '{}'}`
    ).join('\n');

    const response = await this.llm.complete([
      {
        role: 'user',
        content: `You are a helpful product assistant for a WhatsApp business. Answer this customer question using the product catalog below. Be concise and specific. If no items match, say so politely.\n\nQuestion: ${question}\n\nCatalog items:\n${itemList}\n\nAnswer:`,
      },
    ], { maxTokens: 300 });

    const answer = response.content.trim();
    const noMatchPhrases = ['no matching', 'cannot find', 'don\'t have', 'do not have', 'not available', 'out of stock'];
    const confidence = noMatchPhrases.some(p => answer.toLowerCase().includes(p)) ? 'low' : matched.length >= 3 ? 'high' : 'medium';

    return { answer, matchedItems: matched, confidence };
  }

  async list(sessionId: string): Promise<CatalogItem[]> {
    return this.repo.find({ where: { sessionId }, order: { createdAt: 'DESC' } });
  }

  async updateItem(id: string, sessionId: string, data: Partial<CatalogItem>): Promise<CatalogItem> {
    const item = await this.repo.findOneOrFail({ where: { id, sessionId } });
    return this.repo.save({ ...item, ...data, embeddingJson: null });
  }

  async deleteItem(id: string, sessionId: string): Promise<void> {
    await this.repo.delete({ id, sessionId });
  }

  async stats(sessionId: string): Promise<{ total: number; embedded: number; available: number }> {
    const all = await this.repo.find({ where: { sessionId } });
    return {
      total: all.length,
      embedded: all.filter(i => !!i.embeddingJson).length,
      available: all.filter(i => i.available).length,
    };
  }
}
