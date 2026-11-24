import type { ConfigService } from '@nestjs/config';
import type { Server, Socket } from 'socket.io';
import { CHAT_IDS_MEMO_TTL_MS, EventsGateway } from './events.gateway';
import {
  WS_RESTRICTED_CACHE_TTL_MS,
  WS_RESTRICTED_NODES_KEY,
  WS_RESTRICTED_NODE_KEY_PREFIX,
  WsRestrictedPresenceTracker,
  type RestrictedPresenceRedisClient,
} from './ws-restricted-presence';
import { ChatScopeService } from '../auth/chat-scope.service';
import type { AuthService } from '../auth/auth.service';
import type { AuditService } from '../audit/audit.service';
import { ApiKeyRole, type ApiKey } from '../auth/entities/api-key.entity';
import type { LearnedLidMapping, LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';

const PHONE = '628111000111@c.us';
const OTHER = '628222000222@c.us';
const key = (id: string, allowedChats: string[] | null, allowedSessions: string[] | null = ['s1']): ApiKey =>
  ({ id, name: id, role: ApiKeyRole.VIEWER, allowedSessions, allowedChats }) as ApiKey;

function socket(id: string) {
  const rooms = new Set([id]);
  const client = {
    id,
    rooms,
    data: {},
    disconnected: false,
    handshake: { auth: { apiKey: id }, headers: {}, address: '127.0.0.1' },
    emit: jest.fn(),
    join: jest.fn((room: string) => {
      rooms.add(room);
    }),
    leave: jest.fn((room: string) => {
      rooms.delete(room);
    }),
    disconnect: jest.fn(() => {
      client.disconnected = true;
      rooms.clear();
    }),
  };
  return client;
}

describe('chat-scoped WebSocket rooms', () => {
  let gateway: EventsGateway;
  let current: Record<string, ApiKey>;
  let clients: ReturnType<typeof socket>[];
  let lidPhone: string | null;
  let phoneLids: Record<string, string[]>;
  let mappingFails: boolean;
  let resolveIds: jest.SpyInstance;
  let mappingListeners: Set<(mapping: LearnedLidMapping) => void>;
  const notifyMappingLearned = (lid: string, phone: string) => {
    for (const listener of mappingListeners) listener({ lid, phone });
  };
  const subscribe = (client: ReturnType<typeof socket>, events = ['*'], sessionId = 's1') =>
    gateway.handleMessage(client as unknown as Socket, { type: 'subscribe', sessionId, events });
  const events = (client: ReturnType<typeof socket>) =>
    client.emit.mock.calls
      .map(
        ([, frame]) =>
          frame as { type: string; payload: { event: string; sessionId: string; data: Record<string, unknown> } },
      )
      .filter(frame => frame.type === 'event');
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  const connect = async (
    id: string,
    chats: string[] | null,
    sessions: string[] | null = ['s1'],
    sessionId = 's1',
    subscribed = ['*'],
  ) => {
    current[id] = key(id, chats, sessions);
    const client = socket(id);
    clients.push(client);
    await gateway.handleConnection(client as unknown as Socket);
    await subscribe(client, subscribed, sessionId);
    return client;
  };

  beforeEach(() => {
    current = {};
    clients = [];
    lidPhone = null;
    phoneLids = {};
    mappingFails = false;
    mappingListeners = new Set();
    const lidStore = {
      phonesForLidsPersisted: jest.fn((lids: string[]) => {
        if (mappingFails) return Promise.reject(new Error('Mapping lookup unavailable'));
        return Promise.resolve(lids.includes('123456') ? { '123456': lidPhone } : {});
      }),
      lidsForPhonesPersisted: jest.fn((phones: string[]) =>
        Promise.resolve(Object.fromEntries(phones.map(phone => [phone, phoneLids[phone] ?? []]))),
      ),
      onMappingLearned: jest.fn((listener: (mapping: LearnedLidMapping) => void) => {
        mappingListeners.add(listener);
        return () => {
          mappingListeners.delete(listener);
        };
      }),
    } as unknown as LidMappingStoreService;
    const scope = new ChatScopeService(lidStore);
    resolveIds = jest.spyOn(scope, 'idsForFilter');
    gateway = new EventsGateway(
      { validateApiKey: jest.fn((id: string) => Promise.resolve(current[id])) } as unknown as AuthService,
      { logWarn: jest.fn().mockResolvedValue(null) } as unknown as AuditService,
      { get: jest.fn((_name: string, fallback: unknown) => fallback) } as unknown as ConfigService,
      scope,
      undefined,
      lidStore,
    );
    // Room unions model the adapter's recipient deduplication, including remote recipients.
    gateway.server = {
      to: (room: string | string[]) => {
        const target = new Set(Array.isArray(room) ? room : [room]);
        const excluded = new Set<string>();
        const broadcast = {
          to: (next: string) => {
            target.add(next);
            return broadcast;
          },
          except: (next: string) => {
            excluded.add(next);
            return broadcast;
          },
          emit: (name: string, frame: unknown) => {
            for (const client of clients) {
              if ([...target].some(r => client.rooms.has(r)) && ![...excluded].some(r => client.rooms.has(r))) {
                client.emit(name, frame);
              }
            }
          },
        };
        return broadcast;
      },
    } as unknown as Server;
  });

  it('keeps restricted subscriptions out of the global stream and deduplicates overlapping rooms', async () => {
    const allowed = await connect('allowed', [PHONE]);
    const outside = await connect('outside', [OTHER]);
    const unrestricted = await connect('unrestricted', null);
    await subscribe(allowed, ['message.received', '*']);
    expect(allowed.disconnected).toBe(false);
    const held = [...allowed.rooms].filter(room => room.startsWith('session:'));
    expect(held.length).toBeGreaterThan(0);
    expect(held.every(room => room.includes(':chat:'))).toBe(true);
    gateway.emitMessage('s1', { chatId: PHONE, body: 'allowed' });
    await flush();
    expect(events(allowed)).toHaveLength(1);
    expect(events(outside)).toHaveLength(0);
    expect(events(unrestricted)).toHaveLength(1);
  });

  it('keeps group join requests away from a restricted key, since they name people outside its chats', async () => {
    const group = '120363000000000001@g.us';
    const restricted = await connect('restricted', [group]);
    const unrestricted = await connect('unrestricted', null);
    gateway.emitGroupJoinRequest('s1', { groupId: group, participantIds: ['628999000999@c.us'] });
    gateway.emitGroupUpdate('s1', { groupId: group, subject: 'Renamed' });
    await flush();
    // The REST membership-request routes refuse these keys for the same reason: a requester is, by
    // definition, not in the allowed chats, and listing the queue names them.
    expect(events(restricted).map(frame => frame.payload.event)).toEqual(['group.update']);
    expect(events(unrestricted).map(frame => frame.payload.event)).toEqual(['group.join_request', 'group.update']);
    expect(await subscribe(restricted, ['group.join_request'])).toMatchObject({
      type: 'error',
      code: 'FORBIDDEN_EVENTS',
    });
  });

  it('delivers an event response only to keys whose chats include the chat it names', async () => {
    const group = '120363000000000001@g.us';
    const inside = await connect('inside', [group]);
    const outside = await connect('outside', ['120363000000000002@g.us']);
    const unrestricted = await connect('unrestricted', null);
    gateway.emitEventResponse('s1', { chatId: group, eventMessageId: 'EVT1', response: 'going' });
    gateway.emitEventResponse('s1', { eventMessageId: 'EVT2', response: 'going' });
    await flush();
    expect(events(inside).map(frame => frame.payload.data)).toEqual([
      expect.objectContaining({ eventMessageId: 'EVT1' }),
    ]);
    expect(events(outside)).toHaveLength(0);
    // An unrestricted key hears every one, a payload with no chat included.
    expect(events(unrestricted)).toHaveLength(2);
  });

  it('delivers a poll vote only to keys whose chats include the chat it names', async () => {
    const group = '120363000000000001@g.us';
    const inside = await connect('inside', [group]);
    const outside = await connect('outside', ['120363000000000002@g.us']);
    const unrestricted = await connect('unrestricted', null);
    const vote = { pollMessageId: 'POLL1', voterId: 'member@lid', selectedOptions: ['Yes'], timestamp: 1786000000 };
    gateway.emitPollVote('s1', { ...vote, chatId: group });
    gateway.emitPollVote('s1', { ...vote, chatId: '' });
    await flush();
    expect(events(inside).map(frame => frame.payload.event)).toEqual(['poll.vote']);
    expect(events(inside)).toHaveLength(1);
    expect(events(outside)).toHaveLength(0);
    // An unrestricted key hears both, the vote that names no chat included.
    expect(events(unrestricted)).toHaveLength(2);
  });

  it('delivers receipts only to named subscriptions within the allowed session and chat', async () => {
    const group = '120363000000000001@g.us';
    const named = await connect('named', [group], ['s1'], 's1', ['message.receipt']);
    const allSessions = await connect('all-sessions', [group], null, '*', ['message.receipt']);
    const outside = await connect('outside', ['120363000000000002@g.us'], ['s1'], 's1', ['message.receipt']);
    const wildcard = await connect('wildcard', [group]);
    const receipt = {
      id: 'OUT1',
      messageId: 'OUT1',
      chatId: group,
      participant: PHONE,
      status: 'read' as const,
      timestamp: 1700000000,
    };

    gateway.emitMessageReceipt('s1', receipt);
    gateway.emitMessageReceipt('s2', receipt);
    gateway.emitMessageReceipt('s1', { ...receipt, chatId: 'status@broadcast' });
    await flush();

    expect(events(named).map(frame => frame.payload.sessionId)).toEqual(['s1']);
    expect(events(allSessions).map(frame => frame.payload.sessionId)).toEqual(['s1', 's2']);
    expect(events(outside)).toHaveLength(0);
    expect(events(wildcard)).toHaveLength(0);
  });

  it('refuses a subscribe that can never fit before it builds a single room name', async () => {
    const chats = Array.from({ length: 450 }, (_, index) => `62811${String(index).padStart(7, '0')}@c.us`);
    const restricted = await connect('restricted', chats);
    // The room set is only consulted once the names exist, so a read after the refusal means the
    // refused frame was still paid for in full (tens of milliseconds at a few thousand allowlist entries).
    let reads = 0;
    const joined = restricted.rooms;
    Object.defineProperty(restricted, 'rooms', {
      get: () => {
        reads += 1;
        return joined;
      },
    });
    const chatEvents = [
      'message.received',
      'message.sent',
      'message.ack',
      'message.revoked',
      'message.reaction',
      'message.edited',
      'group.join',
      'group.leave',
      'group.update',
      'presence.update',
    ];
    const refused = await subscribe(restricted, chatEvents);
    expect(refused).toMatchObject({ type: 'error', code: 'TOO_MANY_SUBSCRIPTIONS' });
    expect(reads).toBe(0);
    // The socket holds nothing, so unsubscribing cannot make this fit: the reply names what each event
    // costs this key and the way out.
    const { message } = refused as { message: string };
    expect(message).toContain('every event 900 subscriptions');
    expect(message).toContain('name fewer events or use "*"');
    expect(message).not.toContain('unsubscribe');
  });

  it('does not suggest "*" to a key whose allowlist alone is over the cap', async () => {
    // A list stored before allowedChats was bounded: its address forms exceed what one socket may hold,
    // so even one event never fits and only a shorter list helps.
    const chats = Array.from({ length: 2100 }, (_, index) => `62811${String(index).padStart(7, '0')}@c.us`);
    const restricted = await connect('restricted', chats);
    const refused = await subscribe(restricted, ['*']);
    expect(refused).toMatchObject({ type: 'error', code: 'TOO_MANY_SUBSCRIPTIONS' });
    const { message } = refused as { message: string };
    expect(message).toContain('every event 4200 subscriptions');
    expect(message).toContain('shorten the allowlist');
    expect(message).not.toContain('use "*"');
    expect(message).not.toContain('unsubscribe');
  });

  it('tells a subscriber that is over the cap because of what it already holds to unsubscribe first', async () => {
    const chats = Array.from({ length: 450 }, (_, index) => `62811${String(index).padStart(7, '0')}@c.us`);
    const restricted = await connect('restricted', chats);
    // The wildcard subscription holds 900 rooms; four more events add 3600, each frame within the cap alone.
    const fourEvents = ['message.received', 'message.sent', 'message.ack', 'message.revoked'];
    const refused = await subscribe(restricted, fourEvents, 's1');
    expect(refused).toMatchObject({ type: 'error', code: 'TOO_MANY_SUBSCRIPTIONS' });
    expect((refused as { message: string }).message).toContain('unsubscribe first');
  });

  it('performs no chat lookups for a local stream without restricted subscribers', async () => {
    const previous = process.env.REDIS_ENABLED;
    process.env.REDIS_ENABLED = 'false';
    try {
      const unrestricted = await connect('unrestricted', null);
      gateway.emitMessage('s1', { chatId: PHONE });
      await flush();
      expect(events(unrestricted)).toHaveLength(1);
      expect(resolveIds).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.REDIS_ENABLED;
      else process.env.REDIS_ENABLED = previous;
    }
  });

  it('publishes the chat rooms when Redis fans out, though this node tracks no restricted socket', async () => {
    const previous = process.env.REDIS_ENABLED;
    process.env.REDIS_ENABLED = 'true';
    try {
      // A restricted socket on another replica: the adapter reaches it through its rooms, but this node
      // never tracks it. Dropping the tracking keeps the rooms the subscribe granted.
      const remote = await connect('remote', [PHONE]);
      gateway.handleDisconnect(remote as unknown as Socket);
      const unrestricted = await connect('unrestricted', null);
      gateway.emitMessage('s1', { chatId: PHONE });
      await flush();
      expect(resolveIds).toHaveBeenCalledWith({ allowedChats: [PHONE] });
      expect(events(remote)).toHaveLength(1);
      expect(events(unrestricted)).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.REDIS_ENABLED;
      else process.env.REDIS_ENABLED = previous;
    }
  });

  it('resolves a phone/LID mapping learned after subscription', async () => {
    const allowed = await connect('allowed', [PHONE]);
    gateway.emitMessage('s1', { chatId: '123456@lid' });
    await flush();
    expect(events(allowed)).toHaveLength(0);
    lidPhone = '628111000111';
    notifyMappingLearned('123456', '628111000111');
    gateway.emitMessage('s1', { chatId: '123456@lid' });
    await flush();
    expect(events(allowed)).toHaveLength(1);
  });

  it('caches unmapped 1:1 chat lookups for the short negative TTL and evicts them immediately when a mapping is learned', async () => {
    const allowed = await connect('allowed', [PHONE]);
    const lidAllowed = await connect('lid-allowed', ['123456@lid']);

    // Two consecutive events for an unmapped 1:1 LID chat hit resolveIds only once.
    gateway.emitMessage('s1', { chatId: '123456@lid', id: 'm1' });
    await flush();
    gateway.emitMessage('s1', { chatId: '123456@lid', id: 'm2' });
    await flush();
    expect(resolveIds).toHaveBeenCalledTimes(1);
    expect(events(allowed)).toHaveLength(0);

    // Same for an unmapped phone JID.
    gateway.emitMessage('s1', { chatId: PHONE, id: 'p1' });
    await flush();
    gateway.emitMessage('s1', { chatId: PHONE, id: 'p2' });
    await flush();
    expect(resolveIds).toHaveBeenCalledTimes(2);
    expect(events(lidAllowed)).toHaveLength(2); // only m1 + m2 so far, not p1/p2

    // Learning the mapping immediately invalidates both the LID and phone negative entries.
    lidPhone = '628111000111';
    phoneLids['628111000111'] = ['123456'];
    notifyMappingLearned('123456', '628111000111');

    gateway.emitMessage('s1', { chatId: '123456@lid', id: 'm3' });
    await flush();
    expect(resolveIds).toHaveBeenCalledTimes(3);
    expect(events(allowed).map(f => f.payload.data.id)).toEqual(['p1', 'p2', 'm3']);

    gateway.emitMessage('s1', { chatId: PHONE, id: 'p3' });
    await flush();
    expect(resolveIds).toHaveBeenCalledTimes(4);
    expect(events(lidAllowed).map(f => f.payload.data.id)).toEqual(['m1', 'm2', 'm3', 'p3']);

    // TTL expiration also re-queries without explicit invalidation.
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + CHAT_IDS_MEMO_TTL_MS + 1);
    try {
      gateway.emitMessage('s1', { chatId: '999999@lid', id: 'u1' });
      await flush();
      gateway.emitMessage('s1', { chatId: '999999@lid', id: 'u2' });
      await flush();
      expect(resolveIds).toHaveBeenCalledTimes(5);

      clock.mockReturnValue(now + CHAT_IDS_MEMO_TTL_MS * 2 + 2);
      gateway.emitMessage('s1', { chatId: '999999@lid', id: 'u3' });
      await flush();
      expect(resolveIds).toHaveBeenCalledTimes(6);
    } finally {
      clock.mockRestore();
    }
  });

  it.each<[string, string, string]>([
    ['bare digits', '12345', '628123'],
    ['JID-suffixed lid', '12345@lid', '628123'],
    ['JID-suffixed phone', '12345', '628123@c.us'],
  ])(
    'invalidates LID, @c.us, @s.whatsapp.net, and bare-digit cached entries when onMappingLearned receives %s',
    async (_label, learnedLid, learnedPhone) => {
      await connect('restricted', ['628123@c.us']);

      // Populate negative cache entries for all four address forms of this chat.
      for (const chatId of ['12345@lid', '628123@c.us', '628123@s.whatsapp.net', '628123']) {
        gateway.emitMessage('s1', { chatId, id: `pre-${chatId}` });
        await flush();
      }
      expect(resolveIds).toHaveBeenCalledTimes(4);

      // Re-emitting before mapping invalidation hits the memo for all four forms (no extra lookups).
      for (const chatId of ['12345@lid', '628123@c.us', '628123@s.whatsapp.net', '628123']) {
        gateway.emitMessage('s1', { chatId, id: `cached-${chatId}` });
        await flush();
      }
      expect(resolveIds).toHaveBeenCalledTimes(4);

      // Learning the mapping in any of the three input shapes must evict all four cached forms.
      notifyMappingLearned(learnedLid, learnedPhone);

      for (const chatId of ['12345@lid', '628123@c.us', '628123@s.whatsapp.net', '628123']) {
        gateway.emitMessage('s1', { chatId, id: `post-${chatId}` });
        await flush();
      }
      expect(resolveIds).toHaveBeenCalledTimes(8);
    },
  );

  describe('Redis cluster restricted-socket presence', () => {
    const previous = process.env.REDIS_ENABLED;

    function createFakeRedis() {
      const strings = new Map<string, string>();
      const sets = new Map<string, Set<string>>();
      let fail = false;
      let status: string | undefined = 'ready';
      const client: RestrictedPresenceRedisClient = {
        get status() {
          return status;
        },
        set: jest.fn((key: string, value: string) => {
          if (fail) return Promise.reject(new Error('redis down'));
          strings.set(key, value);
          return Promise.resolve('OK');
        }),
        del: jest.fn((...keys: string[]) => {
          if (fail) return Promise.reject(new Error('redis down'));
          for (const k of keys) strings.delete(k);
          return Promise.resolve(keys.length);
        }),
        sadd: jest.fn((key: string, ...members: string[]) => {
          if (fail) return Promise.reject(new Error('redis down'));
          const set = sets.get(key) ?? new Set<string>();
          for (const m of members) set.add(m);
          sets.set(key, set);
          return Promise.resolve(members.length);
        }),
        srem: jest.fn((key: string, ...members: string[]) => {
          if (fail) return Promise.reject(new Error('redis down'));
          const set = sets.get(key);
          if (set) for (const m of members) set.delete(m);
          return Promise.resolve(members.length);
        }),
        smembers: jest.fn((key: string) => {
          if (fail) return Promise.reject(new Error('redis down'));
          return Promise.resolve([...(sets.get(key) ?? [])]);
        }),
        mget: jest.fn((...keys: string[]) => {
          if (fail) return Promise.reject(new Error('redis down'));
          return Promise.resolve(keys.map(k => strings.get(k) ?? null));
        }),
        eval: jest.fn((_script: string, numkeys: number, ...args: string[]) => {
          if (fail) return Promise.reject(new Error('redis down'));
          const setKey = args[0];
          const leaseKeys = args.slice(1, numkeys);
          const members = args.slice(numkeys);
          const set = sets.get(setKey);
          let alive = 0;
          for (let i = 0; i < members.length; i++) {
            if (strings.has(leaseKeys[i])) {
              alive++;
            } else {
              set?.delete(members[i]);
            }
          }
          return Promise.resolve(alive);
        }),
      };
      return {
        client,
        strings,
        sets,
        setFail(next: boolean) {
          fail = next;
        },
        setStatus(next: string) {
          status = next;
        },
      };
    }

    beforeEach(() => {
      process.env.REDIS_ENABLED = 'true';
    });

    afterEach(async () => {
      await gateway.onModuleDestroy();
      if (previous === undefined) delete process.env.REDIS_ENABLED;
      else process.env.REDIS_ENABLED = previous;
    });

    it('skips chatIds lookup when Redis confirms 0 restricted nodes, fans out when a remote node registers, and fails open on Redis error', async () => {
      let now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const redis = createFakeRedis();
        const tracker = new WsRestrictedPresenceTracker(redis.client, { nodeId: 'node-a' });
        const scope = new ChatScopeService({
          phonesForLidsPersisted: jest.fn().mockResolvedValue({}),
          lidsForPhonesPersisted: jest.fn().mockResolvedValue({}),
        } as unknown as LidMappingStoreService);
        resolveIds = jest.spyOn(scope, 'idsForFilter');
        const server = gateway.server;
        gateway = new EventsGateway(
          { validateApiKey: jest.fn((id: string) => Promise.resolve(current[id])) } as unknown as AuthService,
          { logWarn: jest.fn().mockResolvedValue(null) } as unknown as AuditService,
          { get: jest.fn((_name: string, fallback: unknown) => fallback) } as unknown as ConfigService,
          scope,
          undefined,
          undefined,
          tracker,
        );
        gateway.server = server;

        // Connect a remote restricted socket, then detach it from this node's local tracking while leaving its rooms.
        const remote = await connect('remote', [PHONE]);
        gateway.handleDisconnect(remote as unknown as Socket);
        await flush();
        const unrestricted = await connect('unrestricted', null);

        // With 0 restricted nodes registered in Redis, emit skips resolveIds and chat-room fan-out.
        gateway.emitMessage('s1', { chatId: PHONE, id: 'skip-me' });
        await flush();
        expect(resolveIds).not.toHaveBeenCalled();
        expect(events(remote)).toHaveLength(0);
        expect(events(unrestricted)).toHaveLength(1);

        // A remote replica registers a restricted socket in Redis -> fan-out runs cleanly once short cache TTL expires.
        redis.strings.set(`${WS_RESTRICTED_NODE_KEY_PREFIX}node-b:1111`, '1');
        redis.sets.set(WS_RESTRICTED_NODES_KEY, new Set(['node-b:1111']));
        now += WS_RESTRICTED_CACHE_TTL_MS + 1;

        gateway.emitMessage('s1', { chatId: PHONE, id: 'remote-hit' });
        await flush();
        expect(resolveIds).toHaveBeenCalledTimes(1);
        expect(events(remote)).toHaveLength(1);
        expect(events(unrestricted)).toHaveLength(2);

        // Remote node crashes and its lease expires -> dead member pruned and lookups skipped again.
        redis.strings.delete(`${WS_RESTRICTED_NODE_KEY_PREFIX}node-b:1111`);
        now += WS_RESTRICTED_CACHE_TTL_MS + 1;
        gateway.emitMessage('s1', { chatId: PHONE, id: 'after-expiry' });
        await flush();
        expect(resolveIds).toHaveBeenCalledTimes(1);
        expect(events(remote)).toHaveLength(1);

        // Redis errors -> fails open and runs chat-room fan-out cleanly.
        now += WS_RESTRICTED_CACHE_TTL_MS + 1;
        redis.setFail(true);
        gateway.emitMessage('s1', { chatId: OTHER, id: 'redis-err' });
        await flush();
        expect(resolveIds).toHaveBeenCalledTimes(2);

        // Redis disconnected -> fails open cleanly as well.
        redis.setFail(false);
        redis.setStatus('reconnecting');
        gateway.emitMessage('s1', { chatId: '628333000333@c.us', id: 'redis-reconnecting' });
        await flush();
        expect(resolveIds).toHaveBeenCalledTimes(3);
      } finally {
        clock.mockRestore();
      }
    });

    it('registers, refreshes via heartbeat, and unregisters local restricted-socket presence cleanly on disconnect and destroy', async () => {
      jest.useFakeTimers();
      try {
        const redis = createFakeRedis();
        const tracker = new WsRestrictedPresenceTracker(redis.client, {
          nodeId: 'node-a',
          ttlMs: 30_000,
          heartbeatMs: 10_000,
        });
        const scope = new ChatScopeService({
          phonesForLidsPersisted: jest.fn().mockResolvedValue({}),
          lidsForPhonesPersisted: jest.fn().mockResolvedValue({}),
        } as unknown as LidMappingStoreService);
        const server = gateway.server;
        gateway = new EventsGateway(
          { validateApiKey: jest.fn((id: string) => Promise.resolve(current[id])) } as unknown as AuthService,
          { logWarn: jest.fn().mockResolvedValue(null) } as unknown as AuditService,
          { get: jest.fn((_name: string, fallback: unknown) => fallback) } as unknown as ConfigService,
          scope,
          undefined,
          undefined,
          tracker,
        );
        gateway.server = server;
        gateway.afterInit();

        const restricted = await connect('restricted', [PHONE]);
        expect(redis.sets.get(WS_RESTRICTED_NODES_KEY)?.has(tracker.nodeKey)).toBe(true);
        const setsAfterConnect = (redis.client.set as jest.Mock).mock.calls.length;
        expect(setsAfterConnect).toBeGreaterThanOrEqual(1);

        // Heartbeat refreshes the lease while the restricted socket stays connected.
        await jest.advanceTimersByTimeAsync(10_000);
        expect((redis.client.set as jest.Mock).mock.calls.length).toBeGreaterThan(setsAfterConnect);

        // Disconnecting the last restricted socket unregisters this node.
        gateway.handleDisconnect(restricted as unknown as Socket);
        await Promise.resolve();
        expect(redis.sets.get(WS_RESTRICTED_NODES_KEY)?.has(tracker.nodeKey)).toBe(false);

        const setsBeforeDestroy = (redis.client.set as jest.Mock).mock.calls.length;
        await gateway.onModuleDestroy();
        await jest.advanceTimersByTimeAsync(30_000);
        expect((redis.client.set as jest.Mock).mock.calls.length).toBe(setsBeforeDestroy);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('keeps equal phone and LID digits separate without a persisted mapping', async () => {
    const phone = await connect('phone', ['123456@c.us']);
    const lid = await connect('lid', ['123456@lid']);
    gateway.emitMessage('s1', { chatId: '123456@lid' });
    await flush();
    expect(events(phone)).toHaveLength(0);
    expect(events(lid)).toHaveLength(1);
    gateway.emitMessage('s1', { chatId: '123456@s.whatsapp.net' });
    await flush();
    expect(events(phone)).toHaveLength(1);
    expect(events(lid)).toHaveLength(1);
  });

  it('fails closed on a mapping lookup failure while retaining unrestricted delivery', async () => {
    const allowed = await connect('allowed', [PHONE]);
    const unrestricted = await connect('unrestricted', null);
    mappingFails = true;
    gateway.emitMessage('s1', { chatId: PHONE });
    await flush();
    expect(events(allowed)).toHaveLength(0);
    expect(events(unrestricted)).toHaveLength(1);
  });

  it.each([false, true])('preserves session event order across slow lookups (failed edit: %s)', async failed => {
    const allowed = await connect('allowed', [PHONE], null, '*');
    const unrestricted = await connect('unrestricted', null, null, '*');
    let finishFirst!: (ids: string[]) => void;
    resolveIds
      .mockImplementationOnce(() => new Promise<string[]>(resolve => (finishFirst = resolve)))
      .mockImplementationOnce(() =>
        failed ? Promise.reject(new Error('Mapping lookup unavailable')) : Promise.resolve([PHONE]),
      );

    gateway.emitMessage('s1', { chatId: PHONE, id: 'm1', body: 'original' });
    gateway.emitMessageEdited('s1', { chatId: '123456@lid', messageId: 'm1', body: 'edited' });
    gateway.emitMessageReaction('s1', { chatId: PHONE, messageId: 'm1', reaction: 'ok' });
    gateway.emitMessage('s2', { chatId: PHONE, id: 'm2' });
    await flush();
    expect(events(allowed).map(frame => frame.payload.sessionId)).toEqual(['s2']);
    expect(events(unrestricted).map(frame => frame.payload.event)).toEqual([
      'message.received',
      'message.edited',
      'message.reaction',
      'message.received',
    ]);

    finishFirst([PHONE]);
    await flush();
    expect(
      events(allowed)
        .filter(frame => frame.payload.sessionId === 's1')
        .map(frame => frame.payload.event),
    ).toEqual(
      failed ? ['message.received', 'message.reaction'] : ['message.received', 'message.edited', 'message.reaction'],
    );

    lidPhone = '628111000111';
    gateway.emitMessage('s1', { chatId: '123456@lid', id: 'm3' });
    await flush();
    expect(events(allowed).at(-1)?.payload.data.id).toBe('m3');
  });

  it('deduplicates chat rooms across wildcard and specific sessions', async () => {
    const allowed = await connect('allowed', [PHONE], null, '*');
    await subscribe(allowed, ['*', 'message.received']);
    gateway.emitMessage('s1', { chatId: PHONE });
    gateway.emitMessage('s2', { chatId: PHONE });
    await flush();
    expect(events(allowed)).toHaveLength(2);
  });

  // connect() subscribes with '*', which the wildcard rooms serve. Subscribing to one named event instead
  // leaves only the room named for that event to match, on the named session and on the wildcard session.
  it.each<[string, string, string[]]>([
    ['a named session', 's1', ['s1:message.received']],
    ['the wildcard session', '*', ['s1:message.received', 's2:message.received']],
  ])('delivers a chat event to a restricted subscriber of one named event on %s', async (_label, sessionId, sent) => {
    const allowed = await connect('allowed', [PHONE], null, sessionId, ['message.received']);
    gateway.emitMessage('s1', { chatId: PHONE });
    gateway.emitMessage('s2', { chatId: PHONE });
    gateway.emitMessageEdited('s1', { chatId: PHONE, messageId: 'm1', body: 'edited' });
    await flush();
    const received = events(allowed).map(frame => `${frame.payload.sessionId}:${frame.payload.event}`);
    expect(received.sort()).toEqual(sent);
  });

  it('grants no stream rooms to an allowlist with no chattable identities', async () => {
    const client = await connect('invalid', ['status@broadcast', '']);
    expect(await subscribe(client)).toMatchObject({ code: 'FORBIDDEN_EVENTS' });
    expect([...client.rooms].filter(room => room.startsWith('session:'))).toEqual([]);
  });

  it('omits account-wide events and receipts without a chat while admitting group events', async () => {
    const allowed = await connect('allowed', ['123@g.us']);
    const unrestricted = await connect('unrestricted', null);
    gateway.emitQRCode('s1', 'private-qr');
    gateway.emitSessionStatus('s1', 'ready');
    gateway.emitCallReceived('s1', { from: PHONE });
    gateway.emitStatusReceived('s1', { chatId: '123@g.us' });
    gateway.emitMessageAck('s1', { id: 'm1', messageId: 'm1', status: 'delivered', ack: 2 });
    gateway.emitGroupJoin('s1', { groupId: '123@g.us', participantIds: [PHONE] });
    await flush();
    expect(events(allowed).map(frame => frame.payload.event)).toEqual(['group.join']);
    expect(events(unrestricted)).toHaveLength(5);
  });

  it('rejects explicit account events and retains the session fence', async () => {
    const client = await connect('allowed', [PHONE]);
    const session = await subscribe(client, ['*'], '*');
    expect(session).toMatchObject({ code: 'FORBIDDEN_SESSION' });
    const account = await subscribe(client, ['session.qr']);
    expect(account).toMatchObject({ code: 'FORBIDDEN_EVENTS' });
  });

  it('disconnects a changed chat authorization before granting more rooms', async () => {
    const client = await connect('allowed', [PHONE]);
    current.allowed = key('allowed', [OTHER]);
    expect(await subscribe(client)).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(client.disconnected).toBe(true);
  });

  it('removes chat rooms on unsubscribe and counts them against the subscription cap', async () => {
    const client = await connect('allowed', [PHONE]);
    await gateway.handleMessage(client as unknown as Socket, { type: 'unsubscribe', sessionId: 's1' });
    expect([...client.rooms].filter(room => room.startsWith('session:'))).toEqual([]);
    const many = await connect(
      'many',
      Array.from({ length: 400 }, (_, i) => `${628100000000 + i}@c.us`),
    );
    const response = await subscribe(many, [
      'message.received',
      'message.sent',
      'message.ack',
      'message.revoked',
      'message.reaction',
      'message.edited',
    ]);
    expect(response).toMatchObject({ code: 'TOO_MANY_SUBSCRIPTIONS' });
  });
});
