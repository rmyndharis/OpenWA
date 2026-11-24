import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import WebSocket from 'ws';
// Load EventsGateway before AuthService because the two modules import each other
// and constructor metadata on EventsGateway requires AuthService to be defined first.
import { EventsGateway } from '../src/modules/events/events.gateway';
import { AuditService } from '../src/modules/audit/audit.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { ChatScopeService } from '../src/modules/auth/chat-scope.service';
import { RedisIoAdapter } from '../src/modules/events/redis-io.adapter';
import {
  PRUNE_STALE_MEMBERS_LUA,
  WS_RESTRICTED_NODE_KEY_PREFIX,
  WS_RESTRICTED_NODES_KEY,
  WsRestrictedPresenceTracker,
} from '../src/modules/events/ws-restricted-presence';
import { waitUntil } from './helpers/wait-until';

const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);

const probeRedis = (host: string, port: number, timeoutMs: number): boolean => {
  const script =
    `const s = require('net').connect(${port}, ${JSON.stringify(host)});` +
    `const t = setTimeout(() => process.exit(2), ${timeoutMs});` +
    `s.on('connect', () => { clearTimeout(t); s.end(); process.exit(0); });` +
    `s.on('error', () => { clearTimeout(t); process.exit(1); });`;
  return spawnSync(process.execPath, ['-e', script], { timeout: timeoutMs + 1000 }).status === 0;
};

const REDIS_AVAILABLE = probeRedis(REDIS_HOST, REDIS_PORT, 1000);
if (!REDIS_AVAILABLE && process.env.GITHUB_ACTIONS === 'true') {
  throw new Error(`events-redis e2e: no Redis at ${REDIS_HOST}:${REDIS_PORT} under GitHub Actions; refusing to skip`);
}
const describeWithRedis = REDIS_AVAILABLE ? describe : describe.skip;

const leaseKeyOf = (member: string): string => `${WS_RESTRICTED_NODE_KEY_PREFIX}${member}`;

