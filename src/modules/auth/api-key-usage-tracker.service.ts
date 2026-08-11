import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApiKey } from './entities/api-key.entity';
import { createLogger } from '../../common/services/logger.service';

/**
 * Coalesced usage statistics for API keys: `usageCount` and `lastUsedAt`.
 *
 * These are advisory — authentication never reads them — but they are written on the per-request
 * authentication hot path, so a naive implementation costs one DB write per request. The accumulator
 * below collapses that to at most one write per key per window, keeping the returned entity accurate
 * by adding the not-yet-persisted deltas to the value it hands back.
 *
 * It lives outside AuthService because the pending map was the one piece of state shared between
 * three otherwise-unrelated concerns: the authN hot path that increments it, admin key lifecycle that
 * drops a deleted or revoked key's counters, and shutdown that flushes what is left. None of those
 * change for the same reason.
 */
@Injectable()
export class ApiKeyUsageTracker {
  private readonly logger = createLogger('ApiKeyUsageTracker');

  /** Coalesce per-request usage-stat writes to at most one DB write per key per window. */
  private static readonly STAT_FLUSH_INTERVAL_MS = 60_000;
  /** Upper bound for the best-effort usage-stat flush on shutdown — teardown must not stall on a wedged DB. */
  private static readonly SHUTDOWN_FLUSH_TIMEOUT_MS = 5_000;
  /** keyId -> usage increments observed but not yet persisted (flushed on the next windowed write). */
  private readonly pending = new Map<string, number>();

  constructor(
    @InjectRepository(ApiKey, 'main')
    private readonly apiKeyRepository: Repository<ApiKey>,
  ) {}

  /**
   * Record one use of `apiKey`. Takes the ENTITY, not an id: it mutates `lastUsedAt`/`usageCount` on
   * the instance the caller is about to return, so the response reflects the true count including
   * increments still pending. Never throws — a stat-write failure must not fail an authenticated
   * request that already passed validation.
   */
  async record(apiKey: ApiKey): Promise<void> {
    const pending = (this.pending.get(apiKey.id) ?? 0) + 1;
    const previousLastUsedAt = apiKey.lastUsedAt;
    apiKey.lastUsedAt = new Date();
    apiKey.usageCount += pending; // DB value + all not-yet-persisted increments (incl. this request)

    const due =
      !previousLastUsedAt ||
      apiKey.lastUsedAt.getTime() - previousLastUsedAt.getTime() >= ApiKeyUsageTracker.STAT_FLUSH_INTERVAL_MS;
    if (!due) {
      this.pending.set(apiKey.id, pending);
      return;
    }
    this.pending.delete(apiKey.id);
    try {
      // Write the usage columns ONLY. `apiKey` is the entity this request loaded at authentication
      // time, so persisting it whole writes every column back as it was then — including isActive,
      // role, allowedSessions, allowedIps and expiresAt. An administrator change committed between
      // that load and this windowed write would be reverted by an advisory statistics update.
      // Worse for a DELETED key: revocation is a hard `remove()`, so `save()` finds no row for the
      // primary key and INSERTs it back, hash included — the credential authenticates again. An
      // `update()` by id affects zero rows instead. `forget()` closes the window for a key holding
      // only pending counters, but cannot reach an entity a request handler is already holding.
      // Same reasoning as flushPending() below, which writes one column for the same reason.
      await this.apiKeyRepository.update(
        { id: apiKey.id },
        { lastUsedAt: apiKey.lastUsedAt, usageCount: apiKey.usageCount },
      );
    } catch (error) {
      // Lost-update safe: a failed windowed write must not drop the accumulated increments —
      // merge them back (accumulate, never overwrite, in case a concurrent path re-added a
      // delta) so the next windowed write or the shutdown flush persists them.
      this.pending.set(apiKey.id, (this.pending.get(apiKey.id) ?? 0) + pending);
      this.logger.warn('Usage-stat write failed; delta kept pending for the next flush', {
        keyId: apiKey.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Drop a key's pending counters — the key is gone (deleted) or must stop counting (revoked). */
  forget(keyId: string): void {
    this.pending.delete(keyId);
  }

  /**
   * Best-effort flush of the coalesced counters on teardown. Nest runs the owning service's
   * onModuleDestroy before the TypeORM connection closes (the DataSource is destroyed in
   * onApplicationShutdown, the last lifecycle hook), so the DB is still writable here. Bounded so a
   * wedged DB cannot stall shutdown past the grace window; whatever is still unflushed after the
   * bound is dropped — the counters are advisory statistics, authentication never depends on them.
   */
  async flushOnShutdown(): Promise<void> {
    if (this.pending.size === 0) return;
    this.logger.log(`Flushing usage stats for ${this.pending.size} API key(s) before shutdown`);
    const timeout = new Promise<'timeout'>(resolve =>
      setTimeout(() => resolve('timeout'), ApiKeyUsageTracker.SHUTDOWN_FLUSH_TIMEOUT_MS).unref(),
    );
    const result = await Promise.race([this.flushPending().then(() => 'done' as const), timeout]);
    if (result === 'timeout') {
      this.logger.warn('Usage-stat shutdown flush exceeded its time bound; remaining deltas dropped');
    }
  }

  /** Persist every accumulated delta with an atomic increment; entries that fail stay pending. */
  private async flushPending(): Promise<void> {
    for (const [keyId, delta] of [...this.pending.entries()]) {
      if (delta <= 0) {
        this.pending.delete(keyId);
        continue;
      }
      try {
        // Atomic UPDATE ... SET usageCount = usageCount + delta — no read-modify-write race with a
        // concurrent windowed save, unlike reloading the row and saving it back.
        await this.apiKeyRepository.increment({ id: keyId }, 'usageCount', delta);
        this.pending.delete(keyId);
      } catch (error) {
        this.logger.warn('Usage-stat flush failed for a key; delta kept pending', {
          keyId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
