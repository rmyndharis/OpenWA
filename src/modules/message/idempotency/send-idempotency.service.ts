import { ConflictException, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { In, LessThanOrEqual, Repository } from 'typeorm';
import { SendIdempotencyKey } from '../entities/send-idempotency-key.entity';
import { pruneInBatches } from '../../../common/utils/batched-prune';
import { isUniqueViolation } from '../../../common/utils/db-errors';
import { createLogger } from '../../../common/services/logger.service';

/** How long a key stays bound to its first send. Matches the window most HTTP clients retry within. */
export const SEND_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A claim older than this whose request has not finished has almost certainly died with its node. One handed to the
 * engine ('pending') is then reported as outcome-unknown rather than in-progress: both answers are 409 and neither
 * sends. One that never reached the engine ('claimed') is taken over by the next request with the key. Generous,
 * because send pacing can hold a send.
 */
export const SEND_IDEMPOTENCY_STALE_PENDING_MS = 10 * 60 * 1000;

/** The first wait before a release the database refused is tried again, and the longest while it keeps refusing. */
const RELEASE_RETRY_BASE_MS = 1000;
const RELEASE_RETRY_CAP_MS = 30_000;

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** RFC-draft key syntax, kept strict so a key is safe to log and store verbatim: 1-255 visible ASCII. */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

export function isValidIdempotencyKey(key: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(key);
}

/**
 * Canonical JSON: object keys sorted at every depth, so `{a,b}` and `{b,a}` hash the same. Arrays keep
 * their order, which is meaningful (poll options, contact lists).
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .filter(k => (value as Record<string, unknown>)[k] !== undefined)
    .map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/** Fingerprint of one send request: the route plus its canonical body. */
export function hashSendRequest(route: string, body: unknown): string {
  return createHash('sha256')
    .update(route)
    .update('\n')
    .update(canonicalJson(body ?? null))
    .digest('hex');
}

export type SendIdempotencyClaim =
  /** This request owns the key and runs the send. */
  | { kind: 'claimed'; id: string }
  /** The key already completed this exact request; answer with the stored body, send nothing. */
  | { kind: 'replay'; body: unknown }
  /** The key is bound to a different route or body. */
  | { kind: 'mismatch' }
  /** Another request holding the key is still running. */
  | { kind: 'in_progress' }
  /** An earlier attempt with the key ended without saying whether the message went out. */
  | { kind: 'outcome_unknown' };

/**
 * Storage side of the opt-in `Idempotency-Key` header on the send routes (see
 * SendIdempotencyInterceptor). The claim is a plain INSERT against UNIQUE(sessionId, idempotencyKey),
 * so two concurrent requests with one key, on one node or several sharing the database, cannot both
 * run the send.
 */
@Injectable()
export class SendIdempotencyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('SendIdempotency');
  private pruneTimer: NodeJS.Timeout | null = null;
  // Claims a send freed while the database refused the delete, written once it answers. Lost with the process: a claim
  // left behind was never handed to the engine, so it is taken over once stale.
  private readonly owedReleases = new Set<string>();
  private releaseTimer: NodeJS.Timeout | null = null;
  private releaseDelayMs = RELEASE_RETRY_BASE_MS;
  private pruneInFlight: Promise<number> | null = null;
  private stopped = false;

  constructor(
    @InjectRepository(SendIdempotencyKey, 'data')
    private readonly keys: Repository<SendIdempotencyKey>,
  ) {}

  onModuleInit(): void {
    this.pruneTimer = setInterval(() => void this.pruneExpired(), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    await this.pruneInFlight?.catch(() => undefined);
  }

  async claim(input: {
    sessionId: string;
    key: string;
    route: string;
    requestHash: string;
  }): Promise<SendIdempotencyClaim> {
    // Two rounds at most: the second only runs after this call removed an expired row or a stale claim that never
    // reached the engine, and a request that wins the freed key in between is then simply the holder.
    for (let round = 0; round < 2; round++) {
      const now = new Date();
      try {
        // A bare INSERT, not save(): save() would wrap it in a transaction and, on Postgres, a failed
        // statement inside one poisons it; the unique violation is the expected answer here.
        const result = await this.keys.insert({
          sessionId: input.sessionId,
          idempotencyKey: input.key,
          route: input.route,
          requestHash: input.requestHash,
          state: 'claimed',
          expiresAt: new Date(now.getTime() + SEND_IDEMPOTENCY_TTL_MS),
        });
        return { kind: 'claimed', id: (result.identifiers[0] as { id: string }).id };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }

      const existing = await this.keys.findOne({
        where: { sessionId: input.sessionId, idempotencyKey: input.key },
      });
      // Released between our insert and this read: take another round at the insert.
      if (!existing) continue;
      if (existing.expiresAt.getTime() <= now.getTime()) {
        await this.keys.delete({ id: existing.id, expiresAt: LessThanOrEqual(now) });
        continue;
      }
      const verdict = this.classify(existing, input.requestHash, now);
      if (verdict !== 'abandoned') return verdict;
      // Only while still not handed over: a request that reaches the engine meanwhile keeps its key.
      await this.keys.delete({ id: existing.id, state: 'claimed' });
    }
    return { kind: 'in_progress' };
  }

  /** What a retry meets, or 'abandoned' for a stale claim that never reached the engine, which the retry takes over. */
  private classify(row: SendIdempotencyKey, requestHash: string, now: Date): SendIdempotencyClaim | 'abandoned' {
    if (row.requestHash !== requestHash) return { kind: 'mismatch' };
    if (row.state === 'completed') return { kind: 'replay', body: row.responseBody };
    if (row.state === 'failed') return { kind: 'outcome_unknown' };
    // The claim time is read back from expiresAt, which this service wrote through its own
    // transformer, rather than from the driver-hydrated createdAt.
    const claimedAt = row.expiresAt.getTime() - SEND_IDEMPOTENCY_TTL_MS;
    if (now.getTime() - claimedAt <= SEND_IDEMPOTENCY_STALE_PENDING_MS) return { kind: 'in_progress' };
    return row.state === 'claimed' ? 'abandoned' : { kind: 'outcome_unknown' };
  }

  /**
   * The send is handing its message to the engine: from here a failure may have sent it. Refused when the claim is no
   * longer this request's, because another request took over a claim that waited past the stale window.
   */
  async handOver(id: string): Promise<void> {
    const { affected } = await this.keys.update({ id, state: 'claimed' }, { state: 'pending' });
    if (affected) return;
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: 'Another request with this Idempotency-Key took over from this one, which sent nothing.',
      code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
    });
  }

  /** The send succeeded: store its answer for replay. */
  async complete(id: string, responseBody: unknown): Promise<void> {
    await this.keys.update(
      { id },
      {
        state: 'completed',
        responseBody: responseBody ?? null,
      },
    );
  }

  /**
   * The send was refused before anything reached WhatsApp: free the key for a corrected retry. A delete the database
   * refuses is tried again until it lands, so the retry a 503 invites is not held off for the key's whole window.
   */
  async release(id: string): Promise<void> {
    try {
      await this.keys.delete({ id, state: In(['claimed', 'pending']) });
    } catch (error) {
      this.oweRelease(id);
      throw error;
    }
  }

  private oweRelease(id: string): void {
    if (this.stopped) return;
    this.owedReleases.add(id);
    if (this.releaseTimer) return;
    this.releaseTimer = setTimeout(() => void this.retryReleases(), this.releaseDelayMs);
    this.releaseTimer.unref?.();
  }

  private async retryReleases(): Promise<void> {
    this.releaseTimer = null;
    for (const id of this.owedReleases) {
      try {
        await this.keys.delete({ id, state: In(['claimed', 'pending']) });
        this.owedReleases.delete(id);
      } catch {
        // Still refused: the rest wait for the next try, which comes later each time.
        this.releaseDelayMs = Math.min(this.releaseDelayMs * 2, RELEASE_RETRY_CAP_MS);
        break;
      }
    }
    if (this.owedReleases.size === 0) {
      this.releaseDelayMs = RELEASE_RETRY_BASE_MS;
      return;
    }
    if (this.stopped) return;
    this.releaseTimer = setTimeout(() => void this.retryReleases(), this.releaseDelayMs);
    this.releaseTimer.unref?.();
  }

  /** The send failed without saying whether the message went out: keep the key taken. */
  async markFailed(id: string): Promise<void> {
    await this.keys.update({ id }, { state: 'failed' });
  }

  /** Delete keys past their window, a batch at a time. Runs hourly; a claim also clears an expired row it collides with. */
  async pruneExpired(now = new Date()): Promise<number> {
    if (this.stopped) return 0;
    if (this.pruneInFlight) return this.pruneInFlight;
    const run = this.runPruneExpired(now);
    this.pruneInFlight = run;
    try {
      return await run;
    } finally {
      if (this.pruneInFlight === run) this.pruneInFlight = null;
    }
  }

  private async runPruneExpired(now: Date): Promise<number> {
    try {
      const removed = await pruneInBatches({
        repository: this.keys,
        where: { expiresAt: LessThanOrEqual(now) },
        stopped: () => this.stopped,
      });
      if (removed) {
        this.logger.debug(`Pruned ${removed} expired send idempotency key(s)`, {
          action: 'send_idempotency_prune',
        });
      }
      return removed;
    } catch (error) {
      this.logger.warn('Send idempotency key prune failed', {
        error: error instanceof Error ? error.message : String(error),
        action: 'send_idempotency_prune_failed',
      });
      return 0;
    }
  }
}
