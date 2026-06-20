// src/modules/translation/adapters/libretranslate.client.ts
import { Translator, DetectResult } from './core/ports';
import { createLogger } from '../../../common/services/logger.service';
import { isSsrfProtectionEnabled, SsrfBlockedError, withSafeFetch } from '../../../common/security/ssrf-guard';

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

    const url = `${this.base}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const body = method === 'POST' ? JSON.stringify({ ...payload, api_key: this.opts.apiKey }) : undefined;
      // Route through the IP-pinned fetch: the host is validated once and the connection is pinned to the
      // vetted address(es), closing the DNS-rebinding window between check and connect (the api_key
      // travels in the body, so a rebind to an internal listener would otherwise exfiltrate it). Honors
      // SSRF_ALLOWED_HOSTS for the documented localhost sidecar, and refuses redirects. When SSRF
      // protection is disabled this degrades to a plain redirect-following fetch.
      const data = await withSafeFetch(
        url,
        { method, headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal },
        async res => {
          if (!res.ok) {
            throw new Error(`LibreTranslate ${path} -> HTTP ${res.status}`);
          }
          return res.json();
        },
        { guard: isSsrfProtectionEnabled() },
      );
      this.consecutiveFailures = 0;
      return data;
    } catch (err) {
      // A blocked-host SSRF error is a deterministic configuration problem, not a transient upstream
      // failure — don't let it trip the circuit breaker (which exists to back off a flaky server).
      if (err instanceof SsrfBlockedError) {
        throw err;
      }
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
