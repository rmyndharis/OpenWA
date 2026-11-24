import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { createLogger } from '../../common/services/logger.service';
import {
  WS_REDIS_COMMAND_TIMEOUT_MS,
  WS_REDIS_QUIT_TIMEOUT_MS,
  WS_REDIS_SOCKET_TIMEOUT_MS,
  wsRedisOptions,
} from './redis-io.adapter';

/** Redis set holding node keys that currently serve at least one chat-restricted WebSocket. */
export const WS_RESTRICTED_NODES_KEY = 'openwa:ws:restricted-nodes';
/** Per-node lease key prefix refreshed by each node's heartbeat while it holds restricted sockets. */
export const WS_RESTRICTED_NODE_KEY_PREFIX = 'openwa:ws:restricted-node:';
/** Lease TTL for one node's presence entry in Redis (3 heartbeats). */
export const WS_RESTRICTED_TTL_MS = 30_000;
/** Heartbeat interval that renews a node's lease while it holds restricted sockets. */
export const WS_RESTRICTED_HEARTBEAT_MS = 10_000;
/** Short TTL cache for {@link WsRestrictedPresenceTracker.hasRestrictedNodes} between Redis checks. */
export const WS_RESTRICTED_CACHE_TTL_MS = 2_000;

/** Max stale node members pruned per atomic Lua EVAL call to stay well below Redis arg limits. */
const PRUNE_CHUNK_SIZE = 500;

/**
 * Atomically prunes dead node members from the presence set only when their lease key is still
 * absent in Redis, returning how many candidate members were found alive (so a concurrent renewal
 * between MGET and EVAL is never clobbered and still reports restricted presence as active).
 *
 * KEYS[1]: presence set key
 * KEYS[2..N+1]: lease keys corresponding 1:1 with ARGV[1..N]
 * ARGV[1..N]: candidate dead node member ids
 */
export const PRUNE_STALE_MEMBERS_LUA = [
  'local setKey = KEYS[1]',
  'local alive = 0',
  'for i = 1, #ARGV do',
  "  if redis.call('EXISTS', KEYS[i + 1]) == 1 then",
  '    alive = alive + 1',
  '  else',
  "    redis.call('SREM', setKey, ARGV[i])",
  '  end',
  'end',
  'return alive',
].join('\n');

/** DI token allowing tests or modules to inject a custom presence tracker into EventsGateway. */
export const WS_RESTRICTED_PRESENCE_TRACKER = Symbol('WS_RESTRICTED_PRESENCE_TRACKER');

/**
 * Parse the integer reply of {@link PRUNE_STALE_MEMBERS_LUA}. Returns null for anything other than
 * a non-negative safe integer (or decimal-digit string) so unexpected replies fail open.
 */
