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
  RevokedMessage,
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
    if (op && typeof op === 'object' && op._type === 'or') {
      return (op._value as unknown[]).some(alternative => matches(row, { [key]: alternative }));
    }
    if (op && typeof op === 'object' && op._type === 'isNull') return row[key] == null;
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

const arrival = (id: string, chatId: string, needsRoom = false, status = false, fromMe?: boolean, author?: string) => ({
  id,
  chatId,
  needsRoom,
  status,
  fromMe,
  author,
});

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

  const build = (type: string, findPhoneForLid?: jest.Mock): void => {
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
      undefined,
      undefined,
      undefined,
      findPhoneForLid ? ({ findPhoneForLid } as never) : undefined,
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
  // As the real table's unique index refuses a second row under an id.
  const uniqueIndex = (): void => {
    insertGate = row =>
      rows.some(r => r.waMessageId === row.waMessageId)
        ? Promise.reject(Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT_UNIQUE' }))
        : Promise.resolve();
  };

  beforeEach(() => {
    process.env.INBOUND_MEDIA_CONCURRENCY = '1';
    build('postgres');
  });

  describe('reported identities before the row exists', () => {
    const lid = '480001@lid';
    const phone = '628001@c.us';
    const edit = (chatId: string, body: string, timestamp = 2) => ({
      ...message('A', chatId),
      messageId: 'A',
      senderId: chatId,
      hasMedia: false,
      body,
      timestamp,
    });

    it.each(['edit', 'revoke', 'reaction'] as const)(
      'waits for a reported pairing before applying a held %s',
      async kind => {
        const lookup = deferred<string | null>();
        const findPhone = jest.fn(() => lookup.promise);
        build('postgres', findPhone);
        const ticket = admit(arrival('A', lid, false, false, false));
        if (kind === 'edit') projector.applyMessageEditQueued('s1', edit(phone, 'edited', 2));
        else if (kind === 'reaction')
          projector.applyReactionQueued('s1', {
            messageId: 'A',
            chatId: phone,
            senderId: phone,
            reaction: 'yes',
          });
        else
          projector.handleMessageRevoked('s1', engine, { ...message('A', phone), revokedId: 'A' } as RevokedMessage, {
            fromMe: false,
          });
        const receipt = projector.handleInboundMessage('s1', engine, message('A', lid), ticket)!;
        await flush();
        expect(findPhone).toHaveBeenCalledWith(lid);
        expect(hookStarts).toEqual([]);
        expect(rows).toEqual([]);
        lookup.resolve('628001');
        await receipt.settled;
        await flush();
        expect(rows[0]).toMatchObject({
          body: kind === 'revoke' ? '' : kind === 'edit' ? 'edited' : 'body of A',
          type: kind === 'revoke' ? 'revoked' : 'text',
        });
        if (kind === 'reaction') expect(rows[0].metadata).toMatchObject({ reactions: { [phone]: 'yes' } });
      },
    );

    it.each([null, '628999'])('does not accept an unreported or different pairing (%s)', async mapped => {
      build('postgres', jest.fn().mockResolvedValue(mapped));
      const ticket = admit(arrival('A', lid, false, false, false));
      projector.applyMessageEditQueued('s1', edit(phone, 'foreign', 2));
      const receipt = projector.handleInboundMessage('s1', engine, message('A', lid), ticket)!;
      await receipt.settled;
      await flush();
      expect(rows[0].body).toBe('body of A');
      expect(dispatched('message.edited')).toEqual([]);
    });

    it('keeps the arrival order when an exact edit follows an unresolved alias edit', async () => {
      const lookup = deferred<string | null>();
      build(
        'postgres',
        jest
          .fn()
          .mockImplementationOnce(() => lookup.promise)
          .mockResolvedValue('628001'),
      );
      const ticket = admit(arrival('A', lid, false, false, false));
      projector.applyMessageEditQueued('s1', edit(phone, 'first', 2));
      projector.applyMessageEditQueued('s1', edit(lid, 'last', 3));
      const receipt = projector.handleInboundMessage('s1', engine, message('A', lid), ticket)!;
      await flush();
      lookup.resolve('628001');
      await receipt.settled;
      await flush();
      expect(dispatched('message.edited').map(change => change.body)).toEqual(['first', 'last']);
      expect(rows[0].body).toBe('last');
      expect(dispatched('message.received')[0].body).toBe('last');
    });

    it('waits for a pairing requested while the receive hook is running', async () => {
      const lookup = deferred<string | null>();
      const hook = deferred<void>();
      build(
        'postgres',
        jest.fn(() => lookup.promise),
      );
      hookManager.execute.mockImplementation(async (_event: string, data: unknown) => {
        await hook.promise;
        return { data };
      });
      const receipt = projector.handleInboundMessage(
        's1',
        engine,
        message('A', lid),
        admit(arrival('A', lid, false, false, false)),
      )!;
      await flush();
      projector.applyMessageEditQueued('s1', edit(phone, 'edited', 2));
      hook.resolve();
      await flush();
      expect(rows).toEqual([]);
      expect(dispatched('message.received')).toEqual([]);
      lookup.resolve('628001');
      await receipt.settled;
      await flush();
      expect(rows[0].body).toBe('edited');
      expect(dispatched('message.received')[0].body).toBe('edited');
    });

    it('waits for a pairing requested during the insert before announcing its content', async () => {
      const lookup = deferred<string | null>();
      const inserting = deferred<void>();
      build(
        'postgres',
        jest.fn(() => lookup.promise),
      );
      insertGate = () => inserting.promise;
      const receipt = projector.handleInboundMessage(
        's1',
        engine,
        message('A', lid),
        admit(arrival('A', lid, false, false, false)),
      )!;
      await flush();
      projector.applyMessageEditQueued('s1', edit(phone, 'edited', 2));
      inserting.resolve();
      await flush();
      expect(dispatched('message.received')).toEqual([]);
      lookup.resolve('628001');
      await receipt.settled;
      await flush();
      expect(rows[0].body).toBe('edited');
      expect(dispatched('message.received')[0].body).toBe('edited');
    });

    it.each(['edit', 'revoke'].flatMap(kind => [true, false].map(exact => ({ kind, exact }))))(
      'keeps SQLite persisted notifications consistent with a held $kind (exact=$exact)',
      async ({ kind, exact }) => {
        const hook = deferred<void>();
        build('better-sqlite3', jest.fn().mockResolvedValue('628001'));
        const archived: Row[] = [];
        Object.assign(projector, {
          chatMediaArchive: {
            archive: jest.fn((row: Row) => {
              archived.push({ ...row });
              return Promise.resolve();
            }),
          },
        });
        hookManager.execute.mockImplementation(async (event: string, data: unknown) => {
          if (event === 'message:received') await hook.promise;
          return { data };
        });
        const receipt = projector.handleInboundMessage('s1', engine, message('A', lid))!;
        const target = exact ? lid : phone;
        if (kind === 'edit') projector.applyMessageEditQueued('s1', edit(target, 'edited'));
        else
          projector.handleMessageRevoked('s1', engine, { ...message('A', target), revokedId: 'A' } as RevokedMessage, {
            fromMe: false,
          });
        await flush();
        hook.resolve();
        await receipt.settled;
        await flush();
        expect(persistedHooks().length).toBeGreaterThan(0);
        expect(archived).toHaveLength(1);
        expect(archived[0]).toMatchObject({
          body: kind === 'edit' ? 'edited' : '',
          type: kind === 'edit' ? 'text' : 'revoked',
        });
        expect(
          persistedHooks().every(
            row =>
              row.body === (kind === 'edit' ? 'edited' : '') && row.type === (kind === 'edit' ? 'text' : 'revoked'),
          ),
        ).toBe(true);
      },
    );

    it('keeps an own-send echo behind an identity check started during its hook', async () => {
      const lookup = deferred<string | null>();
      const hook = deferred<void>();
      build(
        'postgres',
        jest.fn(() => lookup.promise),
      );
      hookManager.execute.mockImplementation(async (event: string, data: unknown) => {
        if (event === 'message:sent') await hook.promise;
        return { data };
      });
      projector.handleOwnSendEcho(
        's1',
        engine,
        message('A', lid, { fromMe: true }),
        admit(arrival('A', lid, false, false, true)),
      );
      await flush();
      projector.applyMessageEditQueued('s1', { ...edit(phone, 'edited'), fromMe: true });
      hook.resolve();
      await flush();
      expect(rows).toEqual([]);
      expect(dispatched('message.sent')).toEqual([]);
      lookup.resolve('628001');
      await flush();
      expect(rows[0].body).toBe('edited');
      expect(dispatched('message.sent')[0].body).toBe('edited');
    });

    it.each(['edit', 'revoke'] as const)('keeps a requested %s while its alias identity is checked', async kind => {
      const lookup = deferred<string | null>();
      build(
        'postgres',
        jest.fn(() => lookup.promise),
      );
      const ticket = admit(arrival('A', lid, false, false, true));
      const source = { kind, chatId: phone, fromMe: true } as const;
      const changed =
        kind === 'edit'
          ? projector.recordOutboundMessageEdit('s1', 'A', 'edited', source)
          : projector.recordRevoke('s1', 'A', source);
      const receipt = projector.handleInboundMessage('s1', engine, message('A', lid, { fromMe: true }), ticket)!;
      await flush();
      expect(rows).toEqual([]);
      lookup.resolve('628001');
      await changed;
      await receipt.settled;
      await flush();
      expect(rows[0]).toMatchObject({
        body: kind === 'edit' ? 'edited' : '',
        type: kind === 'edit' ? 'text' : 'revoked',
      });
    });

    it('drains a rejected identity read without applying the alias change', async () => {
      build('postgres', jest.fn().mockRejectedValue(new Error('read unavailable')));
      const ticket = admit(arrival('A', lid, false, false, false));
      projector.applyMessageEditQueued('s1', edit(phone, 'foreign', 2));
      await projector.handleInboundMessage('s1', engine, message('A', lid), ticket)!.settled;
      await flush();
      expect(rows[0].body).toBe('body of A');
      expect(dispatched('message.edited')).toEqual([]);
    });

    it('does not apply a pending alias change to a replacement entry of another identity', async () => {
      const lookup = deferred<string | null>();
      build(
        'postgres',
        jest.fn(() => lookup.promise),
      );
      admit(arrival('A', lid, false, false, false));
      projector.applyMessageEditQueued('s1', edit(phone, 'foreign', 2));
      await flush();
      const entries = (projector as unknown as { inboundInFlight: Map<string, object> }).inboundInFlight;
      const replacement = { ref: { chatId: '629999@c.us', direction: 'incoming' } };
      entries.set('s1:A', replacement);
      lookup.resolve('628001');
      await flush();
      expect(replacement).not.toHaveProperty('editedBody');
      expect(dispatched('message.edited')).toEqual([]);
    });

    it('discards a directory result after the reporting engine retires', async () => {
      const lookup = deferred<string | null>();
      build(
        'postgres',
        jest.fn(() => lookup.promise),
      );
      const ticket = admit(arrival('A', lid, false, false, false));
      projector.applyMessageEditQueued('s1', edit(phone, 'late', 2));
      const receipt = projector.handleInboundMessage('s1', engine, message('A', lid), ticket)!;
      await flush();
      engines.set('s1', {} as IWhatsAppEngine);
      lookup.resolve('628001');
      await receipt.settled;
      await flush();
      expect(rows).toEqual([]);
      expect(dispatched('message.edited')).toEqual([]);
      expect(dispatched('message.received')).toEqual([]);
    });
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

  it('stores a message cleared when an actor-bearing revoke reaches it while the row read is still out', async () => {
    const t = admit(arrival('A', 'chat1', true));
    const gate = deferred<void>();
    const read = repo.findOne as jest.Mock;
    const unrestricted = read.getMockImplementation() as (arg: unknown) => Promise<unknown>;
    read.mockImplementation(async (arg: unknown) => {
      await gate.promise;
      return unrestricted(arg);
    });
    projector.handleMessageRevoked(
      's1',
      engine,
      {
        id: 'A',
        revokedId: 'A',
        chatId: 'chat1',
        from: 'chat1',
        to: 'me@c.us',
        type: 'revoked',
        body: '',
        timestamp: 1,
      },
      { fromMe: false },
    );
    projector.handleInboundMessage(
      's1',
      engine,
      message('A', 'chat1', { type: 'image', body: 'secret', media: { mimetype: 'image/png', data: 'QUJD' } }),
      t,
    );
    await flush();
    gate.resolve();
    await flush();

    expect(hookStarts).toEqual([]);
    expect(rows).toEqual([expect.objectContaining({ waMessageId: 'A', body: '', type: 'revoked', metadata: null })]);
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
    expect(rows[0]).toEqual(expect.objectContaining({ body: 'edited', metadata: { edited: true } }));
    // The row `message:persisted` hands out is the one the edit left, marker included.
    expect(persistedHooks()[0]).toEqual(expect.objectContaining({ body: 'edited', metadata: { edited: true } }));
    expect(dispatched('message.received')[0]).toEqual(expect.objectContaining({ body: 'edited' }));
  });

  // An edit that repeats the text the message carries changes nothing, so it leaves no mark, though it is announced.
  it.each([
    ['before the emit', false],
    ['after the emit, while the insert is out', true],
  ])('leaves an edit that repeats the text unmarked, %s', async (_when, afterEmit) => {
    const stall = deferred<void>();
    if (afterEmit) insertGate = () => stall.promise;
    const t = admit(arrival('A', 'chat1'));
    if (!afterEmit) projector.applyMessageEditQueued('s1', { messageId: 'A', body: 'original' } as never);
    projector.handleInboundMessage('s1', engine, message('A', 'chat1', { body: 'original' }), t);
    if (afterEmit) {
      await flush();
      projector.applyMessageEditQueued('s1', { messageId: 'A', body: 'original' } as never);
      await flush();
      stall.resolve();
    }
    await flush();

    expect(rows).toEqual([expect.objectContaining({ body: 'original', metadata: undefined })]);
    expect(persistedHooks()[0]).toEqual(expect.objectContaining({ body: 'original', metadata: undefined }));
    expect(eventsGateway.emitMessageEdited).toHaveBeenCalledTimes(1);
    expect(eventsGateway.emitMessage).toHaveBeenCalledTimes(1);
    const [[, announced]] = eventsGateway.emitMessage.mock.calls as Array<[string, Record<string, unknown>]>;
    expect(announced).not.toHaveProperty('edited');
  });

  it('marks an edit that restores the text after another one, before the emit', async () => {
    const t = admit(arrival('A', 'chat1'));
    projector.applyMessageEditQueued('s1', { messageId: 'A', body: 'v1' } as never);
    projector.applyMessageEditQueued('s1', { messageId: 'A', body: 'original' } as never);
    projector.handleInboundMessage('s1', engine, message('A', 'chat1', { body: 'original' }), t);
    await flush();

    expect(rows).toEqual([expect.objectContaining({ body: 'original', metadata: { edited: true } })]);
  });

  // The engine applied the edit and told the session of it before the hand-over, so the message is handed over
  // already edited, with the text it arrived with beside it.
  it('compares an edit held before the emit with the text the message arrived with', async () => {
    const t = admit(arrival('A', 'chat1'));
    projector.applyMessageEditQueued('s1', { messageId: 'A', body: 'fixed' } as never);
    projector.handleInboundMessage('s1', engine, message('A', 'chat1', { body: 'fixed', originalBody: 'original' }), t);
    const same = admit(arrival('B', 'chat1'));
    projector.applyMessageEditQueued('s1', { messageId: 'B', body: 'original' } as never);
    projector.handleInboundMessage('s1', engine, message('B', 'chat1', { body: 'original' }), same);
    await flush();

    expect(rows).toEqual([
      expect.objectContaining({ waMessageId: 'A', body: 'fixed', metadata: { edited: true } }),
      expect.objectContaining({ waMessageId: 'B', body: 'original', metadata: undefined }),
    ]);
    // The webhook and the socket are told alike.
    const received = (webhookService.dispatch.mock.calls as Array<[string, string, Record<string, unknown>]>)
      .filter(([, event]) => event === 'message.received')
      .map(([, , payload]) => payload);
    expect(received).toEqual([expect.objectContaining({ id: 'A', body: 'fixed', edited: true }), expect.anything()]);
    expect(received[1]).toEqual(expect.objectContaining({ id: 'B', body: 'original' }));
    expect(received[1]).not.toHaveProperty('edited');
    const emitted = eventsGateway.emitMessage.mock.calls as Array<[string, Record<string, unknown>]>;
    expect(emitted.map(([, payload]) => payload)).toEqual(received);
  });

  // An engine names the text the message arrived with only when the edit it applied changed it.
  it('stores a message the engine handed over edited as marked, though no edit was held for it', async () => {
    const t = admit(arrival('A', 'chat1'));
    projector.handleInboundMessage('s1', engine, message('A', 'chat1', { body: 'fixed', originalBody: 'original' }), t);
    await flush();

    expect(rows).toEqual([expect.objectContaining({ waMessageId: 'A', body: 'fixed', metadata: { edited: true } })]);
    expect(persistedHooks()[0]).toEqual(expect.objectContaining({ body: 'fixed', metadata: { edited: true } }));
    const [[, announced]] = eventsGateway.emitMessage.mock.calls as Array<[string, Record<string, unknown>]>;
    expect(announced).toEqual(expect.objectContaining({ body: 'fixed', edited: true }));
  });

  it('marks a message edited while its insert is out, where nothing holds the arrival (SQLite)', async () => {
    build('better-sqlite3');
    const stall = deferred<void>();
    insertGate = () => stall.promise;
    projector.handleInboundMessage('s1', engine, message('A', 'chat1', { body: 'original' }));
    await flush();
    projector.applyMessageEditQueued('s1', { messageId: 'A', body: 'edited' } as never);
    await flush();
    stall.resolve();
    await flush();

    expect(rows).toEqual([expect.objectContaining({ body: 'edited', metadata: { edited: true } })]);
  });

  // A REST edit of a send the account's phone composed reaches the echo while it waits for its row.
  describe.each([
    ['PostgreSQL', 'postgres'],
    ['SQLite', 'better-sqlite3'],
  ])('an own-send echo that a REST edit reaches before its row is written, on %s', (_name, type) => {
    const CHAT = '15550001111@c.us';

    it('stores the row with the edit and its marker', async () => {
      build(type);
      const hook = deferred<void>();
      hookManager.execute.mockImplementationOnce(async (_event: string, data: unknown) => {
        await hook.promise;
        return { continue: true, data };
      });
      const ticket = type === 'postgres' ? admit(arrival('A', CHAT, false, false, true)) : undefined;
      projector.handleOwnSendEcho('s1', engine, message('A', CHAT, { fromMe: true, body: 'sent' }), ticket);
      await flush();
      await projector.recordOutboundMessageEdit('s1', 'A', 'rest edit', { kind: 'edit', chatId: CHAT, fromMe: true });
      hook.resolve();
      await flush();

      expect(rows).toEqual([expect.objectContaining({ body: 'rest edit', metadata: { edited: true } })]);
    });
  });

  // The entry exists from the arrival, and a change that names another chat or the other party has to be
  // held to the rule of the row it will become from then on, not only once the message is emitted.
  describe('a change that reaches a message admitted on arrival', () => {
    // Phone ids, so that two of them are provably different chats.
    const CHAT = '15550001111@c.us';
    const OTHER = '15559998888@c.us';

    it('keeps an edit from another chat out of the message, and does not announce it', async () => {
      const t = admit(arrival('A', CHAT, false, false, false));
      projector.applyMessageEditQueued('s1', {
        messageId: 'A',
        body: 'FORGED',
        chatId: OTHER,
        fromMe: false,
      } as never);
      projector.handleInboundMessage('s1', engine, message('A', CHAT, { body: 'original' }), t);
      await flush();

      expect(rows[0]).toEqual(expect.objectContaining({ body: 'original' }));
      expect(dispatched('message.edited')).toEqual([]);
      expect(eventsGateway.emitMessageEdited).not.toHaveBeenCalled();
    });

    it('keeps an edit that claims to come from the account out of a message the counterparty sent', async () => {
      const t = admit(arrival('A', CHAT, false, false, false));
      projector.applyMessageEditQueued('s1', {
        messageId: 'A',
        body: 'FORGED',
        chatId: CHAT,
        fromMe: true,
      } as never);
      projector.handleInboundMessage('s1', engine, message('A', CHAT, { body: 'original' }), t);
      await flush();

      expect(rows[0]).toEqual(expect.objectContaining({ body: 'original' }));
      expect(dispatched('message.edited')).toEqual([]);
    });

    it('keeps a reaction aimed through another chat out of the message, and does not announce it', async () => {
      const t = admit(arrival('A', CHAT, false, false, false));
      projector.applyReactionQueued('s1', { messageId: 'A', chatId: OTHER, reaction: 'X', senderId: 'x@c.us' });
      projector.handleInboundMessage('s1', engine, message('A', CHAT), t);
      await flush();

      expect((rows[0].metadata as Row | undefined)?.reactions).toBeUndefined();
      expect(eventsGateway.emitMessageReaction).not.toHaveBeenCalled();
    });

    it('still takes an edit from the same chat and sender', async () => {
      const t = admit(arrival('A', CHAT, false, false, false));
      projector.applyMessageEditQueued('s1', {
        messageId: 'A',
        body: 'edited',
        chatId: CHAT,
        fromMe: false,
      } as never);
      projector.handleInboundMessage('s1', engine, message('A', CHAT, { body: 'original' }), t);
      await flush();

      expect(rows[0]).toEqual(expect.objectContaining({ body: 'edited' }));
    });

    // An id names one message. A repeat of it sent from another chat is held under the same entry, and
    // must not take the entry over: a change aimed through the repeat would be judged by its chat.
    it('keeps the chat of the first arrival of an own echo too', async () => {
      const first = admit(arrival('A', CHAT, false, false, true));
      const repeat = admit(arrival('A', OTHER, false, false, true));
      const gate = deferred<void>();
      insertGate = row => (row.chatId === OTHER ? gate.promise : Promise.resolve());
      projector.handleOwnSendEcho('s1', engine, message('A', OTHER, { fromMe: true, body: 'repeat echo' }), repeat);
      await flush();
      projector.applyMessageEditQueued('s1', {
        messageId: 'A',
        body: 'FORGED',
        chatId: OTHER,
        fromMe: true,
      } as never);
      projector.handleOwnSendEcho('s1', engine, message('A', CHAT, { fromMe: true, body: 'echo' }), first);
      await flush();
      gate.resolve();
      await flush();

      expect(rows.find(r => r.chatId === CHAT)).toEqual(expect.objectContaining({ body: 'echo' }));
      expect(dispatched('message.sent').map(p => p.body)).not.toContain('FORGED');
    });

    // In a group the edit comes from the participant who wrote the message, which the arrival names.
    it('keeps a group edit by another participant out of the message, and takes the one by its author', async () => {
      const GROUP = '120363000000000001@g.us';
      const author = '15551110001@c.us';
      const t = admit(arrival('A', GROUP, false, false, false, author));
      projector.applyMessageEditQueued('s1', {
        messageId: 'A',
        body: 'FORGED',
        chatId: GROUP,
        fromMe: false,
        author: '15552220002@c.us',
      } as never);
      projector.handleInboundMessage('s1', engine, message('A', GROUP, { body: 'original', author }), t);
      await flush();
      expect(rows[0]).toEqual(expect.objectContaining({ body: 'original' }));

      const u = admit(arrival('B', GROUP, false, false, false, author));
      projector.applyMessageEditQueued('s1', {
        messageId: 'B',
        body: 'edited',
        chatId: GROUP,
        fromMe: false,
        author,
      } as never);
      projector.handleInboundMessage('s1', engine, message('B', GROUP, { body: 'original', author }), u);
      await flush();
      expect(rows[1]).toEqual(expect.objectContaining({ body: 'edited' }));
    });

    it('keeps the chat of the first arrival when a repeat of the id names another chat', async () => {
      const first = admit(arrival('A', CHAT, false, false, false));
      const repeat = admit(arrival('A', OTHER, false, false, false));
      // The repeat is emitted first and its insert is out; the changes that follow name its chat.
      const gate = deferred<void>();
      insertGate = row => (row.chatId === OTHER ? gate.promise : Promise.resolve());
      projector.handleInboundMessage('s1', engine, message('A', OTHER, { body: 'repeat' }), repeat);
      await flush();
      projector.applyMessageEditQueued('s1', {
        messageId: 'A',
        body: 'FORGED',
        chatId: OTHER,
        fromMe: false,
      } as never);
      projector.applyReactionQueued('s1', { messageId: 'A', chatId: OTHER, reaction: 'X', senderId: 'x@c.us' });
      projector.handleInboundMessage('s1', engine, message('A', CHAT, { body: 'original' }), first);
      await flush();
      gate.resolve();
      await flush();

      const original = rows.find(r => r.chatId === CHAT);
      expect(original).toEqual(expect.objectContaining({ body: 'original' }));
      expect((original?.metadata as Row | undefined)?.reactions).toBeUndefined();
      expect(dispatched('message.received').map(p => p.body)).not.toContain('FORGED');
    });

    // The entry of a repeat that the engine will drop is no judge of a stored message: its row is.
    it('lets a change through to the stored row while a repeat of its id from another chat is held', async () => {
      rows.push({ sessionId: 's1', waMessageId: 'A', chatId: CHAT, direction: 'incoming', body: 'original' });
      admit(arrival('A', OTHER, false, false, false));
      projector.applyMessageEditQueued('s1', {
        messageId: 'A',
        body: 'edited',
        chatId: CHAT,
        fromMe: false,
      } as never);
      projector.applyReactionQueued('s1', { messageId: 'A', chatId: CHAT, reaction: 'ok', senderId: 'x@c.us' });
      await flush();

      expect(rows[0].body).toBe('edited');
      expect(dispatched('message.edited')).toHaveLength(1);
      expect((rows[0].metadata as Row).reactions).toEqual({ 'x@c.us': 'ok' });
    });

    it('still drops a change from the repeat chat aimed at the stored row, and announces nothing', async () => {
      rows.push({ sessionId: 's1', waMessageId: 'A', chatId: CHAT, direction: 'incoming', body: 'original' });
      admit(arrival('A', OTHER, false, false, false));
      projector.applyMessageEditQueued('s1', {
        messageId: 'A',
        body: 'FORGED',
        chatId: OTHER,
        fromMe: false,
      } as never);
      await flush();

      expect(rows[0].body).toBe('original');
      expect(dispatched('message.edited')).toEqual([]);
    });

    // The revoke of a message that has no row yet is applied at once, but only when the entry it names
    // agrees with who made it: the other side of a one-to-one chat cannot clear the account's message.
    describe('a revoke of a message still arriving', () => {
      const revoke = (chatId: string): RevokedMessage => ({
        id: 'A',
        revokedId: 'A',
        chatId,
        from: chatId,
        to: 'me@c.us',
        type: 'revoked',
        body: '',
        timestamp: 1,
      });

      it('is dropped when the other side of a one-to-one chat made it, and nothing is announced', async () => {
        const t = admit(arrival('A', CHAT, false, false, true));
        projector.handleMessageRevoked('s1', engine, revoke(CHAT), { fromMe: false });
        await flush();
        projector.handleInboundMessage('s1', engine, message('A', CHAT, { body: 'mine', fromMe: true }), t);
        await flush();

        expect(dispatched('message.revoked')).toEqual([]);
        expect(eventsGateway.emitMessageRevoked).not.toHaveBeenCalled();
        expect(rows[0]).toEqual(expect.objectContaining({ body: 'mine' }));
        expect(rows[0].type).not.toBe('revoked');
      });

      it('is applied when its author made it, before the message is emitted', async () => {
        const t = admit(arrival('A', CHAT, false, false, true));
        projector.handleMessageRevoked('s1', engine, revoke(CHAT), { fromMe: true });
        // Nothing waits for the row read: the emit that follows it at once announces nothing of the message.
        projector.handleInboundMessage('s1', engine, message('A', CHAT, { body: 'mine', fromMe: true }), t);
        await flush();

        expect(rows[0]).toEqual(expect.objectContaining({ body: '', type: 'revoked' }));
        expect(dispatched('message.revoked')).toHaveLength(1);
        expect(dispatched('message.received')).toEqual([]);
      });

      it('is judged by the stored row when a repeat of the id from another chat is held', async () => {
        rows.push({ sessionId: 's1', waMessageId: 'A', chatId: CHAT, direction: 'incoming', body: 'original' });
        admit(arrival('A', OTHER, false, false, false));
        projector.handleMessageRevoked('s1', engine, revoke(CHAT), { fromMe: false });
        await flush();

        expect(dispatched('message.revoked')).toHaveLength(1);
      });

      it('is dropped when the held entry calls it foreign and no row exists', async () => {
        admit(arrival('A', OTHER, false, false, false));
        projector.handleMessageRevoked('s1', engine, revoke(CHAT), { fromMe: false });
        await flush();

        expect(dispatched('message.revoked')).toEqual([]);
      });
    });

    it('does not guess a direction when the engine did not say whose message it is', async () => {
      const t = admit(arrival('A', CHAT));
      projector.applyMessageEditQueued('s1', {
        messageId: 'A',
        body: 'edited',
        chatId: CHAT,
        fromMe: true,
      } as never);
      projector.handleInboundMessage('s1', engine, message('A', CHAT, { body: 'original', fromMe: true }), t);
      await flush();

      expect(rows[0]).toEqual(expect.objectContaining({ body: 'edited' }));
    });
  });

  // An id names one message of one chat. A delivery that reuses the id of a message stored under another
  // chat is held under that id too, and a revoke from its chat agrees with it. That agreement says the
  // delivery is taken back, not that the stored message is: only the row can say whose revoke it is.
  describe('a revoke from the chat of a delivery that reuses the id of a stored message', () => {
    const CHAT = '15550001111@c.us';
    const OTHER = '15559998888@c.us';
    const GROUP = '120363000000000001@g.us';
    const MEMBER = '15551110001@c.us';
    const stored = (over: Row = {}): Row => ({
      sessionId: 's1',
      waMessageId: 'A',
      chatId: CHAT,
      direction: 'incoming',
      type: 'text',
      body: 'original',
      metadata: { keep: true },
      ...over,
    });
    const revoke = (chatId: string): RevokedMessage => ({
      id: 'A',
      revokedId: 'A',
      chatId,
      from: chatId,
      to: 'me@c.us',
      type: 'revoked',
      body: '',
      timestamp: 1,
    });
    it('leaves the stored row alone and announces nothing, while the delivery is held', async () => {
      rows.push(stored());
      uniqueIndex();
      const t = admit(arrival('A', OTHER, false, false, false));
      projector.handleMessageRevoked('s1', engine, revoke(OTHER), { fromMe: false });
      await flush();
      const receipt = projector.handleInboundMessage('s1', engine, message('A', OTHER, { body: 'repeat' }), t);
      await flush();

      expect(rows).toEqual([stored()]);
      expect(dispatched('message.revoked')).toEqual([]);
      expect(eventsGateway.emitMessageRevoked).not.toHaveBeenCalled();
      expect(dispatched('message.received')).toEqual([]);
      // The delivery was refused as another message than the one the row holds.
      await expect(receipt?.settled).resolves.toEqual({ conflict: true });
    });

    it('leaves the stored row alone on SQLite too, while the delivery runs its hook chain', async () => {
      build('better-sqlite3');
      rows.push(stored());
      uniqueIndex();
      projector.handleInboundMessage('s1', engine, message('A', OTHER, { body: 'repeat' }));
      projector.handleMessageRevoked('s1', engine, revoke(OTHER), { fromMe: false });
      await flush();

      expect(rows).toEqual([stored()]);
      expect(dispatched('message.revoked')).toEqual([]);
      expect(eventsGateway.emitMessageRevoked).not.toHaveBeenCalled();
    });

    it('keeps the revoke for the delivery itself, which is stored cleared where nothing holds the id', async () => {
      rows.push(stored());
      uniqueIndex();
      const t = admit(arrival('A', OTHER, false, false, false));
      projector.handleMessageRevoked('s1', engine, revoke(OTHER), { fromMe: false });
      await flush();
      // The stored message is gone (pruned, say) before the delivery commits.
      rows.length = 0;
      projector.handleInboundMessage('s1', engine, message('A', OTHER, { body: 'repeat' }), t);
      await flush();

      expect(rows).toEqual([expect.objectContaining({ waMessageId: 'A', chatId: OTHER, body: '', type: 'revoked' })]);
      expect(hookStarts).toEqual([]);
      expect(dispatched('message.received')).toEqual([]);
    });

    it('leaves the account own message alone when the other side reuses its id in the same chat', async () => {
      rows.push(stored({ direction: 'outgoing' }));
      uniqueIndex();
      admit(arrival('A', CHAT, false, false, false));
      projector.handleMessageRevoked('s1', engine, revoke(CHAT), { fromMe: false });
      await flush();

      expect(rows).toEqual([stored({ direction: 'outgoing' })]);
      expect(dispatched('message.revoked')).toEqual([]);
    });

    it('still clears the stored message when its own chat revokes it while a repeat of it is held', async () => {
      rows.push(stored());
      admit(arrival('A', CHAT, false, false, false));
      projector.handleMessageRevoked('s1', engine, revoke(CHAT), { fromMe: false });
      await flush();

      expect(rows[0]).toEqual(expect.objectContaining({ body: '', type: 'revoked', metadata: null }));
      expect(dispatched('message.revoked')).toHaveLength(1);
    });

    it('still clears a member message a group admin revokes while a repeat of it is held', async () => {
      rows.push(stored({ chatId: GROUP, author: MEMBER }));
      admit(arrival('A', GROUP, false, false, false, MEMBER));
      projector.handleMessageRevoked('s1', engine, revoke(GROUP), { fromMe: false });
      await flush();

      expect(rows[0]).toEqual(expect.objectContaining({ body: '', type: 'revoked' }));
      expect(dispatched('message.revoked')).toHaveLength(1);
    });

    it('still clears the account own message when it revokes it from its phone while the echo is held', async () => {
      rows.push(stored({ direction: 'outgoing' }));
      admit(arrival('A', CHAT, false, false, true));
      projector.handleMessageRevoked('s1', engine, revoke(CHAT), { fromMe: true });
      await flush();

      expect(rows[0]).toEqual(expect.objectContaining({ body: '', type: 'revoked' }));
      expect(dispatched('message.revoked')).toHaveLength(1);
    });

    it('still clears a row a REST send stored under the other dialect of the chat', async () => {
      rows.push(stored({ chatId: '15550001111@s.whatsapp.net', direction: 'outgoing' }));
      admit(arrival('A', CHAT, false, false, true));
      projector.handleMessageRevoked('s1', engine, revoke(CHAT), { fromMe: true });
      await flush();

      expect(rows[0]).toEqual(expect.objectContaining({ body: '', type: 'revoked' }));
      expect(dispatched('message.revoked')).toHaveLength(1);
    });

    it('takes back a message still arriving whose row nothing stores, as before', async () => {
      const t = admit(arrival('A', CHAT, false, false, false));
      projector.handleMessageRevoked('s1', engine, revoke(CHAT), { fromMe: false });
      projector.handleInboundMessage('s1', engine, message('A', CHAT), t);
      await flush();

      expect(rows).toEqual([expect.objectContaining({ waMessageId: 'A', body: '', type: 'revoked' })]);
      expect(dispatched('message.revoked')).toHaveLength(1);
      expect(dispatched('message.received')).toEqual([]);
    });

    // A status post keeps no entry: its own table takes it. A revoke of it reaches the row of the same
    // id, if there is one, only as a revoke of another chat.
    it('leaves a message alone that shares its id with a deleted status post', async () => {
      rows.push(stored());
      admit(arrival('A', 'status@broadcast', false, true));
      projector.handleMessageRevoked('s1', engine, revoke('status@broadcast'), { fromMe: false });
      await flush();

      expect(rows).toEqual([stored()]);
      expect(dispatched('message.revoked')).toEqual([]);
    });
  });

  // The echo of a send the REST writer already stored loses its insert to that row. What reached the message
  // while it waited is written onto the row once the row says it is the message, and a change that arrives
  // while the row is read came after it and is stored after it.
  describe.each([
    ['PostgreSQL', 'postgres'],
    ['SQLite', 'better-sqlite3'],
  ])('an own-send echo whose insert lost to the stored send, on %s', (_name, type) => {
    const CHAT = '15550001111@c.us';
    const edit = (body: string): void =>
      projector.applyMessageEditQueued('s1', { messageId: 'A', body, chatId: CHAT, fromMe: true } as never);
    const react = (reaction: string): void =>
      projector.applyReactionQueued('s1', { messageId: 'A', chatId: CHAT, reaction, senderId: CHAT });

    /**
     * The echo waits in its hook chain while `earlier` reaches it and before the REST send's row exists.
     * Its insert then loses to that row, and the read that judges the row is held while `later` arrives.
     */
    const lose = async (earlier: () => void, later: () => void): Promise<void> => {
      build(type);
      uniqueIndex();
      const hook = deferred<void>();
      hookManager.execute.mockImplementationOnce(async (_event: string, data: unknown) => {
        await hook.promise;
        return { continue: true, data };
      });
      const ticket = type === 'postgres' ? admit(arrival('A', CHAT, false, false, true)) : undefined;
      projector.handleOwnSendEcho('s1', engine, message('A', CHAT, { fromMe: true, body: 'orig' }), ticket);
      await flush();
      earlier();
      await flush();
      rows.push({ sessionId: 's1', waMessageId: 'A', chatId: CHAT, direction: 'outgoing', type: 'text', body: 'orig' });
      const read = repo.findOne as jest.Mock;
      const open = deferred<void>();
      const unrestricted = read.getMockImplementation() as (arg: unknown) => Promise<unknown>;
      read.mockImplementationOnce(async (arg: unknown) => {
        await open.promise;
        return unrestricted(arg);
      });
      hook.resolve();
      await flush();
      later();
      await flush();
      open.resolve();
      await flush();
      expect(dispatched('message.sent')).toHaveLength(1);
    };

    it('writes the edit recorded for the echo onto the row, marked edited', async () => {
      await lose(
        () => edit('v1'),
        () => undefined,
      );

      expect(rows[0].body).toBe('v1');
      expect((rows[0].metadata as Row).edited).toBe(true);
    });

    it('writes the REST edit recorded for the echo onto the row, marked edited', async () => {
      await lose(
        () => void projector.recordOutboundMessageEdit('s1', 'A', 'v1', { kind: 'edit', chatId: CHAT, fromMe: true }),
        () => undefined,
      );

      expect(rows[0].body).toBe('v1');
      expect((rows[0].metadata as Row).edited).toBe(true);
    });

    it('writes the reaction recorded for the echo onto the row', async () => {
      await lose(
        () => react('thumb'),
        () => undefined,
      );

      expect((rows[0].metadata as Row).reactions).toEqual({ [CHAT]: 'thumb' });
    });

    it('stores an edit that arrives while the row is read after the one recorded for the echo', async () => {
      await lose(
        () => edit('v1'),
        () => edit('v2'),
      );

      expect(rows[0].body).toBe('v2');
      expect((rows[0].metadata as Row).edited).toBe(true);
      expect(
        (eventsGateway.emitMessageEdited.mock.calls as Array<[string, { body: string }]>).map(c => c[1].body),
      ).toEqual(['v1', 'v2']);
    });

    it('stores a reaction that arrives while the row is read after the one recorded for the echo', async () => {
      await lose(
        () => react('thumb'),
        () => react('heart'),
      );

      expect((rows[0].metadata as Row).reactions).toEqual({ [CHAT]: 'heart' });
    });
  });

  // What reached an echo while its hook chain ran is written onto its row once its insert settled, on the
  // message's mutation chain. When that write is slow, a later change of the message waits behind it, so the
  // older body is not stored over the newer one, whether the insert lost to the stored send or landed.
  describe.each([
    ['PostgreSQL', 'postgres'],
    ['SQLite', 'better-sqlite3'],
  ])('an own-send echo whose recorded edit is written slowly, on %s', (_name, type) => {
    const CHAT = '15550001111@c.us';
    const edit = (body: string): void =>
      projector.applyMessageEditQueued('s1', { messageId: 'A', body, chatId: CHAT, fromMe: true } as never);

    /** `v1` reaches the echo in its hook chain; its write is held while `v2` arrives, then released. */
    const holdWrite = async (storedBySend: boolean): Promise<void> => {
      build(type);
      uniqueIndex();
      const hook = deferred<void>();
      hookManager.execute.mockImplementationOnce(async (_event: string, data: unknown) => {
        await hook.promise;
        return { continue: true, data };
      });
      const ticket = type === 'postgres' ? admit(arrival('A', CHAT, false, false, true)) : undefined;
      projector.handleOwnSendEcho('s1', engine, message('A', CHAT, { fromMe: true, body: 'orig' }), ticket);
      await flush();
      edit('v1');
      await flush();
      if (storedBySend) {
        rows.push({
          sessionId: 's1',
          waMessageId: 'A',
          chatId: CHAT,
          direction: 'outgoing',
          type: 'text',
          body: 'orig',
        });
      }
      const open = deferred<void>();
      let held = 0;
      const update = repo.update as jest.Mock;
      const unrestricted = update.getMockImplementation() as (where: Row, patch: Row) => Promise<unknown>;
      update.mockImplementation(async (where: Row, patch: Row) => {
        if (patch.body === 'v1') {
          held++;
          await open.promise;
        }
        return unrestricted(where, patch);
      });
      hook.resolve();
      await flush();
      expect(held).toBe(1);
      edit('v2');
      await flush();
      open.resolve();
      await flush();
    };

    it('keeps a later edit behind the write of the one recorded for an echo that lost its insert', async () => {
      await holdWrite(true);

      expect(rows).toHaveLength(1);
      expect(rows[0].body).toBe('v2');
    });

    it('keeps a later edit behind the write of the one recorded for an echo whose insert landed', async () => {
      await holdWrite(false);

      expect(rows).toHaveLength(1);
      expect(rows[0].body).toBe('v2');
    });
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
    expect(rows.find(r => r.waMessageId === 'B')).toEqual(
      expect.objectContaining({ body: 'rest edit', metadata: { edited: true } }),
    );
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

  it('lends nothing to a quote before the stored-message check, and the message after it', async () => {
    let release: () => void = () => undefined;
    insertGate = () => new Promise(resolve => (release = resolve));
    const t = admit(arrival('A', 'chat1'));
    expect(projector.inFlightInbound('s1', 'A')).toBeUndefined();

    projector.handleInboundMessage('s1', engine, message('A', 'chat1'), t);
    expect(projector.inFlightInbound('s1', 'A')).toBeUndefined();
    await flush();
    expect(projector.inFlightInbound('s1', 'A')).toEqual(expect.objectContaining({ body: 'body of A' }));
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

  // A retired engine keeps emitting while its destroy runs. Admitting it would queue its messages in the
  // chat's order and take room slots for media that is dropped at emit.
  it('admits nothing for an engine that is no longer the live one', () => {
    engines.set('s1', { tag: 'two' } as unknown as IWhatsAppEngine);

    expect(projector.admitInbound('s1', engine, arrival('A', 'chat1', true))).toBeUndefined();

    const internals = projector as unknown as { tickets: Map<string, unknown>; inboundInFlight: Map<string, unknown> };
    expect(internals.tickets.size).toBe(0);
    expect(internals.inboundInFlight.size).toBe(0);
    expect(room()).toBeUndefined();
  });

  // The turn is only reached once earlier messages of the chat were emitted or dropped, so the engine
  // can retire while a message waits for it. Its plugins must not see a message of a stopped session.
  it('skips the hook chain of a message whose engine retired while it waited for its chat turn', async () => {
    admit(arrival('A', 'chat1'));
    const b = admit(arrival('B', 'chat1'));
    projector.handleInboundMessage('s1', engine, message('B', 'chat1'), b);
    await flush();
    expect(hookStarts).toEqual([]);

    engines.delete('s1');
    await flush();

    expect(hookStarts).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('forgets the room of a session without an engine once its last slot came back', async () => {
    const a = admit(arrival('A', 'chat1', true));
    expect(await a.reserve()).toBe(true);

    engines.delete('s1');
    expect(room()).toBeDefined();
    await flush();

    expect(room()).toBeUndefined();
  });

  it('forgets an idle room when its engine is retired', async () => {
    admit(arrival('A', 'chat1', true)).drop();
    await flush();
    expect(room()).toBeDefined();

    engines.delete('s1');

    expect(room()).toBeUndefined();
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
