import type { Repository } from 'typeorm';
import { MessageProjector } from './message-projector.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Message, MessageStatus } from '../message/entities/message.entity';
import { Session } from './entities/session.entity';
import { EventsGateway } from '../events/events.gateway';
import { WebhookService } from '../webhook/webhook.service';
import { HookManager } from '../../core/hooks';
import { StatusStoreService } from '../status-store/status-store.service';
import { SessionLidResolver } from './session-lid-resolver.service';
import { deferred } from './inbound-room';
import type {
  IncomingMessage,
  InboundTicket,
  IWhatsAppEngine,
} from '../../engine/interfaces/whatsapp-engine.interface';

/**
 * On PostgreSQL the engines hold each inbound message from its arrival until its row is written
 * (admitInbound): the chat's hook and commit order is fixed at arrival, a payload is downloaded only
 * into a slot of the session's room, and a revoke, edit, reaction or ack that reaches a message
 * before its emit is kept for its row.
 */

type Row = Record<string, unknown>;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
};

// TypeORM's FindOperator, read without importing its internals.
const matches = (row: Row, where: Record<string, unknown>): boolean =>
  Object.entries(where).every(([key, want]) => {
    if (key === 'metadata') return true;
    const op = want as { _type?: string; _value?: unknown } | null;
    if (op && typeof op === 'object' && op._type === 'not') return row[key] !== op._value;
    if (op && typeof op === 'object' && op._type === 'in') return (op._value as unknown[]).includes(row[key]);
    return row[key] === want;
  });

const message = (id: string, chatId: string, over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id,
  chatId,
  from: chatId,
  to: 'me@c.us',
  body: `body of ${id}`,
  type: 'text',
  timestamp: 1_700_000_000,
  fromMe: false,
  isGroup: false,
  kind: 'individual',
  ...over,
});

const arrival = (id: string, chatId: string, needsRoom = false, status = false) => ({ id, chatId, needsRoom, status });