function parsePruneAliveCount(reply: unknown): number | null {
  if (typeof reply === 'number') {
    return Number.isInteger(reply) && reply >= 0 ? reply : null;
  }
  if (typeof reply === 'string' && /^\d+$/.test(reply)) {
    const parsed = Number(reply);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Minimal Redis command surface needed by WsRestrictedPresenceTracker.
 * Satisfied structurally by ioredis.Redis and trivial to stub in unit tests.
 */
export interface RestrictedPresenceRedisClient {
  readonly status?: string;
  set(key: string, value: string, pxToken: 'PX', ttlMs: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  srem(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  eval(script: string, numkeys: number, ...args: string[]): Promise<unknown>;
  quit?(): Promise<unknown>;
  disconnect?(): void;
}

export interface WsRestrictedPresenceOptions {
  nodeId?: string;
  ownsClient?: boolean;
  ttlMs?: number;
  heartbeatMs?: number;
  cacheTtlMs?: number;
  hasLocalRestricted?: () => boolean;
}

/**
 * Tracks which replicas currently hold at least one chat-restricted WebSocket connection when
 * cross-replica Redis fan-out is enabled.
 *
 * Each node holding >= 1 restricted socket keeps a short-lived Redis lease key plus membership in
 * {@link WS_RESTRICTED_NODES_KEY}, renewed on a periodic `.unref()` heartbeat and deleted on
 * disconnect or shutdown. All local presence transitions are serialized through a single coalescing
 * loop so overlapping connects, disconnects, heartbeats, reconnects, and shutdown converge cleanly
 * to the latest local state. Emitting nodes check the set before expanding chat identities through
 * `lid_mappings` and prune expired members atomically via Lua: when Redis confirms zero live
 * restricted nodes cluster-wide, DB lookups and chat-room fan-out are skipped. Any missing client,
 * disconnected state, or Redis error fails open (returns true) so chat-restricted subscribers never
 * lose events during a Redis outage.
 */
export class WsRestrictedPresenceTracker {
  private readonly logger = createLogger('WsRestrictedPresence');
  readonly nodeKey: string;
  private readonly ttlMs: number;
  private readonly heartbeatMs: number;
  private readonly cacheTtlMs: number;
  private readonly ownsClient: boolean;
  private localCheck?: () => boolean;
  private desiredLocal = false;
  private destroyed = false;
  private registered = false;
  private dirty = false;
  private renewRequested = false;
  private syncGeneration = 0;
  private syncing = false;
  private syncLoop: Promise<void> | null = null;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private pendingCheck: Promise<boolean> | null = null;
  private cachedCheck: { value: boolean; expiresAt: number } | null = null;
  private checkEpoch = 0;

  constructor(
    private readonly client: RestrictedPresenceRedisClient | null,
    options: WsRestrictedPresenceOptions = {},
  ) {
    this.nodeKey = `${options.nodeId || 'node'}:${randomUUID().slice(0, 8)}`;
    this.ttlMs = options.ttlMs ?? WS_RESTRICTED_TTL_MS;
    this.heartbeatMs = options.heartbeatMs ?? WS_RESTRICTED_HEARTBEAT_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? WS_RESTRICTED_CACHE_TTL_MS;
    this.ownsClient = options.ownsClient ?? false;
    this.localCheck = options.hasLocalRestricted;
  }

  /** Create a tracker backed by its own lightweight, fail-fast ioredis client. */
  static createDefault(nodeId: string, hasLocalRestricted: () => boolean): WsRestrictedPresenceTracker {
    const logger = createLogger('WsRestrictedPresence');
    const redis = new Redis({
      ...wsRedisOptions(),
      commandTimeout: WS_REDIS_COMMAND_TIMEOUT_MS,
      socketTimeout: WS_REDIS_SOCKET_TIMEOUT_MS,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      lazyConnect: true,
    });
    redis.on('error', err => logger.warn(`WebSocket restricted-presence Redis error: ${err.message}`));
    const tracker = new WsRestrictedPresenceTracker(redis, {
      nodeId,
      ownsClient: true,
      hasLocalRestricted,
    });
    redis.on('ready', () => {
      tracker.handleRedisReady();
    });
    redis.connect().catch(() => undefined);
    return tracker;
  }

  /** Attach the gateway's local restricted-socket predicate (used by heartbeats and reconnects). */
  bindLocalCheck(hasLocalRestricted: () => boolean): void {
    this.localCheck = hasLocalRestricted;
  }

  /** Start the periodic `.unref()` heartbeat that renews this node's lease while needed. */
  start(): void {
    if (this.heartbeatTimer || !this.client || this.destroyed) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.destroyed) return;
      if (this.localCheck) this.desiredLocal = this.localCheck();
      if (this.desiredLocal) {
        void this.scheduleSync(true);
      } else if (this.registered || this.dirty) {
        void this.scheduleSync(false);
      }
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  /** Re-synchronize local presence after the Redis client finishes connecting or reconnecting. */
  handleRedisReady(): void {
    if (this.destroyed) return;
    this.invalidateCheckCache();
    if (this.localCheck) this.desiredLocal = this.localCheck();
    if (this.desiredLocal) {
      void this.scheduleSync(true);
    } else if (this.registered || this.dirty) {
      void this.scheduleSync(false);
    }
  }

  /** Update this node's Redis presence entry after a local restricted socket connects, subscribes, or disconnects. */
  syncLocal(hasLocalRestricted: boolean): Promise<void> {
    if (this.destroyed) return this.syncLoop ?? Promise.resolve();
    this.invalidateCheckCache();
    this.desiredLocal = hasLocalRestricted;
    return this.scheduleSync(false);
  }

  private invalidateCheckCache(): void {
    this.checkEpoch++;
    this.cachedCheck = null;
  }

  /**
   * Returns false only when Redis positively confirms zero active nodes hold a chat-restricted
   * socket; returns true (fail-open) if any node has a live lease or if Redis is absent,
   * disconnected, or errors.
   */
  hasRestrictedNodes(): Promise<boolean> {
    if (!this.isReady()) return Promise.resolve(true);
    const now = Date.now();
    if (this.cacheTtlMs > 0 && this.cachedCheck && now < this.cachedCheck.expiresAt) {
      return Promise.resolve(this.cachedCheck.value);
    }
    if (this.pendingCheck) return this.pendingCheck;
    const epoch = this.checkEpoch;
    const check = this.queryClusterRestrictedNodes(epoch).finally(() => {
      if (this.pendingCheck === check) this.pendingCheck = null;
    });
    this.pendingCheck = check;
    return check;
  }

  /** Stop the heartbeat timer, drain and clear this node's presence entry, and close any owned Redis client. */
  async destroy(): Promise<void> {
    this.destroyed = true;
    this.desiredLocal = false;
    this.renewRequested = false;
    this.invalidateCheckCache();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    const deadlineAt = Date.now() + WS_REDIS_QUIT_TIMEOUT_MS;
    const raceDeadline = async (work: Promise<unknown>): Promise<void> => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>(resolve => {
        timer = setTimeout(resolve, remaining);
        timer.unref?.();
      });
      try {
        await Promise.race([work, deadline]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    await raceDeadline(this.scheduleSync(false));
    if (!this.ownsClient || !this.client) return;
    try {
      await raceDeadline(this.client.quit?.().catch(() => undefined) ?? Promise.resolve());
    } finally {
      this.client.disconnect?.();
    }
  }

  private scheduleSync(forceRenew: boolean): Promise<void> {
    if (forceRenew && !this.destroyed) this.renewRequested = true;
    this.syncGeneration++;
    if (!this.syncing) {
      this.syncing = true;
      const loop = this.runSyncLoop();
      if (this.syncing) this.syncLoop = loop;
      return loop;
    }
    return this.syncLoop!;
  }

  private async runSyncLoop(): Promise<void> {
    try {
      while (true) {
        const gen = this.syncGeneration;
        const want = !this.destroyed && this.desiredLocal;
        const renew = this.renewRequested;
        this.renewRequested = false;

        if (want) {
          if (!this.registered || renew) {
            await this.registerLocal();
          }
        } else if (this.registered || this.dirty) {
          await this.unregisterLocal();
        }

        if (this.syncGeneration === gen && !this.renewRequested) {
          return;
        }
      }
    } finally {
      this.syncing = false;
      this.syncLoop = null;
    }
  }

  private isReady(): boolean {
    if (!this.client) return false;
    return this.client.status === undefined || this.client.status === 'ready';
  }

  private leaseKey(member: string): string {
    return `${WS_RESTRICTED_NODE_KEY_PREFIX}${member}`;
  }

  private async registerLocal(): Promise<void> {
    if (!this.isReady()) {
      this.registered = false;
      return;
    }
    this.dirty = true;
    try {
      await this.client!.set(this.leaseKey(this.nodeKey), '1', 'PX', this.ttlMs);
      if (this.destroyed) {
        this.registered = false;
        return;
      }
      await this.client!.sadd(WS_RESTRICTED_NODES_KEY, this.nodeKey);
      this.registered = true;
    } catch (err) {
      this.registered = false;
      this.logger.debug(
        `Could not register restricted-socket presence: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async unregisterLocal(): Promise<void> {
    this.registered = false;
    if (!this.isReady()) return;
    try {
      await this.client!.srem(WS_RESTRICTED_NODES_KEY, this.nodeKey);
      await this.client!.del(this.leaseKey(this.nodeKey));
      this.dirty = false;
    } catch (err) {
      this.logger.debug(
        `Could not clear restricted-socket presence: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async queryClusterRestrictedNodes(epoch: number): Promise<boolean> {
    try {
      const members = await this.client!.smembers(WS_RESTRICTED_NODES_KEY);
      if (!Array.isArray(members) || members.length === 0) {
        if (this.cacheTtlMs > 0 && epoch === this.checkEpoch && !this.destroyed) {
          this.cachedCheck = { value: false, expiresAt: Date.now() + this.cacheTtlMs };
        }
        return false;
      }
      const leases = await this.client!.mget(...members.map(member => this.leaseKey(member)));
      const dead: string[] = [];
      let alive = false;
      for (let i = 0; i < members.length; i++) {
        if (leases[i] !== null && leases[i] !== undefined) {
          alive = true;
        } else {
          dead.push(members[i]);
        }
      }
      if (dead.length > 0) {
        for (let offset = 0; offset < dead.length; offset += PRUNE_CHUNK_SIZE) {
          const batch = dead.slice(offset, offset + PRUNE_CHUNK_SIZE);
          const leaseKeys = batch.map(member => this.leaseKey(member));
          const stillAlive = parsePruneAliveCount(
            await this.client!.eval(
              PRUNE_STALE_MEMBERS_LUA,
              1 + leaseKeys.length,
              WS_RESTRICTED_NODES_KEY,
              ...leaseKeys,
              ...batch,
            ),
          );
          if (stillAlive === null || stillAlive > 0) alive = true;
        }
      }
      if (this.cacheTtlMs > 0 && epoch === this.checkEpoch && !this.destroyed) {
        this.cachedCheck = { value: alive, expiresAt: Date.now() + this.cacheTtlMs };
      }
      return alive;
    } catch (err) {
      this.logger.debug(
        `Could not query restricted-socket presence; failing open to chat-room fan-out: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return true;
    }
  }
}
