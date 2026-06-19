import { Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SessionPool } from './entities/session-pool.entity';
import { SessionService } from '../session/session.service';
import { SessionStatus } from '../session/entities/session.entity';
import { EventsGateway } from '../events/events.gateway';
import { createLogger } from '../../common/services/logger.service';

export interface PoolStatus {
  pool: SessionPool;
  production: Array<{ id: string; name: string; status: string }>;
  standby: Array<{ id: string; name: string; status: string }>;
}

export interface FailoverRecord {
  poolId: string;
  failedSessionId: string;
  promotedSessionId: string;
  timestamp: string;
}

@Injectable()
export class SessionPoolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('SessionPoolService');
  private timer: ReturnType<typeof setInterval> | null = null;
  // ponytail: in-memory failover history, reset on restart — persistent storage overkill for audit log
  private failoverHistory: FailoverRecord[] = [];

  constructor(
    @InjectRepository(SessionPool, 'data')
    private readonly poolRepo: Repository<SessionPool>,
    private readonly sessionService: SessionService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.checkPoolHealth(), 2 * 60 * 1000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async findAll(): Promise<SessionPool[]> {
    return this.poolRepo.find();
  }

  async findOne(poolId: string): Promise<SessionPool> {
    const pool = await this.poolRepo.findOne({ where: { id: poolId } });
    if (!pool) throw new NotFoundException(`Pool ${poolId} not found`);
    return pool;
  }

  async create(dto: { name: string; targetStandbyCount?: number; productionSessionIds?: string[]; standbySessionIds?: string[]; autoFailover?: boolean; standbyWarmupSeconds?: number }): Promise<SessionPool> {
    const pool = this.poolRepo.create({
      name: dto.name,
      targetStandbyCount: dto.targetStandbyCount ?? 1,
      productionSessionIds: JSON.stringify(dto.productionSessionIds ?? []),
      standbySessionIds: JSON.stringify(dto.standbySessionIds ?? []),
      autoFailover: dto.autoFailover ?? true,
      standbyWarmupSeconds: dto.standbyWarmupSeconds ?? 60,
    });
    return this.poolRepo.save(pool);
  }

  async update(poolId: string, dto: Partial<{ name: string; targetStandbyCount: number; productionSessionIds: string[]; standbySessionIds: string[]; autoFailover: boolean; standbyWarmupSeconds: number }>): Promise<SessionPool> {
    const pool = await this.findOne(poolId);
    const updates: Partial<SessionPool> = {};
    if (dto.name !== undefined) updates.name = dto.name;
    if (dto.targetStandbyCount !== undefined) updates.targetStandbyCount = dto.targetStandbyCount;
    if (dto.productionSessionIds !== undefined) updates.productionSessionIds = JSON.stringify(dto.productionSessionIds);
    if (dto.standbySessionIds !== undefined) updates.standbySessionIds = JSON.stringify(dto.standbySessionIds);
    if (dto.autoFailover !== undefined) updates.autoFailover = dto.autoFailover;
    if (dto.standbyWarmupSeconds !== undefined) updates.standbyWarmupSeconds = dto.standbyWarmupSeconds;
    await this.poolRepo.update(poolId, updates);
    return this.findOne(poolId);
  }

  async remove(poolId: string): Promise<void> {
    await this.findOne(poolId);
    await this.poolRepo.delete(poolId);
  }

  async getPoolStatus(poolId: string): Promise<PoolStatus> {
    const pool = await this.findOne(poolId);
    const productionIds: string[] = JSON.parse(pool.productionSessionIds);
    const standbyIds: string[] = JSON.parse(pool.standbySessionIds);

    const [productionSessions, standbySessions] = await Promise.all([
      Promise.all(productionIds.map(id => this.sessionService.findOne(id).catch(() => null))),
      Promise.all(standbyIds.map(id => this.sessionService.findOne(id).catch(() => null))),
    ]);

    return {
      pool,
      production: productionSessions
        .filter(Boolean)
        .map(s => ({ id: s!.id, name: s!.name, status: s!.status })),
      standby: standbySessions
        .filter(Boolean)
        .map(s => ({ id: s!.id, name: s!.name, status: s!.status })),
    };
  }

  async checkPoolHealth(): Promise<void> {
    try {
      const pools = await this.findAll();
      for (const pool of pools) {
        if (!pool.autoFailover) continue;
        const productionIds: string[] = JSON.parse(pool.productionSessionIds);

        for (const sessionId of productionIds) {
          try {
            const session = await this.sessionService.findOne(sessionId);
            if (session.status === SessionStatus.DISCONNECTED || session.status === SessionStatus.FAILED) {
              this.logger.warn(`Pool ${pool.name}: production session ${sessionId} is ${session.status}, initiating failover`);
              await this.failover(sessionId);
            }
          } catch {
            // Session not found — already deleted, skip
          }
        }
      }
    } catch (error) {
      this.logger.warn(`Pool health check failed: ${String(error)}`);
    }
  }

  async failover(failedSessionId: string): Promise<string> {
    const pools = await this.findAll();
    const pool = pools.find(p => {
      const ids: string[] = JSON.parse(p.productionSessionIds);
      return ids.includes(failedSessionId);
    });

    if (!pool) {
      throw new NotFoundException(`No pool found containing session ${failedSessionId}`);
    }

    const standbyIds: string[] = JSON.parse(pool.standbySessionIds);
    if (standbyIds.length === 0) {
      throw new Error(`Pool ${pool.name} has no standby sessions`);
    }

    // Find first healthy standby
    let promotedId: string | null = null;
    for (const id of standbyIds) {
      try {
        const session = await this.sessionService.findOne(id);
        if (session.status === SessionStatus.READY) {
          promotedId = id;
          break;
        }
      } catch {
        // Not found, skip
      }
    }

    if (!promotedId) {
      throw new Error(`Pool ${pool.name} has no ready standby sessions`);
    }

    await this.promoteStandby(promotedId, failedSessionId, pool);
    return promotedId;
  }

  async promoteStandby(standbyId: string, failedId: string, pool?: SessionPool): Promise<void> {
    const p = pool ?? (await this.findAll()).find(pl => {
      const ids: string[] = JSON.parse(pl.productionSessionIds);
      return ids.includes(failedId);
    });

    if (!p) throw new Error('Pool not found');

    const productionIds: string[] = JSON.parse(p.productionSessionIds);
    const standbyIds: string[] = JSON.parse(p.standbySessionIds);

    const newProduction = productionIds.map(id => (id === failedId ? standbyId : id));
    const newStandby = standbyIds.filter(id => id !== standbyId);

    await this.poolRepo.update(p.id, {
      productionSessionIds: JSON.stringify(newProduction),
      standbySessionIds: JSON.stringify(newStandby),
    });

    const record: FailoverRecord = {
      poolId: p.id,
      failedSessionId: failedId,
      promotedSessionId: standbyId,
      timestamp: new Date().toISOString(),
    };
    this.failoverHistory.unshift(record);
    if (this.failoverHistory.length > 100) this.failoverHistory.length = 100;

    this.eventsGateway.emitSessionStatus(standbyId, 'session.failover.complete');
    this.logger.log(`Failover complete: ${failedId} → ${standbyId} in pool ${p.name} at ${record.timestamp}`);

    // Replenish async — don't block the failover response
    void this.replenishPool(p.id);
  }

  async replenishPool(poolId: string): Promise<void> {
    const pool = await this.findOne(poolId);
    const standbyIds: string[] = JSON.parse(pool.standbySessionIds);
    const needed = pool.targetStandbyCount - standbyIds.length;

    if (needed <= 0) return;

    this.logger.log(`Pool ${pool.name} needs ${needed} new standby session(s) — replenishment requires manual session creation`);
    // Actual session creation requires a QR scan; just log the gap
  }

  getFailoverHistory(): FailoverRecord[] {
    return this.failoverHistory;
  }
}