describe('MessageProjector holding inbound messages (PostgreSQL)', () => {
  const env = { ...process.env };
  let rows: Row[];
  let insertGate: (row: Row) => Promise<void>;
  let repo: Record<string, unknown>;
  let hookManager: { execute: jest.Mock };
  let webhookService: { dispatch: jest.Mock };
  let eventsGateway: Record<string, jest.Mock>;
  let statusStore: { ingest: jest.Mock };
  let engines: EngineRegistry;
  let engine: IWhatsAppEngine;
  let projector: MessageProjector;
  let hookStarts: string[];

  const build = (type: string): void => {
    rows = [];
    hookStarts = [];
    insertGate = () => Promise.resolve();
    repo = {
      manager: { connection: { options: { type } } },
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(rows.find(r => matches(r, where)) ?? null),
      ),
      create: jest.fn((x: Row) => ({ ...x })),
      insert: jest.fn(async (row: Row) => {
        await insertGate(row);
        rows.push({ ...row });
        return { identifiers: [{ id: `pk-${String(row.waMessageId)}` }], generatedMaps: [] };
      }),
      update: jest.fn((where: Record<string, unknown>, patch: Row) => {
        const hit = rows.filter(r => matches(r, where));
        for (const r of hit) Object.assign(r, patch);
        return Promise.resolve({ affected: hit.length });
      }),
    };
    hookManager = {
      execute: jest.fn((event: string, data: unknown) => {
        if (event === 'message:received' || event === 'message:sent') hookStarts.push((data as IncomingMessage).id);
        return Promise.resolve({ continue: true, data });
      }),
    };
    webhookService = { dispatch: jest.fn().mockResolvedValue(undefined) };
    eventsGateway = {
      emitMessage: jest.fn(),
      emitMessageSent: jest.fn(),
      emitMessageRevoked: jest.fn(),
      emitMessageReaction: jest.fn(),
      emitMessageEdited: jest.fn(),
      emitMessageAck: jest.fn(),
      emitStatusReceived: jest.fn(),
    };
    statusStore = { ingest: jest.fn() };
    engines = new EngineRegistry();
    engine = { tag: 'one' } as unknown as IWhatsAppEngine;
    engines.set('s1', engine);
    projector = new MessageProjector(
      repo as unknown as Repository<Message>,
      { update: jest.fn().mockResolvedValue({ affected: 1 }) } as unknown as Repository<Session>,
      engines,
      eventsGateway as unknown as EventsGateway,
      webhookService as unknown as WebhookService,
      hookManager as unknown as HookManager,
      statusStore as unknown as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
    );
  };

  const admit = (a: ReturnType<typeof arrival>, from = engine): InboundTicket => {
    const ticket = projector.admitInbound('s1', from, a);
    if (!ticket) throw new Error('not admitted');
    return ticket;
  };
  const insertedIds = (): unknown[] => rows.map(r => r.waMessageId);
  const dispatched = (event: string): Row[] =>
    (webhookService.dispatch.mock.calls as Array<[string, string, Row]>).filter(c => c[1] === event).map(c => c[2]);
  const persistedHooks = (): Row[] =>
    (hookManager.execute.mock.calls as Array<[string, { message: Row }]>)
      .filter(c => c[0] === 'message:persisted')
      .map(c => c[1].message);
  const room = () =>
    (projector as unknown as { rooms: Map<string, { gate: { activeCount: number } }> }).rooms.get('s1');

  beforeEach(() => {
    process.env.INBOUND_MEDIA_CONCURRENCY = '1';
    build('postgres');
  });

  afterEach(() => {
    process.env = { ...env };
  });

  it('starts hooks and inserts in arrival order when a chat emits out of order, leaving other chats free', async () => {
    const a = admit(arrival('A', 'chat1'));
    const b = admit(arrival('B', 'chat1'));
    const c = admit(arrival('C', 'chat1'));
    const d = admit(arrival('D', 'chat2'));

    projector.handleInboundMessage('s1', engine, message('D', 'chat2'), d);
    projector.handleInboundMessage('s1', engine, message('C', 'chat1'), c);
    projector.handleInboundMessage('s1', engine, message('B', 'chat1'), b);
    await flush();
    // The other chat is not behind chat1's first message; chat1 waits for it.
    expect(insertedIds()).toEqual(['D']);
    expect(hookStarts).toEqual(['D']);

    projector.handleInboundMessage('s1', engine, message('A', 'chat1'), a);
    await flush();

    expect(hookStarts).toEqual(['D', 'A', 'B', 'C']);
    expect(insertedIds()).toEqual(['D', 'A', 'B', 'C']);
  });

  it('stores a message revoked before its emit cleared, without running its hook or announcing it', async () => {
    const t = admit(arrival('A', 'chat1', true));
    projector.handleMessageRevoked('s1', engine, {
      id: 'A',
      revokedId: 'A',
      chatId: 'chat1',
      from: 'chat1',
      to: 'me@c.us',
      type: 'revoked',
      body: '',
      timestamp: 1,
    });
    projector.handleInboundMessage(
      's1',
      engine,
      message('A', 'chat1', { type: 'image', body: 'secret', media: { mimetype: 'image/png', data: 'QUJD' } }),
      t,
    );
    await flush();

    expect(hookStarts).toEqual([]);
    expect(rows).toEqual([expect.objectContaining({ waMessageId: 'A', body: '', type: 'revoked', metadata: null })]);
    expect(persistedHooks()).toEqual([expect.objectContaining({ body: '', type: 'revoked', metadata: null })]);
    expect(dispatched('message.received')).toEqual([]);
    expect(eventsGateway.emitMessage).not.toHaveBeenCalled();
  });

  it('runs the hook, stores and announces a message edited before its emit with the edit', async () => {
    const t = admit(arrival('A', 'chat1'));
    projector.applyMessageEditQueued('s1', { messageId: 'A', body: 'edited' } as never);
    projector.handleInboundMessage('s1', engine, message('A', 'chat1', { body: 'original' }), t);
    await flush();

    const calls = hookManager.execute.mock.calls as Array<[string, IncomingMessage]>;
    const hooked = calls.find(c => c[0] === 'message:received')?.[1];
    expect(hooked?.body).toBe('edited');
    expect(rows[0]).toEqual(expect.objectContaining({ body: 'edited' }));
    expect(dispatched('message.received')[0]).toEqual(expect.objectContaining({ body: 'edited' }));
  });

  it('stores a reaction and an ack that arrived before the emit once the row is written', async () => {
    const t = admit(arrival('A', 'chat1'));
    projector.applyReactionQueued('s1', { messageId: 'A', chatId: 'chat1', reaction: 'ok', senderId: 'x@c.us' });
    projector.handleMessageAck('s1', engine, 'A', 'read');
    await flush();
    projector.handleInboundMessage('s1', engine, message('A', 'chat1'), t);
    await flush();

    expect(rows[0].status).toBe(MessageStatus.READ);
    expect((rows[0].metadata as Row).reactions).toEqual({ 'x@c.us': 'ok' });
  });

  it('applies a REST delete and a REST edit made before the emit', async () => {
    const a = admit(arrival('A', 'chat1'));
    const b = admit(arrival('B', 'chat2'));
    await projector.recordRevoke('s1', 'A');
    await projector.recordOutboundMessageEdit('s1', 'B', 'rest edit');
    projector.handleInboundMessage('s1', engine, message('A', 'chat1'), a);
    projector.handleInboundMessage('s1', engine, message('B', 'chat2'), b);
    await flush();

    expect(rows.find(r => r.waMessageId === 'A')).toEqual(expect.objectContaining({ body: '', type: 'revoked' }));
    expect(rows.find(r => r.waMessageId === 'B')).toEqual(expect.objectContaining({ body: 'rest edit' }));
    // A delete for me: the message still exists for its sender, so it is announced as revoked.
    expect(dispatched('message.received').map(m => [m.id, m.type, m.body])).toEqual([
      ['A', 'revoked', ''],
      ['B', 'text', 'rest edit'],
    ]);
  });

  it('keeps a revoke recorded between two deliveries of one id for the delivery that is emitted', async () => {
    const first = admit(arrival('A', 'chat1'));
    const second = admit(arrival('A', 'chat1'));
    first.drop();
    await flush();
    projector.handleMessageRevoked('s1', engine, { id: 'A', chatId: 'chat1' } as never);
    projector.handleInboundMessage('s1', engine, message('A', 'chat1'), second);
    await flush();

    expect(rows).toEqual([expect.objectContaining({ waMessageId: 'A', type: 'revoked' })]);
    expect(dispatched('message.received')).toEqual([]);
  });

  it('lends nothing to a quote before the emit, and the message once emitted', async () => {
    let release: () => void = () => undefined;
    insertGate = () => new Promise(resolve => (release = resolve));
    const t = admit(arrival('A', 'chat1'));
    expect(projector.inFlightInbound('s1', 'A')).toBeUndefined();

    projector.handleInboundMessage('s1', engine, message('A', 'chat1'), t);
    expect(projector.inFlightInbound('s1', 'A')).toEqual(expect.objectContaining({ body: 'body of A' }));
    await flush();
    release();
    await flush();
    expect(projector.inFlightInbound('s1', 'A')).toBeUndefined();
  });

  it('keeps no payload of a repeat delivery in the shared entry once that delivery committed', async () => {
    process.env.INBOUND_MEDIA_CONCURRENCY = '2';
    let inserts = 0;
    insertGate = () => (++inserts === 2 ? new Promise(() => undefined) : Promise.resolve());
    const first = admit(arrival('X', 'chat1', true));
    const repeat = admit(arrival('X', 'chat1', true));
    expect(await first.reserve()).toBe(true);
    expect(await repeat.reserve()).toBe(true);
    const image = (data: string) => message('X', 'chat1', { type: 'image', media: { mimetype: 'image/png', data } });
    // The repeat is emitted first; the first delivery commits first and gives its slot back.
    projector.handleInboundMessage('s1', engine, image('P2xx'), repeat);
    projector.handleInboundMessage('s1', engine, image('P1xx'), first);
    await flush();
    expect(room()?.gate.activeCount).toBe(1);

    // Only the repeat's own payload may still be reachable: its slot accounts for it.
    const entries = (projector as unknown as { inboundInFlight: Map<string, unknown> }).inboundInFlight;
    expect(JSON.stringify([...entries.values()])).not.toContain('P1xx');
    expect(projector.inFlightInbound('s1', 'X')).toEqual({ chatId: 'chat1', body: 'body of X' });
  });

  it('keeps the slot of a payload whose insert stalls, sheds later media after the wait, and lets text flow', async () => {
    process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '20';
    insertGate = row => (row.waMessageId === 'M1' ? new Promise(() => undefined) : Promise.resolve());

    const m1 = admit(arrival('M1', 'chat1', true));
    expect(await m1.reserve()).toBe(true);
    projector.handleInboundMessage('s1', engine, message('M1', 'chat1', { type: 'image' }), m1);

    const m2 = admit(arrival('M2', 'chat2', true));
    const text = admit(arrival('T', 'chat3'));
    projector.handleInboundMessage('s1', engine, message('T', 'chat3'), text);
    await flush();
    expect(insertedIds()).toEqual(['T']);

    const started = Date.now();
    expect(await m2.reserve()).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    // The stalled payload is still referenced by its commit, so its slot is not handed back.
    expect(room()?.gate.activeCount).toBe(1);

    projector.handleInboundMessage('s1', engine, message('M2', 'chat2', { type: 'image' }), m2);
    await flush();
    expect(insertedIds()).toEqual(['T', 'M2']);
  });

  it('keeps the room across an engine replacement, and releases the old engine pending turns at once', async () => {
    let release: () => void = () => undefined;
    insertGate = row => (row.waMessageId === 'M1' ? new Promise(resolve => (release = resolve)) : Promise.resolve());
    const m1 = admit(arrival('M1', 'chat1', true));
    projector.handleInboundMessage('s1', engine, message('M1', 'chat1', { type: 'image' }), m1);
    const waiting = admit(arrival('M2', 'chat2', true));
    const pendingReserve = waiting.reserve();
    const pendingText = admit(arrival('T1', 'chat2'));
    await flush();

    const replacement = { tag: 'two' } as unknown as IWhatsAppEngine;
    engines.set('s1', replacement);
    // Woken at once, not after the room wait.
    expect(await pendingReserve).toBe(false);
    expect(pendingText.reserve()).toBe(false);

    // The replaced engine's stalled payload still counts: the new engine gets no extra slot.
    const t2 = admit(arrival('T2', 'chat2'), replacement);
    const m3 = admit(arrival('M3', 'chat2', true), replacement);
    projector.handleInboundMessage('s1', replacement, message('T2', 'chat2'), t2);
    await flush();
    // chat2's dropped turns no longer stand in the way.
    expect(insertedIds()).toEqual(['T2']);
    let granted: boolean | undefined;
    void Promise.resolve(m3.reserve()).then(v => (granted = v));
    await flush();
    expect(granted).toBeUndefined();

    release();
    await flush();
    expect(granted).toBe(true);
  });

  it('holds a status post slot until its ingest settles', async () => {
    const ingest = deferred<{ row: unknown; created: boolean }>();
    statusStore.ingest.mockReturnValue(ingest.promise);
    const status = admit(arrival('S1', 'status@broadcast', true, true));
    projector.handleInboundMessage(
      's1',
      engine,
      message('S1', 'status@broadcast', { isStatusBroadcast: true, from: 'peer@c.us', type: 'image' }),
      status,
    );
    const next = admit(arrival('M1', 'chat1', true));
    let granted: boolean | undefined;
    void Promise.resolve(next.reserve()).then(v => (granted = v));
    await flush();
    expect(statusStore.ingest).toHaveBeenCalled();
    expect(granted).toBeUndefined();

    ingest.resolve({ row: {}, created: false });
    await flush();
    expect(granted).toBe(true);
  });

  it('holds nothing on SQLite: no admission, and the untouched path stores and announces as before', async () => {
    build('better-sqlite3');
    expect(projector.holdsInbound).toBe(false);

    projector.handleInboundMessage('s1', engine, message('A', 'chat1'));
    await flush();

    expect(insertedIds()).toEqual(['A']);
    expect(dispatched('message.received')).toHaveLength(1);
    expect((projector as unknown as { rooms: Map<string, unknown> }).rooms.size).toBe(0);
  });
});
