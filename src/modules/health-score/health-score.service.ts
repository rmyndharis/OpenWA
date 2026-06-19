import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CacheService } from '../../common/cache/cache.service';
import { SessionService } from '../session/session.service';
import { SessionStatus } from '../session/entities/session.entity';
import { createLogger } from '../../common/services/logger.service';

export interface HealthSnapshot {
  score: number;
  timestamp: string;
}

const STATUS_SCORES: Record<string, number> = {
  [SessionStatus.READY]: 90,
  [SessionStatus.AUTHENTICATING]: 65,
  [SessionStatus.QR_READY]: 55,
  [SessionStatus.INITIALIZING]: 50,
  [SessionStatus.DISCONNECTED]: 20,
  [SessionStatus.CREATED]: 40,
  [SessionStatus.FAILED]: 0,
};

const SNAPSHOTS_KEY = (id: string) => `health:snapshots:${id}`;
const MAX_SNAPSHOTS = 12; // keep last 12 (1 hour at 5-min intervals)
const SCORE_TTL = 3600 * 24; // 24h

@Injectable()
export class HealthScoreService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('HealthScoreService');
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly cache: CacheService,
    private readonly sessionService: SessionService,
  ) {}

  onModuleInit(): void {
    // ponytail: setInterval instead of @nestjs/schedule to avoid adding a dependency
    this.timer = setInterval(() => void this.collectSnapshots(), 5 * 60 * 1000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  computeScore(status: string): number {
    return STATUS_SCORES[status] ?? 0;
  }

  async collectSnapshots(): Promise<void> {
    try {
      const sessions = await this.sessionService.findAll();
      for (const session of sessions) {
        const score = this.computeScore(session.status);
        const snapshot: HealthSnapshot = { score, timestamp: new Date().toISOString() };
        const key = SNAPSHOTS_KEY(session.id);
        await this.cache.rawLPush(key, JSON.stringify(snapshot));
        await this.cache.rawLTrim(key, 0, MAX_SNAPSHOTS - 1);
        await this.cache.rawSet(`health:ttl:${session.id}`, SCORE_TTL, '1');
      }
    } catch (error) {
      this.logger.warn(`Health snapshot collection failed: ${String(error)}`);
    }
  }

  async getSnapshots(sessionId: string): Promise<HealthSnapshot[]> {
    const raw = await this.cache.rawLRange(SNAPSHOTS_KEY(sessionId), 0, MAX_SNAPSHOTS - 1);
    return raw.map(r => JSON.parse(r) as HealthSnapshot).reverse(); // oldest first
  }
}