describeWithRedis('WebSocket Redis presence Lua and RedisIoAdapter against real Redis', () => {
  const prevRedisEnabled = process.env.REDIS_ENABLED;
  const prevRedisHost = process.env.REDIS_HOST;
  const prevRedisPort = process.env.REDIS_PORT;

  let redis: Redis;
  const createdMembers = new Set<string>();
  const trackersToDestroy: WsRestrictedPresenceTracker[] = [];
  const appsToClose: INestApplication[] = [];
  const socketsToTerminate: WebSocket[] = [];

  const trackMember = (member: string): string => {
    createdMembers.add(member);
    return member;
  };

  const cleanupCreatedRedisState = async (): Promise<void> => {
    if (createdMembers.size === 0) return;
    const members = [...createdMembers];
    createdMembers.clear();
    await redis.srem(WS_RESTRICTED_NODES_KEY, ...members);
    await redis.del(...members.map(leaseKeyOf));
  };

  beforeAll(async () => {
    process.env.REDIS_ENABLED = 'true';
    process.env.REDIS_HOST = REDIS_HOST;
    process.env.REDIS_PORT = String(REDIS_PORT);
    redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: 1 });
    await redis.ping();
  });

  afterEach(async () => {
    for (const ws of socketsToTerminate.splice(0)) {
      ws.terminate();
    }
    for (const tracker of trackersToDestroy.splice(0)) {
      await tracker.destroy();
    }
    for (const app of appsToClose.splice(0)) {
      await app.close();
    }
    await cleanupCreatedRedisState();
    process.env.REDIS_ENABLED = 'true';
    process.env.REDIS_HOST = REDIS_HOST;
    process.env.REDIS_PORT = String(REDIS_PORT);
  });

  afterAll(async () => {
    await cleanupCreatedRedisState();
    await redis?.quit().catch(() => undefined);
    if (redis && redis.status !== 'end') {
      redis.disconnect();
    }
    // ioredis's AbstractConnector.disconnect() called after quit() arms a 2000 ms disconnectTimeout
    // on the already-closed stream inside RedisIoAdapter/WsRestrictedPresenceTracker; let it settle
    // so Jest exits cleanly without an open-handle warning.
    await new Promise(resolve => setTimeout(resolve, 2100));

    if (prevRedisEnabled === undefined) delete process.env.REDIS_ENABLED;
    else process.env.REDIS_ENABLED = prevRedisEnabled;
    if (prevRedisHost === undefined) delete process.env.REDIS_HOST;
    else process.env.REDIS_HOST = prevRedisHost;
    if (prevRedisPort === undefined) delete process.env.REDIS_PORT;
    else process.env.REDIS_PORT = prevRedisPort;
  });

  describe('WsRestrictedPresenceTracker and PRUNE_STALE_MEMBERS_LUA', () => {
    it('prunes expired and orphaned node members atomically while preserving live nodes', async () => {
      const liveTracker = new WsRestrictedPresenceTracker(redis, { nodeId: `live-${randomUUID()}`, ttlMs: 30_000 });
      const expiredTracker = new WsRestrictedPresenceTracker(redis, { nodeId: `exp-${randomUUID()}`, ttlMs: 80 });
      const observerTracker = new WsRestrictedPresenceTracker(redis, { nodeId: `obs-${randomUUID()}`, cacheTtlMs: 0 });
      trackersToDestroy.push(liveTracker, expiredTracker, observerTracker);
      trackMember(liveTracker.nodeKey);
      trackMember(expiredTracker.nodeKey);

      const orphanMember = trackMember(`orphan-${randomUUID()}`);

      await liveTracker.syncLocal(true);
      await expiredTracker.syncLocal(true);
      await redis.sadd(WS_RESTRICTED_NODES_KEY, orphanMember);

      // Wait until the short-lived lease key genuinely expires inside Redis.
      await waitUntil(async () => (await redis.exists(leaseKeyOf(expiredTracker.nodeKey))) === 0, 5_000);
      expect(await redis.exists(leaseKeyOf(expiredTracker.nodeKey))).toBe(0);
      expect(await redis.exists(leaseKeyOf(liveTracker.nodeKey))).toBe(1);

      // Querying cluster presence runs PRUNE_STALE_MEMBERS_LUA against real Redis.
      expect(await observerTracker.hasRestrictedNodes()).toBe(true);

      const membersAfterPrune = await redis.smembers(WS_RESTRICTED_NODES_KEY);
      expect(membersAfterPrune).toContain(liveTracker.nodeKey);
      expect(membersAfterPrune).not.toContain(expiredTracker.nodeKey);
      expect(membersAfterPrune).not.toContain(orphanMember);

      // Clearing the last live node brings cluster restricted presence cleanly down to false.
      await liveTracker.syncLocal(false);
      expect(await observerTracker.hasRestrictedNodes()).toBe(false);
      expect(await redis.sismember(WS_RESTRICTED_NODES_KEY, liveTracker.nodeKey)).toBe(0);
    });

    it('keeps a candidate member whose lease exists at EVAL time and returns the live count', async () => {
      const staleMember = trackMember(`lua-stale-${randomUUID()}`);
      const liveMember = trackMember(`lua-live-${randomUUID()}`);

      await redis.sadd(WS_RESTRICTED_NODES_KEY, staleMember, liveMember);
      await redis.set(leaseKeyOf(liveMember), '1', 'PX', 10_000);

      const alive = await redis.eval(
        PRUNE_STALE_MEMBERS_LUA,
        3,
        WS_RESTRICTED_NODES_KEY,
        leaseKeyOf(staleMember),
        leaseKeyOf(liveMember),
        staleMember,
        liveMember,
      );

      expect(alive).toBe(1);
      expect(await redis.sismember(WS_RESTRICTED_NODES_KEY, staleMember)).toBe(0);
      expect(await redis.sismember(WS_RESTRICTED_NODES_KEY, liveMember)).toBe(1);
    });

    it('initializes createDefault against real Redis, tracks local state, and tears down cleanly', async () => {
      const observer = new WsRestrictedPresenceTracker(redis, { nodeId: `obs-${randomUUID()}`, cacheTtlMs: 0 });
      trackersToDestroy.push(observer);

      let localRestricted = true;
      const tracker = WsRestrictedPresenceTracker.createDefault(`default-${randomUUID()}`, () => localRestricted);
      trackersToDestroy.push(tracker);
      trackMember(tracker.nodeKey);
      tracker.start();

      await waitUntil(async () => (await redis.sismember(WS_RESTRICTED_NODES_KEY, tracker.nodeKey)) === 1, 5_000);
      expect(await redis.sismember(WS_RESTRICTED_NODES_KEY, tracker.nodeKey)).toBe(1);
      expect(await redis.exists(leaseKeyOf(tracker.nodeKey))).toBe(1);
      expect(await observer.hasRestrictedNodes()).toBe(true);

      localRestricted = false;
      await tracker.syncLocal(false);
      expect(await redis.sismember(WS_RESTRICTED_NODES_KEY, tracker.nodeKey)).toBe(0);
      expect(await redis.exists(leaseKeyOf(tracker.nodeKey))).toBe(0);
      expect(await observer.hasRestrictedNodes()).toBe(false);

      await tracker.destroy();
      trackersToDestroy.pop();
    });
  });

  describe('RedisIoAdapter pub/sub initialization, cross-replica fan-out, and teardown', () => {
    const restrictedKey = {
      id: 'k-restricted',
      name: 'restricted-e2e',
      role: 'viewer',
      isActive: true,
      allowedSessions: null,
      allowedChats: ['alice@c.us'],
    };

    const bootReplica = async (nodeId: string) => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          EventsGateway,
          ChatScopeService,
          { provide: AuthService, useValue: { validateApiKey: () => Promise.resolve(restrictedKey) } },
          { provide: AuditService, useValue: { logWarn: () => Promise.resolve(null) } },
          {
            provide: ConfigService,
            useValue: {
              get: (key: string, fallback?: unknown) => (key === 'session.nodeId' ? nodeId : fallback),
            },
          },
        ],
      }).compile();
      const app = moduleRef.createNestApplication({ logger: false });
      const adapter = new RedisIoAdapter(app);
      app.useWebSocketAdapter(adapter);
      await app.listen(0, '127.0.0.1');
      appsToClose.push(app);
      const port = ((app.getHttpServer() as HttpServer).address() as AddressInfo).port;
      const gateway = app.get(EventsGateway);
      return { app, adapter, gateway, port };
    };

    const openEventsSocket = async (
      port: number,
      namespaceConnectFrame: string,
    ): Promise<{ ws: WebSocket; frames: string[]; closed: () => boolean }> => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
      socketsToTerminate.push(ws);
      const frames: string[] = [];
      let closed = false;
      ws.on('message', (data: Buffer) => {
        const frame = data.toString();
        frames.push(frame);
        if (frame === '2') ws.send('3');
        if (frame.startsWith('0')) ws.send(namespaceConnectFrame);
      });
      ws.on('close', () => {
        closed = true;
      });
      await waitUntil(() => frames.some(f => f.startsWith('40/events,') || f.startsWith('44')), 5_000);
      return { ws, frames, closed: () => closed };
    };

    const numSubEvents = async (): Promise<number> => {
      const reply = (await redis.pubsub('NUMSUB', 'socket.io-request#/events#')) as [string, number];
      return Number(reply[1] ?? 0);
    };

    it('initializes pub/sub clients, fans out events across replicas, refuses root namespace, and tears down cleanly', async () => {
      const baselineSubCount = await numSubEvents();
      const replicaA = await bootReplica(`replica-a-${randomUUID()}`);
      const replicaB = await bootReplica(`replica-b-${randomUUID()}`);

      const internalA = replicaA.adapter as unknown as { pubClient?: Redis; subClient?: Redis };
      const internalB = replicaB.adapter as unknown as { pubClient?: Redis; subClient?: Redis };
      expect(internalA.pubClient).toBeDefined();
      expect(internalA.subClient).toBeDefined();
      expect(internalB.pubClient).toBeDefined();
      expect(internalB.subClient).toBeDefined();

      const pubA = internalA.pubClient!;
      const subA = internalA.subClient!;
      const pubB = internalB.pubClient!;
      const subB = internalB.subClient!;

      await waitUntil(
        async () =>
          pubA.status === 'ready' &&
          subA.status === 'ready' &&
          pubB.status === 'ready' &&
          subB.status === 'ready' &&
          (await numSubEvents()) >= baselineSubCount + 2,
        10_000,
      );

      // Root namespace remains refused even with the Redis pub/sub adapter attached.
      const rootAttempt = await openEventsSocket(replicaA.port, '40');
      expect(rootAttempt.frames.some(f => f.startsWith('44') && f.includes('Invalid namespace'))).toBe(true);
      rootAttempt.ws.terminate();

      // Connect a chat-restricted subscriber to replica A and wait for subscription + Redis presence registration.
      const clientOnA = await openEventsSocket(replicaA.port, '40/events,{"apiKey":"k-restricted"}');
      clientOnA.ws.send(
        `42/events,${JSON.stringify(['message', { type: 'subscribe', sessionId: 'sess-e2e', events: ['message.received'] }])}`,
      );
      await waitUntil(() => clientOnA.frames.some(f => f.includes('"type":"subscribed"')), 5_000);
      expect(clientOnA.frames.some(f => f.includes('"type":"subscribed"'))).toBe(true);

      const presenceA = (replicaA.gateway as unknown as { restrictedPresence?: WsRestrictedPresenceTracker })
        .restrictedPresence;
      const presenceB = (replicaB.gateway as unknown as { restrictedPresence?: WsRestrictedPresenceTracker })
        .restrictedPresence;
      expect(presenceA).toBeDefined();
      expect(presenceB).toBeDefined();
      trackMember(presenceA!.nodeKey);
      trackMember(presenceB!.nodeKey);
      await waitUntil(
        async () =>
          (await redis.sismember(WS_RESTRICTED_NODES_KEY, presenceA!.nodeKey)) === 1 &&
          (presenceB as unknown as { client?: { status?: string } }).client?.status === 'ready',
        5_000,
      );

      // Emit from replica B (no local sockets): RedisIoAdapter + WsRestrictedPresenceTracker deliver only allowed chat.
      replicaB.gateway.emitMessage('sess-e2e', { id: 'msg-blocked', chatId: 'bob@c.us', body: 'blocked' });
      replicaB.gateway.emitMessage('sess-e2e', { id: 'msg-allowed', chatId: 'alice@c.us', body: 'hello across nodes' });

      await waitUntil(() => clientOnA.frames.some(f => f.includes('msg-allowed')), 5_000);
      expect(clientOnA.frames.some(f => f.includes('msg-allowed'))).toBe(true);
      expect(clientOnA.frames.some(f => f.includes('msg-blocked'))).toBe(false);

      // Teardown closes sockets, releases pub/sub clients, clears presence, and leaves zero subscriptions behind.
      clientOnA.ws.terminate();
      await replicaA.app.close();
      await replicaB.app.close();
      appsToClose.length = 0;

      expect(internalA.pubClient).toBeUndefined();
      expect(internalA.subClient).toBeUndefined();
      expect(internalB.pubClient).toBeUndefined();
      expect(internalB.subClient).toBeUndefined();
      await waitUntil(
        () => pubA.status === 'end' && subA.status === 'end' && pubB.status === 'end' && subB.status === 'end',
        5_000,
      );
      expect(pubA.status).toBe('end');
      expect(subA.status).toBe('end');
      expect(pubB.status).toBe('end');
      expect(subB.status).toBe('end');
      expect(await redis.sismember(WS_RESTRICTED_NODES_KEY, presenceA!.nodeKey)).toBe(0);
      await waitUntil(async () => (await numSubEvents()) === baselineSubCount, 5_000);
      expect(await numSubEvents()).toBe(baselineSubCount);
    }, 20_000);

    it('skips creating Redis pub/sub clients when REDIS_ENABLED is not true', async () => {
      process.env.REDIS_ENABLED = 'false';
      const replica = await bootReplica(`replica-disabled-${randomUUID()}`);
      const internal = replica.adapter as unknown as { pubClient?: Redis; subClient?: Redis };
      expect(internal.pubClient).toBeUndefined();
      expect(internal.subClient).toBeUndefined();

      const rootAttempt = await openEventsSocket(replica.port, '40');
      expect(rootAttempt.frames.some(f => f.startsWith('44') && f.includes('Invalid namespace'))).toBe(true);
    });
  });
});
