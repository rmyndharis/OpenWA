import type { ConfigService } from '@nestjs/config';
import type { Server, Socket } from 'socket.io';
import { CHAT_IDS_MEMO_MAX, CHAT_IDS_MEMO_TTL_MS, EventsGateway } from './events.gateway';
import { ChatScopeService } from '../auth/chat-scope.service';
import type { AuthService } from '../auth/auth.service';
import type { AuditService } from '../audit/audit.service';
import { ApiKeyRole, type ApiKey } from '../auth/entities/api-key.entity';
import type { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { LoggerService } from '../../common/services/logger.service';

const PHONE_DIGITS = '628111000111';
const PHONE = `${PHONE_DIGITS}@c.us`;
const LID = '123456';

// With cross-replica fan-out on, a direct chat's events are published to the chat rooms of every identity the
// lid table gives that chat. A burst of events about one chat names the same chat each time, so the table should
// be read for it once, not once per event; a chat the table knows no other identity for is read again each time,
// so a mapping learned meanwhile routes at once.
describe('EventsGateway chat-room identity lookups with Redis fan-out', () => {
  const previous = process.env.REDIS_ENABLED;
  let lidsOfPhone: Record<string, string[]>;
  let reads: jest.Mock;
  let gateway: EventsGateway;
  let clients: ReturnType<typeof socket>[];

  const key = (id: string, allowedChats: string[]): ApiKey =>
    ({ id, name: id, role: ApiKeyRole.VIEWER, allowedSessions: null, allowedChats }) as ApiKey;

  function socket(id: string) {
    const rooms = new Set([id]);
    return {
      id,
      rooms,
      data: {},
      disconnected: false,
      handshake: { auth: { apiKey: id }, headers: {}, address: '127.0.0.1' },
      emit: jest.fn(),
      join: jest.fn((room: string) => {
        rooms.add(room);
      }),
      leave: jest.fn(),
      disconnect: jest.fn(),
    };
  }

  const received = (client: ReturnType<typeof socket>): unknown[][] =>
    (client.emit.mock.calls as unknown[][]).filter(([, frame]) => (frame as { type: string }).type === 'event');
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));

  /** A socket whose key is restricted to the lid of PHONE's chat, subscribed to everything. */
  async function connectRestricted(): Promise<ReturnType<typeof socket>> {
    const client = socket('restricted');
    clients.push(client);
    await gateway.handleConnection(client as unknown as Socket);
    await gateway.handleMessage(client as unknown as Socket, { type: 'subscribe', sessionId: '*', events: ['*'] });
    return client;
  }

  beforeEach(() => {
    process.env.REDIS_ENABLED = 'true';
    lidsOfPhone = {};
    clients = [];
    reads = jest.fn((phones: string[]) =>
      Promise.resolve(Object.fromEntries(phones.map(phone => [phone, lidsOfPhone[phone] ?? []]))),
    );
    const scope = new ChatScopeService({
      phonesForLidsPersisted: jest.fn().mockResolvedValue({}),
      lidsForPhonesPersisted: reads,
    } as unknown as LidMappingStoreService);
    const restrictedKey = key('restricted', [`${LID}@lid`]);
    gateway = new EventsGateway(
      { validateApiKey: jest.fn().mockResolvedValue(restrictedKey) } as unknown as AuthService,
      { logWarn: jest.fn().mockResolvedValue(null) } as unknown as AuditService,
      { get: jest.fn((_name: string, fallback: unknown) => fallback) } as unknown as ConfigService,
      scope,
    );
    // Room unions model the adapter's recipient deduplication.
    gateway.server = {
      to: (room: string | string[]) => {
        const target = new Set(Array.isArray(room) ? room : [room]);
        const broadcast = {
          to: (next: string) => {
            target.add(next);
            return broadcast;
          },
          except: () => broadcast,
          emit: (name: string, frame: unknown) => {
            for (const client of clients) {
              if ([...target].some(r => client.rooms.has(r))) client.emit(name, frame);
            }
          },
        };
        return broadcast;
      },
    } as unknown as Server;
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (previous === undefined) delete process.env.REDIS_ENABLED;
    else process.env.REDIS_ENABLED = previous;
  });

  it('reads the lid table once for events about one direct chat raised together', async () => {
    gateway.emitMessageSent('s1', { id: 'OUT1', chatId: PHONE, body: 'hi' });
    for (const [ack, status] of [
      [1, 'sent'],
      [2, 'delivered'],
      [3, 'read'],
    ] as const) {
      gateway.emitMessageAck('s1', { id: 'OUT1', messageId: 'OUT1', status, ack, chatId: PHONE });
    }
    await flush();

    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('does not share a read between two sessions', async () => {
    gateway.emitMessage('s1', { id: 'IN1', chatId: PHONE });
    gateway.emitMessage('s2', { id: 'IN2', chatId: PHONE });
    await flush();

    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('reuses an expansion that found a mapping and still reaches the other identity', async () => {
    lidsOfPhone[PHONE_DIGITS] = [LID];
    const restricted = await connectRestricted();

    gateway.emitMessage('s1', { id: 'IN1', chatId: PHONE });
    await flush();
    gateway.emitMessageAck('s1', { id: 'IN1', messageId: 'IN1', status: 'read', ack: 3, chatId: PHONE });
    await flush();

    expect(reads).toHaveBeenCalledTimes(1);
    expect(received(restricted)).toHaveLength(2);
  });

  it('reads again for a chat with no other identity, so a mapping learned meanwhile routes at once', async () => {
    const restricted = await connectRestricted();

    gateway.emitMessage('s1', { id: 'IN1', chatId: PHONE });
    await flush();
    expect(received(restricted)).toHaveLength(0);

    lidsOfPhone[PHONE_DIGITS] = [LID];
    gateway.emitMessage('s1', { id: 'IN2', chatId: PHONE });
    await flush();

    expect(reads).toHaveBeenCalledTimes(2);
    expect(received(restricted)).toHaveLength(1);
  });

  it('fails closed for every event that shared a failed lookup, and does not keep it', async () => {
    lidsOfPhone[PHONE_DIGITS] = [LID];
    const restricted = await connectRestricted();
    reads.mockRejectedValueOnce(new Error('database is locked'));

    gateway.emitMessage('s1', { id: 'IN1', chatId: PHONE });
    gateway.emitMessage('s1', { id: 'IN2', chatId: PHONE });
    await flush();
    expect(reads).toHaveBeenCalledTimes(1);
    expect(received(restricted)).toHaveLength(0);

    gateway.emitMessage('s1', { id: 'IN3', chatId: PHONE });
    await flush();

    expect(reads).toHaveBeenCalledTimes(2);
    expect(received(restricted)).toHaveLength(1);
  });

  it('reads again once the window has passed', async () => {
    lidsOfPhone[PHONE_DIGITS] = [LID];
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);

    gateway.emitMessage('s1', { id: 'IN1', chatId: PHONE });
    await flush();
    clock.mockReturnValue(now + CHAT_IDS_MEMO_TTL_MS - 1);
    gateway.emitMessage('s1', { id: 'IN2', chatId: PHONE });
    await flush();
    expect(reads).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(now + CHAT_IDS_MEMO_TTL_MS + 1);
    gateway.emitMessage('s1', { id: 'IN3', chatId: PHONE });
    await flush();
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('holds no more expansions than its cap', async () => {
    const chats = Array.from({ length: CHAT_IDS_MEMO_MAX + 25 }, (_, i) => `${628200000000 + i}`);
    for (const digits of chats) lidsOfPhone[digits] = [`9${digits}`];

    for (const digits of chats) gateway.emitMessage('s1', { id: `IN-${digits}`, chatId: `${digits}@c.us` });
    await flush();

    const memo = (gateway as unknown as { chatIdsMemo: Map<string, unknown> }).chatIdsMemo;
    expect(memo.size).toBeLessThanOrEqual(CHAT_IDS_MEMO_MAX);
    expect(memo.size).toBeGreaterThan(0);
  });
});
