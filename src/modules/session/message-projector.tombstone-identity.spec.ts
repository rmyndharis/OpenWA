import { DataSource, type Repository } from 'typeorm';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';
import { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import type { IncomingMessage, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import type { HookManager } from '../../core/hooks';
import type { EventsGateway } from '../events/events.gateway';
import { Message, MessageDirection } from '../message/entities/message.entity';
import type { WebhookService } from '../webhook/webhook.service';
import type { StatusStoreService } from '../status-store/status-store.service';
import { MessageProjector } from './message-projector.service';
import type { SessionLidResolver } from './session-lid-resolver.service';
import type { Session } from './entities/session.entity';
import { deferred } from './inbound-room';

const LID = '484848@lid';
const PHONE = '628111@c.us';
const SELF = '620000@c.us';
const flush = async (): Promise<void> => {
  for (let n = 0; n < 10; n++) await new Promise(resolve => setImmediate(resolve));
};
const incoming = (id: string, chatId: string, fromMe = false): IncomingMessage => ({
  id,
  chatId,
  from: fromMe ? SELF : chatId,
  to: fromMe ? chatId : SELF,
  fromMe,
  body: 'content',
  type: 'text',
  timestamp: 1_700_000_000,
  isGroup: false,
  kind: 'individual',
});

describe('reported identities before a tombstone delivery reaches its hooks', () => {
  let db: DataSource;
  let repository: Repository<Message>;
  let mappings: LidMappingStoreService;
  let engines: EngineRegistry;
  let engine: IWhatsAppEngine;
  let projector: MessageProjector;
  let hooked: IncomingMessage[];
  let sent: IncomingMessage[];
  let dispatched: IncomingMessage[];
  let emitted: IncomingMessage[];
  let persisted: Message[];
  let mediaConcurrency: string | undefined;
  let hookGate: Promise<void> | undefined;
  let hookAction:
    ((data: IncomingMessage, accept?: (data: IncomingMessage) => boolean) => Promise<IncomingMessage>) | undefined;

  beforeEach(async () => {
    mediaConcurrency = process.env.INBOUND_MEDIA_CONCURRENCY;
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message, LidMapping],
      synchronize: true,
    }).initialize();
    repository = db.getRepository(Message);
    mappings = new LidMappingStoreService(db.getRepository(LidMapping));
    engines = new EngineRegistry();
    engine = {} as IWhatsAppEngine;
    engines.set('s1', engine);
    hooked = [];
    sent = [];
    dispatched = [];
    emitted = [];
    persisted = [];
    hookGate = undefined;
    hookAction = undefined;
    projector = new MessageProjector(
      repository,
      { update: jest.fn().mockResolvedValue({ affected: 1 }) } as unknown as Repository<Session>,
      engines,
      new Proxy(
        {},
        {
          get: (_target, key) =>
            jest.fn((_session: string, data: IncomingMessage) => {
              if (key === 'emitMessage' || key === 'emitMessageSent') emitted.push({ ...data });
            }),
        },
      ) as unknown as EventsGateway,
      {
        dispatch: jest.fn((_session: string, event: string, data: IncomingMessage) => {
          if (event === 'message.sent') sent.push({ ...data });
          if (event === 'message.sent' || event === 'message.received') dispatched.push({ ...data });
          return Promise.resolve();
        }),
      } as unknown as WebhookService,
      {
        execute: jest.fn(
          async (event: string, data: IncomingMessage, options?: { accept?: (data: IncomingMessage) => boolean }) => {
            if (event === 'message:persisted')
              persisted.push(JSON.parse(JSON.stringify((data as unknown as { message: Message }).message)) as Message);
            if (event === 'message:received' || event === 'message:sent') {
              hooked.push({ ...data });
              if (data.id === 'block') await hookGate;
              if (hookAction) data = await hookAction(data, options?.accept);
            }
            return { continue: true, data };
          },
        ),
      } as unknown as HookManager,
      {} as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
      undefined,
      undefined,
      undefined,
      mappings,
    );
  });

  afterEach(async () => {
    await db.destroy();
    if (mediaConcurrency === undefined) delete process.env.INBOUND_MEDIA_CONCURRENCY;
    else process.env.INBOUND_MEDIA_CONCURRENCY = mediaConcurrency;
  });

  const remember = async (origin: string): Promise<void> => {
    if (origin === 'reported') await mappings.remember('484848', '628111', 's1');
    if (origin === 'unreported') {
      await mappings.rememberIfUnknown('484848', '628111', 's1');
      await mappings.reload();
    }
  };
  const tombstone = (chatId: string, fromMe: boolean): Promise<unknown> =>
    repository.insert({
      sessionId: 's1',
      waMessageId: 'A',
      chatId,
      from: fromMe ? SELF : chatId,
      to: fromMe ? chatId : SELF,
      direction: fromMe ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
      body: '',
      type: 'revoked',
      timestamp: 1_700_000_000,
    });
  const deliver = (message: IncomingMessage): void => {
    if (message.fromMe) projector.handleOwnSendEcho('s1', engine, message);
    else projector.handleInboundMessage('s1', engine, message);
  };

  it.each(
    ['reported', 'unreported', 'unknown'].flatMap(origin =>
      [false, true].flatMap(reverse => [false, true].map(own => [origin, reverse, own] as const)),
    ),
  )('checks a durable tombstone through %s identity, reverse=%s own=%s', async (origin, reverse, own) => {
    await remember(origin);
    await tombstone(reverse ? LID : PHONE, own);
    deliver(incoming('A', reverse ? PHONE : LID, own));
    await flush();

    expect(hooked).toEqual([
      expect.objectContaining({
        body: origin === 'reported' ? '' : 'content',
        type: origin === 'reported' ? 'revoked' : 'text',
      }),
    ]);
    expect(await repository.findOneByOrFail({ waMessageId: 'A' })).toEqual(
      expect.objectContaining({ body: '', type: 'revoked', metadata: null }),
    );
  });

  it.each([false, true])('takes an earlier own delivery back through a reported pair, reverse=%s', async reverse => {
    await remember('reported');
    const blocked = deferred<void>();
    hookGate = blocked.promise;
    const firstChat = reverse ? LID : PHONE;
    deliver(incoming('block', firstChat));
    deliver(incoming('A', firstChat, true));
    await flush();
    expect(hooked.some(message => message.id === 'A')).toBe(true);
    await tombstone(firstChat, true);
    deliver(incoming('A', reverse ? PHONE : LID, true));
    await flush();
    blocked.resolve();
    await flush();

    expect(sent).toHaveLength(2);
    for (const message of sent) expect(message).toEqual(expect.objectContaining({ body: '', type: 'revoked' }));
  });

  it.each(['unknown', 'unreported'].flatMap(origin => [false, true].map(reverse => [origin, reverse] as const)))(
    'keeps an earlier own delivery separate from a deleted %s identity, reverse=%s',
    async (origin, reverse) => {
      await remember(origin);
      const firstChat = reverse ? LID : PHONE;
      const firstHook = deferred<void>();
      hookAction = async data => {
        if (data.chatId === firstChat) await firstHook.promise;
        return data;
      };
      deliver(incoming('A', firstChat, true));
      await flush();
      await repository.insert({
        sessionId: 's1',
        waMessageId: 'A',
        chatId: firstChat,
        from: SELF,
        to: firstChat,
        direction: MessageDirection.OUTGOING,
        body: 'content',
        type: 'text',
        timestamp: 1_700_000_000,
      });
      deliver({ ...incoming('A', reverse ? PHONE : LID, true), type: 'revoked' });
      await flush();
      const quote = projector.inFlightInbound('s1', 'A');
      firstHook.resolve();
      await flush();

      expect(quote).toEqual({ chatId: firstChat, body: 'content' });
      expect(sent.find(message => message.chatId === firstChat)).toEqual(
        expect.objectContaining({ body: 'content', type: 'text' }),
      );
      expect(await repository.findOneByOrFail({ waMessageId: 'A' })).toEqual(
        expect.objectContaining({ body: 'content', type: 'text' }),
      );
    },
  );

  it.each([false, true])('lends no quote and runs no retired hook during a reported lookup, own=%s', async own => {
    await remember('reported');
    await tombstone(PHONE, own);
    const lookup = deferred<void>();
    const findPhone = mappings.findPhoneForLid.bind(mappings);
    jest.spyOn(mappings, 'findPhoneForLid').mockImplementation(async jid => {
      await lookup.promise;
      return findPhone(jid);
    });
    deliver(incoming('A', LID, own));
    await flush();
    const quoteWhileChecking = projector.inFlightInbound('s1', 'A');
    engines.delete('s1');
    lookup.resolve();
    await flush();

    expect(quoteWhileChecking).toBeUndefined();
    expect(hooked).toEqual([]);
    expect(sent).toEqual([]);
  });

  it.each(
    ['reported', 'unknown', 'unreported'].flatMap(origin =>
      ['edit', 'revoke'].flatMap(change =>
        [false, true].flatMap(own => [false, true].map(admitted => [origin, change, own, admitted] as const)),
      ),
    ),
  )(
    'keeps the winning row and consumers within %s identity after %s, own=%s admitted=%s',
    async (origin, change, own, admitted) => {
      await remember(origin);
      const firstHook = deferred<void>();
      hookAction = async data => {
        if (data.chatId === PHONE) await firstHook.promise;
        return data;
      };
      const send = (message: IncomingMessage) => {
        const ticket = admitted
          ? projector.admitInbound('s1', engine, {
              id: 'A',
              chatId: message.chatId,
              fromMe: own,
              needsRoom: false,
              status: false,
            })
          : undefined;
        if (own) projector.handleOwnSendEcho('s1', engine, message, ticket);
        else projector.handleInboundMessage('s1', engine, message, ticket);
      };
      send({ ...incoming('A', PHONE, own), body: 'first content' });
      await flush();
      if (change === 'edit') {
        projector.applyMessageEditQueued('s1', {
          messageId: 'A',
          chatId: PHONE,
          fromMe: own,
          body: 'edited first',
        } as never);
      } else {
        projector.handleMessageRevoked('s1', engine, { id: 'A', revokedId: 'A', chatId: PHONE } as never, {
          fromMe: own,
        });
      }
      await flush();
      send({ ...incoming('A', LID, own), body: 'later content' });
      await flush();
      const inserted = await repository.findOneByOrFail({ waMessageId: 'A' });
      const persistedWinner = persisted.filter(message => message.chatId === LID);
      const webhookWinner = dispatched.filter(message => message.chatId === LID);
      const socketWinner = emitted.filter(message => message.chatId === LID);
      firstHook.resolve();
      await flush();
      const final = await repository.findOneByOrFail({ waMessageId: 'A' });
      const accepted = origin === 'reported';
      const body = accepted ? (change === 'edit' ? 'edited first' : '') : 'later content';
      const type = accepted && change === 'revoke' ? 'revoked' : 'text';
      const expected = { body, type };

      const expectedDispatch = accepted && change === 'revoke' ? [] : [expect.objectContaining(expected)];
      const expectedRow: unknown = expect.objectContaining({ ...expected, chatId: LID });
      expect({ inserted, final, persistedWinner, webhookWinner, socketWinner }).toEqual({
        inserted: expectedRow,
        final: expectedRow,
        persistedWinner: [expect.objectContaining(expected)],
        webhookWinner: expectedDispatch,
        socketWinner: expectedDispatch,
      });
      expect(final.metadata?.edited).toBe(accepted && change === 'edit' ? true : undefined);
      expect((projector as unknown as { inboundInFlight: Map<string, unknown> }).inboundInFlight.size).toBe(0);
    },
  );

  it.each(
    ['reported', 'unknown', 'unreported'].flatMap(origin =>
      [false, true].flatMap(own => [false, true].map(admitted => [origin, own, admitted] as const)),
    ),
  )('records arrival bookkeeping only within %s identity, own=%s admitted=%s', async (origin, own, admitted) => {
    await remember(origin);
    const hooks = deferred<void>();
    hookAction = async data => {
      await hooks.promise;
      return data;
    };
    const send = (message: IncomingMessage) => {
      const ticket = admitted
        ? projector.admitInbound('s1', engine, {
            id: 'A',
            chatId: message.chatId,
            fromMe: own,
            needsRoom: false,
            status: false,
          })
        : undefined;
      if (own) projector.handleOwnSendEcho('s1', engine, message, ticket);
      else projector.handleInboundMessage('s1', engine, message, ticket);
    };
    send({ ...incoming('A', PHONE, own), body: 'first content' });
    await flush();
    send({ ...incoming('A', LID, own), body: 'later content', originalBody: 'earlier later content' });
    await flush();
    const entry = (
      projector as unknown as { inboundInFlight: Map<string, { body?: string; edited?: boolean }> }
    ).inboundInFlight.get('s1:A');
    const recorded = { body: entry?.body, edited: entry?.edited };
    hooks.resolve();
    await flush();

    expect(recorded).toEqual(
      origin === 'reported'
        ? { body: 'earlier later content', edited: true }
        : { body: 'first content', edited: undefined },
    );
    expect((projector as unknown as { inboundInFlight: Map<string, unknown> }).inboundInFlight.size).toBe(0);
  });

  it.each(
    ['unknown', 'unreported'].flatMap(origin =>
      ['edit', 'revoke'].flatMap(change => [false, true].map(own => [origin, change, own] as const)),
    ),
  )('does not lend a held %s identity its earlier %s, own=%s', async (origin, change, own) => {
    await remember(origin);
    const firstHook = deferred<void>();
    hookAction = async data => {
      if (data.chatId === PHONE) await firstHook.promise;
      return data;
    };
    const ticket = (chatId: string) =>
      projector.admitInbound('s1', engine, {
        id: 'A',
        chatId,
        fromMe: own,
        needsRoom: false,
        status: false,
      });
    const first = incoming('A', PHONE, own);
    if (own) projector.handleOwnSendEcho('s1', engine, first, ticket(PHONE));
    else projector.handleInboundMessage('s1', engine, first, ticket(PHONE));
    await flush();
    if (change === 'edit') {
      projector.applyMessageEditQueued('s1', {
        messageId: 'A',
        chatId: PHONE,
        fromMe: own,
        body: 'edited first',
      } as never);
    } else {
      projector.handleMessageRevoked('s1', engine, { id: 'A', revokedId: 'A', chatId: PHONE } as never, {
        fromMe: own,
      });
    }
    await flush();
    const later = { ...incoming('A', LID, own), body: 'separate content' };
    if (own) projector.handleOwnSendEcho('s1', engine, later, ticket(LID));
    else projector.handleInboundMessage('s1', engine, later, ticket(LID));
    await flush();
    const laterHook = hooked.find(message => message.chatId === LID);
    firstHook.resolve();
    await flush();

    expect(laterHook).toEqual(expect.objectContaining({ body: 'separate content', type: 'text' }));
  });

  it.each([false, true].flatMap(own => [false, true].map(admitted => [own, admitted] as const)))(
    'releases both holders after a foreign hook fails, own=%s admitted=%s',
    async (own, admitted) => {
      const firstHook = deferred<void>();
      hookAction = async data => {
        if (data.chatId === PHONE) await firstHook.promise;
        else throw new Error('hook unavailable');
        return data;
      };
      const send = (chatId: string) => {
        const ticket = admitted
          ? projector.admitInbound('s1', engine, {
              id: 'A',
              chatId,
              fromMe: own,
              needsRoom: false,
              status: false,
            })
          : undefined;
        if (own) projector.handleOwnSendEcho('s1', engine, incoming('A', chatId, own), ticket);
        else projector.handleInboundMessage('s1', engine, incoming('A', chatId, own), ticket);
      };
      send(PHONE);
      await flush();
      send(LID);
      await flush();
      firstHook.resolve();
      await flush();

      expect((projector as unknown as { inboundInFlight: Map<string, unknown> }).inboundInFlight.size).toBe(0);
      expect(await repository.findOneByOrFail({ waMessageId: 'A' })).toEqual(
        expect.objectContaining({ chatId: PHONE, body: 'content' }),
      );
    },
  );

  it.each(
    ['reported', 'unknown', 'unreported'].flatMap(origin =>
      ['before-reserve', 'while-waiting'].flatMap(timing => [false, true].map(own => [origin, timing, own] as const)),
    ),
  )('reserves media only within %s identity after revoke %s, own=%s', async (origin, timing, own) => {
    process.env.INBOUND_MEDIA_CONCURRENCY = '1';
    await remember(origin);
    const firstHook = deferred<void>();
    hookAction = async data => {
      if (data.chatId === PHONE) await firstHook.promise;
      return data;
    };
    const admit = (id: string, chatId: string, needsRoom: boolean) =>
      projector.admitInbound('s1', engine, {
        id,
        chatId,
        fromMe: own,
        needsRoom,
        status: false,
      })!;
    const first = admit('A', PHONE, false);
    if (own) projector.handleOwnSendEcho('s1', engine, incoming('A', PHONE, own), first);
    else projector.handleInboundMessage('s1', engine, incoming('A', PHONE, own), first);
    await flush();
    const blocker = admit('blocker', 'other@c.us', true);
    expect(await blocker.reserve()).toBe(true);
    const revoke = () =>
      projector.handleMessageRevoked(
        's1',
        engine,
        {
          id: 'A',
          revokedId: 'A',
          chatId: PHONE,
        } as never,
        { fromMe: own },
      );
    if (timing === 'before-reserve') {
      revoke();
      await flush();
    }
    const later = admit('A', LID, true);
    let reservation: boolean | undefined;
    const reserved = Promise.resolve(later.reserve()).then(value => (reservation = value));
    await flush();
    if (timing === 'while-waiting') {
      revoke();
      await flush();
    }
    const beforeRelease = reservation;
    blocker.drop();
    const granted = await reserved;
    const beforeEmit = { revoked: later.revoked, state: (later as unknown as { state: string }).state };
    const message: IncomingMessage = {
      ...incoming('A', LID, own),
      body: 'later content',
      type: 'image',
      ...(granted ? { media: { mimetype: 'image/png', data: 'eA==' } } : {}),
    };
    if (own) projector.handleOwnSendEcho('s1', engine, message, later);
    else projector.handleInboundMessage('s1', engine, message, later);
    await flush();
    const row = await repository.findOneByOrFail({ waMessageId: 'A' });
    const afterEmit = (later as unknown as { state: string }).state;
    firstHook.resolve();
    await flush();
    const accepted = origin === 'reported';

    expect({ beforeRelease, granted, beforeEmit, afterEmit }).toEqual({
      beforeRelease: accepted ? false : undefined,
      granted: !accepted,
      beforeEmit: { revoked: accepted, state: 'pending' },
      afterEmit: 'emitted',
    });
    expect(row).toEqual(
      expect.objectContaining({
        chatId: LID,
        body: accepted ? '' : 'later content',
        type: accepted ? 'revoked' : 'image',
      }),
    );
    expect(dispatched.filter(message => message.chatId === LID)).toEqual(
      accepted
        ? []
        : [expect.objectContaining({ body: 'later content', media: { mimetype: 'image/png', data: 'eA==' } })],
    );
    expect((projector as unknown as { inboundInFlight: Map<string, unknown> }).inboundInFlight.size).toBe(0);
    expect((projector as unknown as { tickets: Map<string, unknown> }).tickets.size).toBe(0);
  });

  it.each(['reported', 'unknown', 'unreported'])(
    'resolves admission identity before media takes a revoke queued during the lookup, origin=%s',
    async origin => {
      await remember(origin);
      const firstHook = deferred<void>();
      const lookup = deferred<void>();
      hookAction = async data => {
        await firstHook.promise;
        return data;
      };
      const first = projector.admitInbound('s1', engine, {
        id: 'A',
        chatId: PHONE,
        fromMe: false,
        needsRoom: false,
        status: false,
      })!;
      projector.handleInboundMessage('s1', engine, incoming('A', PHONE), first);
      await flush();
      const findPhone = mappings.findPhoneForLid.bind(mappings);
      jest.spyOn(mappings, 'findPhoneForLid').mockImplementation(async jid => {
        await lookup.promise;
        return findPhone(jid);
      });
      const later = projector.admitInbound('s1', engine, {
        id: 'A',
        chatId: LID,
        fromMe: false,
        needsRoom: true,
        status: false,
      })!;
      let result: boolean | undefined;
      const reservation = Promise.resolve(later.reserve()).then(value => (result = value));
      await flush();
      const beforeLookup = result;
      projector.handleMessageRevoked('s1', engine, { id: 'A', revokedId: 'A', chatId: PHONE } as never, {
        fromMe: false,
      });
      lookup.resolve();
      const granted = await reservation;
      later.drop();
      firstHook.resolve();
      await flush();

      expect(beforeLookup).toBeUndefined();
      expect(granted).toBe(origin !== 'reported');
      expect((projector as unknown as { inboundInFlight: Map<string, unknown> }).inboundInFlight.size).toBe(0);
    },
  );

  it.each(['drop', 'retire'])(
    'releases a reservation before its directory lookup finishes after %s',
    async cancellation => {
      const firstHook = deferred<void>();
      const lookup = deferred<void>();
      hookAction = async data => {
        await firstHook.promise;
        return data;
      };
      const first = projector.admitInbound('s1', engine, {
        id: 'A',
        chatId: PHONE,
        fromMe: false,
        needsRoom: false,
        status: false,
      })!;
      projector.handleInboundMessage('s1', engine, incoming('A', PHONE), first);
      await flush();
      jest.spyOn(mappings, 'findPhoneForLid').mockImplementation(async () => {
        await lookup.promise;
        return null;
      });
      const later = projector.admitInbound('s1', engine, {
        id: 'A',
        chatId: LID,
        fromMe: false,
        needsRoom: true,
        status: false,
      })!;
      let result: boolean | undefined;
      const reservation = Promise.resolve(later.reserve()).then(value => (result = value));
      await flush();
      if (cancellation === 'retire') engines.delete('s1');
      else later.drop();
      await flush();
      const beforeLookup = result;
      lookup.resolve();
      firstHook.resolve();
      await reservation;
      await flush();

      expect(beforeLookup).toBe(false);
      expect((projector as unknown as { inboundInFlight: Map<string, unknown> }).inboundInFlight.size).toBe(0);
      expect((projector as unknown as { tickets: Map<string, unknown> }).tickets.size).toBe(0);
    },
  );

  it.each([false, true].flatMap(own => [false, true].map(admitted => [own, admitted] as const)))(
    'releases both holders when the engine retires during foreign preparation, own=%s admitted=%s',
    async (own, admitted) => {
      const firstHook = deferred<void>();
      const lookup = deferred<void>();
      hookAction = async data => {
        await firstHook.promise;
        return data;
      };
      jest.spyOn(mappings, 'findPhoneForLid').mockImplementation(async () => {
        await lookup.promise;
        return null;
      });
      const send = (chatId: string) => {
        const ticket = admitted
          ? projector.admitInbound('s1', engine, {
              id: 'A',
              chatId,
              fromMe: own,
              needsRoom: false,
              status: false,
            })
          : undefined;
        if (own) projector.handleOwnSendEcho('s1', engine, incoming('A', chatId, own), ticket);
        else projector.handleInboundMessage('s1', engine, incoming('A', chatId, own), ticket);
      };
      send(PHONE);
      await flush();
      send(LID);
      await flush();
      engines.delete('s1');
      lookup.resolve();
      firstHook.resolve();
      await flush();

      expect((projector as unknown as { inboundInFlight: Map<string, unknown> }).inboundInFlight.size).toBe(0);
      expect(await repository.count()).toBe(0);
      expect(persisted).toEqual([]);
      expect(dispatched).toEqual([]);
      expect(emitted).toEqual([]);
    },
  );

  it.each([false, true])(
    'forgets a completed quote while a repeat is still being checked, admitted=%s',
    async admitted => {
      const firstHook = deferred<void>();
      const laterRead = deferred<void>();
      const findOne = repository.findOne.bind(repository);
      let reads = 0;
      jest.spyOn(repository, 'findOne').mockImplementation(async options => {
        const row = await findOne(options);
        if ((options.where as { type?: string }).type === 'revoked' && ++reads === 2) await laterRead.promise;
        return row;
      });
      let calls = 0;
      hookAction = async data => {
        if (++calls === 1) await firstHook.promise;
        return data;
      };
      const ticket = () =>
        admitted
          ? projector.admitInbound('s1', engine, {
              id: 'A',
              chatId: PHONE,
              fromMe: false,
              needsRoom: false,
              status: false,
            })
          : undefined;
      const first = projector.handleInboundMessage(
        's1',
        engine,
        { ...incoming('A', PHONE), body: 'earlier' },
        ticket(),
      );
      await flush();
      const later = projector.handleInboundMessage('s1', engine, { ...incoming('A', PHONE), body: 'later' }, ticket());
      await flush();
      firstHook.resolve();
      await first?.settled;
      await flush();
      const whileChecking = projector.inFlightInbound('s1', 'A');
      laterRead.resolve();
      await later?.settled;
      await flush();

      expect(whileChecking).toBeUndefined();
    },
  );

  it.each([false, true])('keeps a later active quote when the earlier hook finishes, admitted=%s', async admitted => {
    const firstHook = deferred<void>();
    const laterHook = deferred<void>();
    let calls = 0;
    hookAction = async (data, accept) => {
      if (++calls === 1) {
        await firstHook.promise;
        const rewritten = { ...data, body: 'earlier rewrite' };
        accept?.(rewritten);
        return rewritten;
      }
      await laterHook.promise;
      return data;
    };
    const ticket = () =>
      admitted
        ? projector.admitInbound('s1', engine, {
            id: 'A',
            chatId: PHONE,
            fromMe: false,
            needsRoom: false,
            status: false,
          })
        : undefined;
    const first = projector.handleInboundMessage('s1', engine, { ...incoming('A', PHONE), body: 'earlier' }, ticket());
    await flush();
    const later = projector.handleInboundMessage('s1', engine, { ...incoming('A', PHONE), body: 'later' }, ticket());
    await flush();
    firstHook.resolve();
    await first?.settled;
    await flush();
    const whileLaterRuns = projector.inFlightInbound('s1', 'A');
    laterHook.resolve();
    await later?.settled;
    await flush();

    expect(whileLaterRuns).toEqual({ chatId: PHONE, body: 'later' });
  });

  it.each(['edit', 'revoke'] as const)(
    'prepares a %s arriving during the stored-row read before running the hook',
    async change => {
      await remember('reported');
      const read = deferred<void>();
      const lookup = deferred<void>();
      const findOne = repository.findOne.bind(repository);
      jest.spyOn(repository, 'findOne').mockImplementation(async options => {
        const row = await findOne(options);
        if ((options.where as { type?: string }).type === 'revoked') await read.promise;
        return row;
      });
      const findPhone = mappings.findPhoneForLid.bind(mappings);
      jest.spyOn(mappings, 'findPhoneForLid').mockImplementation(async jid => {
        await lookup.promise;
        return findPhone(jid);
      });
      deliver(incoming('A', LID));
      await flush();
      if (change === 'edit') {
        projector.applyMessageEditQueued('s1', {
          messageId: 'A',
          chatId: PHONE,
          fromMe: false,
          body: 'first',
        } as never);
        projector.applyMessageEditQueued('s1', { messageId: 'A', chatId: LID, fromMe: false, body: 'latest' } as never);
      } else {
        projector.handleMessageRevoked('s1', engine, { id: 'A', revokedId: 'A', chatId: PHONE } as never, {
          fromMe: false,
        });
      }
      read.resolve();
      await flush();
      const hooksBeforeValidation = hooked.length;
      lookup.resolve();
      await flush();

      expect(hooksBeforeValidation).toBe(0);
      expect(hooked).toEqual([
        expect.objectContaining({
          body: change === 'edit' ? 'latest' : '',
          type: change === 'edit' ? 'text' : 'revoked',
        }),
      ]);
      expect(await repository.findOneByOrFail({ waMessageId: 'A' })).toEqual(
        expect.objectContaining({
          body: change === 'edit' ? 'latest' : '',
          type: change === 'edit' ? 'text' : 'revoked',
        }),
      );
    },
  );

  it.each(
    ['unknown', 'unreported', 'reported', 'sameLid', 'distinctLid'].flatMap(origin =>
      [false, true].map(own => [origin, own] as const),
    ),
  )('scopes a stored revoke to the held %s identity, own=%s', async (origin, own) => {
    await remember(origin);
    if (origin === 'distinctLid') {
      await remember('reported');
      await mappings.remember('595959', '628111', 'peer');
    }
    const storedChat = origin === 'sameLid' ? '484848:7@hosted.lid' : origin === 'distinctLid' ? '595959@lid' : PHONE;
    await repository.insert({
      sessionId: 's1',
      waMessageId: 'A',
      chatId: storedChat,
      from: own ? SELF : storedChat,
      to: own ? storedChat : SELF,
      direction: own ? MessageDirection.OUTGOING : MessageDirection.INCOMING,
      body: 'stored content',
      type: 'text',
      timestamp: 1_700_000_000,
    });
    const ticket = projector.admitInbound('s1', engine, {
      id: 'A',
      chatId: LID,
      fromMe: own,
      needsRoom: true,
      status: false,
    })!;
    projector.handleMessageRevoked('s1', engine, { id: 'A', revokedId: 'A', chatId: storedChat } as never, {
      fromMe: own,
    });
    await flush();
    const revoked = ticket.revoked;
    const granted = await ticket.reserve();
    if (own) projector.handleOwnSendEcho('s1', engine, incoming('A', LID, own), ticket);
    else await projector.handleInboundMessage('s1', engine, incoming('A', LID, own), ticket)?.settled;
    await flush();
    const accepted = origin === 'reported' || origin === 'sameLid';
    expect({ revoked, granted, hooked: hooked.map(m => ({ body: m.body, type: m.type })) }).toEqual({
      revoked: accepted,
      granted: !accepted,
      hooked: accepted ? [] : [{ body: 'content', type: 'text' }],
    });
    expect(await repository.findOneByOrFail({ waMessageId: 'A' })).toMatchObject({
      chatId: storedChat,
      body: '',
      type: 'revoked',
    });
    expect(sent).toEqual(
      own && !accepted ? [expect.objectContaining({ chatId: LID, body: 'content', type: 'text' })] : [],
    );
    expect((projector as unknown as { inboundInFlight: Map<string, unknown> }).inboundInFlight.size).toBe(0);
  });

  it.each([false, true])('marks a new matching entry announced after the revoke row read, own=%s', async own => {
    const read = deferred<void>();
    const findOne = repository.findOne.bind(repository);
    let reading = false;
    jest.spyOn(repository, 'findOne').mockImplementation(async options => {
      if (!reading && !(options.where as { type?: string }).type) {
        reading = true;
        await read.promise;
      }
      return findOne(options);
    });
    projector.handleMessageRevoked('s1', engine, { id: 'A', revokedId: 'A', chatId: PHONE } as never, { fromMe: own });
    await flush();
    expect(reading).toBe(true);
    const ticket = projector.admitInbound('s1', engine, {
      id: 'A',
      chatId: PHONE,
      fromMe: own,
      needsRoom: true,
      status: false,
    })!;
    read.resolve();
    await flush();
    const revoked = ticket.revoked;
    if (own) projector.handleOwnSendEcho('s1', engine, incoming('A', PHONE, own), ticket);
    else await projector.handleInboundMessage('s1', engine, incoming('A', PHONE, own), ticket)?.settled;
    await flush();
    expect({ revoked, hooked, dispatched }).toEqual({ revoked: true, hooked: [], dispatched: [] });
    expect(await repository.findOneByOrFail({ waMessageId: 'A' })).toMatchObject({
      chatId: PHONE,
      body: '',
      type: 'revoked',
    });
  });

  it.each(['edit', 'reaction'] as const)('keeps foreign held content when the stored row accepts %s', async kind => {
    await repository.insert({
      sessionId: 's1',
      waMessageId: 'A',
      chatId: PHONE,
      from: PHONE,
      to: SELF,
      direction: MessageDirection.INCOMING,
      body: 'stored content',
      type: 'text',
      timestamp: 1_700_000_000,
    });
    const ticket = projector.admitInbound('s1', engine, {
      id: 'A',
      chatId: LID,
      fromMe: false,
      needsRoom: true,
      status: false,
    })!;
    if (kind === 'edit')
      projector.applyMessageEditQueued('s1', {
        messageId: 'A',
        chatId: PHONE,
        fromMe: false,
        body: 'corrected',
      } as never);
    else projector.applyReactionQueued('s1', { messageId: 'A', chatId: PHONE, senderId: PHONE, reaction: 'x' });
    await flush();
    const granted = await ticket.reserve();
    await projector.handleInboundMessage('s1', engine, incoming('A', LID), ticket)?.settled;
    await flush();
    expect({ granted, hooked: hooked.map(m => ({ body: m.body, type: m.type })) }).toEqual({
      granted: true,
      hooked: [{ body: 'content', type: 'text' }],
    });
    const row = await repository.findOneByOrFail({ waMessageId: 'A' });
    expect(row.body).toBe(kind === 'edit' ? 'corrected' : 'stored content');
    if (kind === 'reaction') expect(row.metadata).toMatchObject({ reactions: { [PHONE]: 'x' } });
  });
  it.each([false, true].flatMap(own => [false, true].map(admitted => [own, admitted] as const)))(
    'keeps an isolated tombstone cleared after a hook rewrite, own=%s admitted=%s',
    async (own, admitted) => {
      const first = deferred<void>();
      hookAction = async data => {
        if (data.chatId === PHONE) {
          await first.promise;
          return data;
        }
        return { ...data, type: 'text', body: 'rewritten content' };
      };
      const send = (message: IncomingMessage): void => {
        const ticket = admitted
          ? projector.admitInbound('s1', engine, {
              id: message.id,
              chatId: message.chatId,
              fromMe: own,
              needsRoom: false,
              status: false,
            })
          : undefined;
        if (own) projector.handleOwnSendEcho('s1', engine, message, ticket);
        else projector.handleInboundMessage('s1', engine, message, ticket);
      };
      send(incoming('A', PHONE, own));
      await flush();
      send({ ...incoming('A', LID, own), type: 'revoked', body: 'stale content' });
      await flush();
      const row = await repository.findOneByOrFail({ waMessageId: 'A' });
      const held = projector.inFlightInbound('s1', 'A');
      first.resolve();
      await flush();
      expect(held).toMatchObject({ chatId: PHONE, body: 'content' });
      expect(row).toMatchObject({ chatId: LID, type: 'revoked', body: '', metadata: null });
      expect(persisted.filter(message => message.chatId === LID)).toEqual([
        expect.objectContaining({ type: 'revoked', body: '', metadata: null }),
      ]);
      expect(dispatched.filter(message => message.chatId === LID)).toEqual([
        expect.objectContaining({ type: 'revoked', body: '' }),
      ]);
    },
  );

  it.each([false, true].flatMap(own => [false, true].map(admitted => [own, admitted] as const)))(
    'keeps a matching tombstone cleared after a hook rewrite, own=%s admitted=%s',
    async (own, admitted) => {
      hookAction = data => Promise.resolve({ ...data, type: 'text', body: 'rewritten content' });
      const message: IncomingMessage = { ...incoming('A', PHONE, own), type: 'revoked', body: 'stale content' };
      const ticket = admitted
        ? projector.admitInbound('s1', engine, {
            id: 'A',
            chatId: PHONE,
            fromMe: own,
            needsRoom: false,
            status: false,
          })
        : undefined;
      if (own) projector.handleOwnSendEcho('s1', engine, message, ticket);
      else await projector.handleInboundMessage('s1', engine, message, ticket)?.settled;
      await flush();
      expect(await repository.findOneByOrFail({ waMessageId: 'A' })).toMatchObject({
        chatId: PHONE,
        type: 'revoked',
        body: '',
        metadata: null,
      });
      expect(dispatched).toEqual([expect.objectContaining({ type: 'revoked', body: '' })]);
    },
  );

  it.each(['reported', 'unreported', 'unknown'])(
    'inherits a stored edited mark only from its identity, origin=%s',
    async origin => {
      await remember(origin);
      await repository.insert({
        sessionId: 's1',
        waMessageId: 'A',
        chatId: PHONE,
        from: SELF,
        to: PHONE,
        direction: MessageDirection.OUTGOING,
        body: 'stored content',
        type: 'text',
        timestamp: 1_700_000_000,
      });
      await projector.recordOutboundMessageEdit('s1', 'A', 'edited stored content', {
        kind: 'edit',
        chatId: PHONE,
        fromMe: true,
      });
      deliver(incoming('A', LID, true));
      await flush();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ chatId: LID, body: 'content', type: 'text' });
      expect((sent[0] as IncomingMessage & { edited?: true }).edited).toBe(origin === 'reported' ? true : undefined);
      expect(await repository.findOneByOrFail({ waMessageId: 'A' })).toMatchObject({
        chatId: PHONE,
        body: 'edited stored content',
        metadata: { edited: true },
      });
    },
  );

  it('drops a duplicate retired while waiting for its edited mark', async () => {
    await repository.insert({
      sessionId: 's1',
      waMessageId: 'A',
      chatId: PHONE,
      from: SELF,
      to: PHONE,
      direction: MessageDirection.OUTGOING,
      body: 'content',
      type: 'text',
      timestamp: 1_700_000_000,
    });
    const gate = deferred<void>();
    projector.enqueueMessageMutation('s1', 'A', () => gate.promise);
    deliver(incoming('A', PHONE, true));
    await flush();
    expect(sent).toEqual([]);
    engines.delete('s1');
    gate.resolve();
    await flush();
    expect({ sent, dispatched, emitted }).toEqual({ sent: [], dispatched: [], emitted: [] });
  });
  it.each([false, true])('runs admitted hooks with a stored tombstone cleared, own=%s', async own => {
    await tombstone(PHONE, own);
    const ticket = projector.admitInbound('s1', engine, {
      id: 'A',
      chatId: PHONE,
      fromMe: own,
      needsRoom: true,
      status: false,
    })!;
    if (own) projector.handleOwnSendEcho('s1', engine, incoming('A', PHONE, own), ticket);
    else await projector.handleInboundMessage('s1', engine, incoming('A', PHONE, own), ticket)?.settled;
    await flush();
    expect(hooked).toEqual([expect.objectContaining({ type: 'revoked', body: '' })]);
    expect(dispatched).toEqual(own ? [expect.objectContaining({ type: 'revoked', body: '' })] : []);
  });
});
