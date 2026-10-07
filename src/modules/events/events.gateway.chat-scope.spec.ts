import type { ConfigService } from '@nestjs/config';
import type { Server, Socket } from 'socket.io';
import { EventsGateway } from './events.gateway';
import { ChatScopeService } from '../auth/chat-scope.service';
import type { AuthService } from '../auth/auth.service';
import type { AuditService } from '../audit/audit.service';
import { ApiKeyRole, type ApiKey } from '../auth/entities/api-key.entity';
import type { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';

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
  let mappingFails: boolean;
  let resolveIds: jest.SpyInstance;
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
  const connect = async (id: string, chats: string[] | null, sessions: string[] | null = ['s1'], sessionId = 's1') => {
    current[id] = key(id, chats, sessions);
    const client = socket(id);
    clients.push(client);
    await gateway.handleConnection(client as unknown as Socket);
    await subscribe(client, ['*'], sessionId);
    return client;
  };

  beforeEach(() => {
    current = {};
    clients = [];
    lidPhone = null;
    mappingFails = false;
    const scope = new ChatScopeService({
      phonesForLidsPersisted: jest.fn((lids: string[]) => {
        if (mappingFails) return Promise.reject(new Error('Mapping lookup unavailable'));
        return Promise.resolve(lids.includes('123456') ? { '123456': lidPhone } : {});
      }),
      lidsForPhonesPersisted: jest.fn().mockResolvedValue({}),
    } as unknown as LidMappingStoreService);
    resolveIds = jest.spyOn(scope, 'idsForFilter');
    gateway = new EventsGateway(
      { validateApiKey: jest.fn((id: string) => Promise.resolve(current[id])) } as unknown as AuthService,
      { logWarn: jest.fn().mockResolvedValue(null) } as unknown as AuditService,
      { get: jest.fn((_name: string, fallback: unknown) => fallback) } as unknown as ConfigService,
      scope,
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

  it('resolves a phone/LID mapping learned after subscription', async () => {
    const allowed = await connect('allowed', [PHONE]);
    gateway.emitMessage('s1', { chatId: '123456@lid' });
    await flush();
    expect(events(allowed)).toHaveLength(0);
    lidPhone = '628111000111';
    gateway.emitMessage('s1', { chatId: '123456@lid' });
    await flush();
    expect(events(allowed)).toHaveLength(1);
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
