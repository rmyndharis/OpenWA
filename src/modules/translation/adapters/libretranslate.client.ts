// src/modules/translation/adapters/libretranslate.client.ts
import { Translator, DetectResult } from '../core/ports';
import { createLogger } from '../../../common/services/logger.service';

export interface LibreTranslateOptions {
  url: string;
  apiKey?: string;
  timeoutMs: number;
  failureThreshold?: number;
  cooldownMs?: number;
}

export class LibreTranslateClient implements Translator {
  private readonly logger = createLogger('LibreTranslateClient');
  private readonly base: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(private readonly opts: LibreTranslateOptions) {
    this.base = opts.url.replace(/\/+$/, '');
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30000;
  }

  isHealthy(): boolean {
    return this.consecutiveFailures < this.failureThreshold;
  }

  async detect(text: string): Promise<DetectResult> {
    const data = (await this.post('/detect', { q: text })) as Array<{ language: string; confidence: number }>;
    const top = data[0];
    if (!top) throw new Error('LibreTranslate /detect returned no result');
    return { lang: top.language, confidence: top.confidence };
  }

  async translate(text: string, source: string, target: string): Promise<string> {
    const data = (await this.post('/translate', { q: text, source, target, format: 'text' })) as {
      translatedText: string;
    };
    return data.translatedText;
  }

  async languages(): Promise<string[]> {
    const data = (await this.post('/languages', {}, 'GET')) as Array<{ code: string }>;
    return data.map(l => l.code);
  }

  private async post(
    path: string,
    payload: Record<string, unknown>,
    method: 'GET' | 'POST' = 'POST',
  ): Promise<unknown> {
    const now = Date.now();
    if (now < this.openUntil) {
      throw new Error('LibreTranslate circuit open');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const body = method === 'POST' ? JSON.stringify({ ...payload, api_key: this.opts.apiKey }) : undefined;
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`LibreTranslate ${path} -> HTTP ${res.status}`);
      }
      this.consecutiveFailures = 0;
      return await res.json();
    } catch (err) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.openUntil = Date.now() + this.cooldownMs;
        this.logger.warn(`LibreTranslate circuit opened for ${this.cooldownMs}ms`, { action: 'lt_circuit_open' });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
