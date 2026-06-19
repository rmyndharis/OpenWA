import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CacheService } from '../../common/cache/cache.service';
import { SessionService } from '../session/session.service';
import { HealthScoreService, HealthSnapshot } from './health-score.service';
import { createLogger } from '../../common/services/logger.service';

export interface HealthPrediction {
  sessionId: string;
  currentScore: number;
  trend: 'improving' | 'stable' | 'declining' | 'critical';
  slopePerHour: number;
  predictedScore1h: number;
  recommendAction: 'none' | 'watch' | 'reconnect' | 'alert';
}

const RECONNECT_COOLDOWN_KEY = (id: string) => `health:reconnect:cooldown:${id}`;
const RECONNECT_COOLDOWN_TTL = 30 * 60; // 30 min

// ponytail: simple least-squares slope — no library needed
function linearSlope(snapshots: HealthSnapshot[]): number {
  const n = snapshots.length;
  if (n < 2) return 0;
  const xs = snapshots.map((_, i) => i);
  const ys = snapshots.map(s => s.score);
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((sum, x, i) => sum + (x - xMean) * (ys[i] - yMean), 0);
  const den = xs.reduce((sum, x) => sum + Math.pow(x - xMean, 2), 0);
  return den === 0 ? 0 : num / den;
}

function classifyTrend(slope: number): HealthPrediction['trend'] {
  if (slope > 3) return 'improving';
  if (slope >= -2) return 'stable';
  if (slope >= -8) return 'declining';
  return 'critical';
}

@Injectable()
export class PredictiveHealthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('PredictiveHealthService');
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly cache: CacheService,
    private readonly sessionService: SessionService,
    private readonly healthScore: HealthScoreService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.runAnalysis(), 5 * 60 * 1000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async analyzeTrend(sessionId: string): Promise<HealthPrediction> {
    const snapshots = await this.healthScore.getSnapshots(sessionId);
    const recent = snapshots.slice(-6); // last 6

    const currentScore = recent.length > 0 ? recent[recent.length - 1].score : 0;
    const slope = linearSlope(recent);
    const trend = classifyTrend(slope);

    // Slope is per-interval (5 min). Convert to per-hour: * 12 intervals/hour
    const slopePerHour = slope * 12;
    const predictedScore1h = Math.max(0, Math.min(100, currentScore + slopePerHour));

    let recommendAction: HealthPrediction['recommendAction'] = 'none';
    if (trend === 'critical') recommendAction = 'alert';
    else if (predictedScore1h < 40 && trend === 'declining') recommendAction = 'reconnect';
    else if (trend === 'declining') recommendAction = 'watch';

    return { sessionId, currentScore, trend, slopePerHour, predictedScore1h, recommendAction };
  }

  async shouldPreemptiveReconnect(sessionId: string): Promise<boolean> {
    const prediction = await this.analyzeTrend(sessionId);
    if (prediction.recommendAction !== 'reconnect') return false;

    // Check cooldown
    const cooldown = await this.cache.rawGet(RECONNECT_COOLDOWN_KEY(sessionId));
    return !cooldown;
  }

  async triggerPreemptiveReconnect(sessionId: string): Promise<void> {
    // Set cooldown immediately to prevent double-trigger
    await this.cache.rawSet(RECONNECT_COOLDOWN_KEY(sessionId), RECONNECT_COOLDOWN_TTL, '1');

    this.logger.warn(`Triggering preemptive reconnect for session ${sessionId}`, {
      sessionId,
      action: 'predictive.reconnect.triggered',
    });

    try {
      await this.sessionService.stop(sessionId);
      await this.sessionService.start(sessionId);
      this.logger.log(`Preemptive reconnect complete for session ${sessionId}`, { sessionId });
    } catch (error) {
      this.logger.error(`Preemptive reconnect failed for session ${sessionId}`, String(error), { sessionId });
    }
  }

  async runAnalysis(): Promise<void> {
    try {
      const sessions = await this.sessionService.findAll();
      for (const session of sessions) {
        const shouldReconnect = await this.shouldPreemptiveReconnect(session.id);
        if (shouldReconnect) {
          await this.triggerPreemptiveReconnect(session.id);
        }
      }
    } catch (error) {
      this.logger.warn(`Predictive health analysis failed: ${String(error)}`);
    }
  }

  async getSessionPredictions(): Promise<HealthPrediction[]> {
    const sessions = await this.sessionService.findAll();
    return Promise.all(sessions.map(s => this.analyzeTrend(s.id)));
  }
}
