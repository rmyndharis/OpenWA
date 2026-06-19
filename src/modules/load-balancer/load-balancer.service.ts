import { Injectable, OnModuleInit } from '@nestjs/common';
import { CacheService } from '../../common/cache/cache.service';
import { createLogger } from '../../common/services/logger.service';

export interface BanditScore {
  alpha: number;
  beta: number;
  estimatedRate: number;
}

// ponytail: Beta distribution approximation — mean + scaled noise. Faster than inverse-CDF.
function betaSample(alpha: number, beta: number): number {
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const noise = (Math.random() - 0.5) * Math.sqrt(variance) * 12;
  return Math.max(0.001, Math.min(0.999, mean + noise));
}

const LB_HASH = 'lb:bandit';
const LB_DAILY_HASH = 'lb:daily';
const LB_ENABLED_KEY = 'lb:enabled';
const LB_ENABLED_TTL = 86400;

@Injectable()
export class LoadBalancerService implements OnModuleInit {
  private readonly logger = createLogger('LoadBalancerService');
  private enabledInMemory = true;

  constructor(private readonly cache: CacheService) {}

  async onModuleInit(): Promise<void> {
    // Restore enabled state from Redis if available
    const stored = await this.cache.rawGet(LB_ENABLED_KEY);
    if (stored !== null) {
      this.enabledInMemory = stored === 'true';
    }
  }

  async selectSession(sessionIds: string[]): Promise<string> {
    if (sessionIds.length === 0) throw new Error('No sessions available');
    if (sessionIds.length === 1) return sessionIds[0];

    const scores = await this.getScores();
    let best = sessionIds[0];
    let bestSample = -1;

    for (const id of sessionIds) {
      const s = scores[id] ?? { alpha: 1, beta: 1, estimatedRate: 0.5 };
      const sample = betaSample(s.alpha, s.beta);
      if (sample > bestSample) {
        bestSample = sample;
        best = id;
      }
    }

    this.logger.debug(`Load balancer selected session ${best}`, { sessionId: best, sample: bestSample });
    return best;
  }

  async recordOutcome(sessionId: string, success: boolean): Promise<void> {
    const raw = await this.cache.rawHGetAll(LB_HASH);
    const current = raw[sessionId] ? (JSON.parse(raw[sessionId]) as { alpha: number; beta: number }) : { alpha: 1, beta: 1 };

    const updated = success
      ? { alpha: current.alpha + 1, beta: current.beta }
      : { alpha: current.alpha, beta: current.beta + 1 };

    await this.cache.rawHSet(LB_HASH, sessionId, JSON.stringify(updated));

    // Increment daily send counter
    const today = new Date().toISOString().slice(0, 10);
    const dailyKey = `${sessionId}:${today}`;
    const dailyRaw = await this.cache.rawHGetAll(LB_DAILY_HASH);
    const currentCount = parseInt(dailyRaw[dailyKey] ?? '0', 10);
    await this.cache.rawHSet(LB_DAILY_HASH, dailyKey, String(currentCount + 1));
  }

  async getScores(): Promise<Record<string, BanditScore>> {
    const raw = await this.cache.rawHGetAll(LB_HASH);
    const result: Record<string, BanditScore> = {};

    for (const [sessionId, json] of Object.entries(raw)) {
      const { alpha, beta } = JSON.parse(json) as { alpha: number; beta: number };
      result[sessionId] = { alpha, beta, estimatedRate: alpha / (alpha + beta) };
    }

    return result;
  }

  async resetScores(): Promise<void> {
    const raw = await this.cache.rawHGetAll(LB_HASH);
    if (Object.keys(raw).length > 0) {
      await this.cache.rawHDel(LB_HASH, ...Object.keys(raw));
    }
    this.logger.log('Load balancer scores reset');
  }

  async getDailyStats(): Promise<Record<string, number>> {
    const today = new Date().toISOString().slice(0, 10);
    const raw = await this.cache.rawHGetAll(LB_DAILY_HASH);
    const result: Record<string, number> = {};

    for (const [key, value] of Object.entries(raw)) {
      if (key.endsWith(`:${today}`)) {
        const sessionId = key.slice(0, -(today.length + 1));
        result[sessionId] = parseInt(value, 10);
      }
    }

    return result;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabledInMemory = enabled;
    await this.cache.rawSet(LB_ENABLED_KEY, LB_ENABLED_TTL, String(enabled));
    this.logger.log(`Load balancer ${enabled ? 'enabled' : 'disabled'}`);
  }

  isEnabled(): boolean {
    return this.enabledInMemory;
  }
}
