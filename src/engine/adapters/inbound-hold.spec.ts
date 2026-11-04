import { EventEmitter } from 'events';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WAState, type Message as WwebjsMessage } from 'whatsapp-web.js';
import type { Repository } from 'typeorm';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysEvents, type BaileysEventsHost } from './baileys-events';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
import { plannedInboundDownload } from './wwebjs-messaging';
import type { WwebjsLifecycle } from './wwebjs-lifecycle';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';
import { createLogger } from '../../common/services/logger.service';
import { EngineRegistry } from '../engine-registry.service';
import { MessageProjector } from '../../modules/session/message-projector.service';
import { deferred } from '../../modules/session/inbound-room';
import type { Message } from '../../modules/message/entities/message.entity';
import type { Session } from '../../modules/session/entities/session.entity';
import type { EventsGateway } from '../../modules/events/events.gateway';
import type { WebhookService } from '../../modules/webhook/webhook.service';
import type { HookManager } from '../../core/hooks';
import type { StatusStoreService } from '../../modules/status-store/status-store.service';
import type { SessionLidResolver } from '../../modules/session/session-lid-resolver.service';
import type { EngineEventCallbacks, IncomingMessage, IWhatsAppEngine } from '../interfaces/whatsapp-engine.interface';

/**
 * Both engines against the real projector, as PostgreSQL wires them: each inbound message is admitted
 * on arrival, its media is downloaded only into a slot of the session's room, held until its row is
 * written, and its chat's order and any change that reaches it before its emit are kept.
 */

type Row = Record<string, unknown>;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
};
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The real projector over a stand-in `messages` table whose inserts a test can stall per message. With
 * `unique`, an insert of an id the table already holds fails as the real table's unique index does. With
 * `sqlite`, it is wired as SQLite is: no message is admitted before its emit.
 */
function heldProjector(options: { unique?: boolean; sqlite?: boolean } = {}) {
  const rows: Row[] = [];
  const hookStarts: string[] = [];
  const hookedBodies: Record<string, string> = {};
  const stalls = new Map<string, Promise<void>>();
  const repo = {
    manager: { connection: { options: { type: options.sqlite ? 'better-sqlite3' : 'postgres' } } },
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(rows.find(r => r.waMessageId === where.waMessageId) ?? null),
    ),
    create: jest.fn((x: Row) => ({ ...x })),
    insert: jest.fn(async (row: Row) => {
      await stalls.get(String(row.waMessageId));
      if (options.unique && rows.some(r => r.waMessageId === row.waMessageId)) {
        throw Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
      }
      rows.push({ ...row });
      return { identifiers: [{ id: `pk-${String(row.waMessageId)}` }], generatedMaps: [] };
    }),
    update: jest.fn((where: Row, patch: Row) => {
      const hit = rows.filter(r => r.waMessageId === where.waMessageId);
      for (const r of hit) Object.assign(r, patch);
      return Promise.resolve({ affected: hit.length });
    }),
  };
  const hookManager = {
    execute: jest.fn((event: string, data: unknown) => {
      if (event === 'message:received' || event === 'message:sent') {
        hookStarts.push((data as IncomingMessage).id);
        hookedBodies[(data as IncomingMessage).id] = (data as IncomingMessage).body;
      }
      return Promise.resolve({ continue: true, data });
    }),
  };
  const webhookService = { dispatch: jest.fn().mockResolvedValue(undefined) };
  const ingested: string[] = [];
  const statusStore = {
    ingest: jest.fn((_s: string, status: { id: string }) => {
      ingested.push(status.id);
      return Promise.resolve({ row: status, created: false });
    }),
  };
  const gateway = new Proxy({}, { get: () => jest.fn() });
  const engines = new EngineRegistry();
  const engine = {} as IWhatsAppEngine;
  engines.set('s1', engine);
  const projector = new MessageProjector(
    repo as unknown as Repository<Message>,
    { update: jest.fn().mockResolvedValue({ affected: 1 }) } as unknown as Repository<Session>,
    engines,
    gateway as unknown as EventsGateway,
    webhookService as unknown as WebhookService,
    hookManager as unknown as HookManager,
    statusStore as unknown as StatusStoreService,
    { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
  );
  // The same table SessionEngineEventWiring builds on PostgreSQL.
  const callbacksFor = (e: IWhatsAppEngine): EngineEventCallbacks => ({
    // Only PostgreSQL holds a message from its arrival.
    ...(options.sqlite
      ? {}
      : { admitInbound: (a: Parameters<MessageProjector['admitInbound']>[2]) => projector.admitInbound('s1', e, a) }),
    onMessage: (m, t) => projector.handleInboundMessage('s1', e, m, t),
    onMessageCreate: (m, t) => projector.handleOwnSendEcho('s1', e, m, t),
    onMessageRevoked: (m, actor) => projector.handleMessageRevoked('s1', e, m, actor),
    onMessageEdited: m => projector.applyMessageEditQueued('s1', m),
    onMessageReaction: r => projector.applyReactionQueued('s1', r),
  });
  const callbacks = callbacksFor(engine);
  const stall = (id: string): (() => void) => {
    const gate = deferred<void>();
    stalls.set(id, gate.promise);
    return () => gate.resolve();
  };
  const announced = (): string[] =>
    (webhookService.dispatch.mock.calls as Array<[string, string, Row]>)
      .filter(c => c[1] === 'message.received')
      .map(c => String(c[2].id));
  const announcedAs = (event: string): Row[] =>
    (webhookService.dispatch.mock.calls as Array<[string, string, Row]>).filter(c => c[1] === event).map(c => c[2]);
  return {
    projector,
    rows,
    hookStarts,
    hookedBodies,
    callbacks,
    callbacksFor,
    engines,
    stall,
    announced,
    announcedAs,
    ingested,
    inserted: () => rows.map(r => r.waMessageId),
  };
}

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe('Baileys inbound messages held for storage', () => {
  const downloadMediaMessage = jest.fn();
  const unwrap = (content: Row | null | undefined): Row | undefined => {
    let current = content ?? undefined;
    for (let i = 0; i < 5 && current; i++) {
      const inner = (current.ephemeralMessage ?? current.viewOnceMessage ?? current.documentWithCaptionMessage) as
        { message?: Row } | undefined;
      if (!inner) break;
      current = inner.message;
    }
    return current;
  };
  const lib = {
    normalizeMessageContent: unwrap,
    extractMessageContent: unwrap,
    getContentType: (content: Row | undefined) =>
      Object.keys(content ?? {}).find(k => k === 'conversation' || k.endsWith('Message')),
    downloadMediaMessage,
    proto: { Message: { ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
    BufferJSON: { replacer: (_k: string, v: unknown) => v, reviver: (_k: string, v: unknown) => v },
  } as unknown as Awaited<ReturnType<BaileysEventsHost['loadLib']>>;

  const stream = (bytes = 3) => ({
    // eslint-disable-next-line @typescript-eslint/require-await
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(bytes, 1);
    },
    destroy: jest.fn(),
  });

  /** The adapter's message store, in memory: what the host reads, writes and deletes copies through. */
  const memoryStore = () => {
    const copies = new Map<string, WAMessage>();
    return {
      copies,
      getStoredMessage: (id: string) => Promise.resolve(structuredClone(copies.get(id) ?? null)),
      putStoredMessage: (msg: WAMessage) => {
        copies.set(msg.key.id!, structuredClone(msg));
        return Promise.resolve();
      },
      updateStoredMessage: (id: string, change: (stored: WAMessage) => WAMessage | null) => {
        const held = copies.get(id);
        const next = held && change(structuredClone(held));
        if (next) copies.set(id, next);
        return Promise.resolve();
      },
      removeStoredMessage: (id: string, accept: (stored: WAMessage) => boolean) => {
        const held = copies.get(id);
        if (held && accept(structuredClone(held))) copies.delete(id);
        return Promise.resolve();
      },
    };
  };

  const build = (concurrency: number, callbacks?: EngineEventCallbacks, store?: ReturnType<typeof memoryStore>) => {
    const emitted: string[] = [];
    const recordKeyLidMappings = jest.fn();
    const host = {
      getSocket: () => ({ updateMediaMessage: jest.fn() }) as unknown as WASocket,
      getSocketOrNull: () => null,
      logger: createLogger('InboundHoldSpec'),
      loadLib: () => Promise.resolve(lib),
      getLoadedLib: () => lib,
      getFetchDispatcher: () => undefined,
      toNeutralJid: (jid: string) => jid,
      normalizedSelfJid: () => 'me@s.whatsapp.net',
      inboundLimiter: new ConcurrencyLimiter(concurrency),
      recordKeyLidMappings,
      recordMessage: () => undefined,
      recordMessageEdit: () => undefined,
      consumeOwnSend: () => false,
      getStoredMessage: () => undefined,
      putStoredMessage: () => undefined,
      updateStoredMessage: () => undefined,
      getAdmitInbound: () => callbacks?.admitInbound,
      getOnMessage: () => (m: IncomingMessage, t?: never) => {
        emitted.push(m.id);
        return callbacks?.onMessage?.(m, t);
      },
      getOnMessageCreate: () => callbacks?.onMessageCreate,
      getOnMessageRevoked: () => callbacks?.onMessageRevoked,
      getOnMessageEdited: () => callbacks?.onMessageEdited,
      getOnMessageReaction: () => callbacks?.onMessageReaction,
      getOnMessageAck: () => undefined,
      getOnGroupEvent: () => undefined,
      getOnCall: () => undefined,
      getOnPresenceUpdate: () => undefined,
      getOnCallOutcome: () => undefined,
      ...store,
    } as unknown as BaileysEventsHost;
    return { events: new BaileysEvents(host), emitted, recordKeyLidMappings, limiter: host.inboundLimiter };
  };

  const media = (id: string, chat: string, over: Row = {}): WAMessage => ({
    key: { id, remoteJid: chat, fromMe: false },
    messageTimestamp: 1_700_000_000,
    message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 3, ...over } },
  });
  const text = (id: string, chat: string): WAMessage => ({
    key: { id, remoteJid: chat, fromMe: false },
    messageTimestamp: 1_700_000_000,
    message: { conversation: `text ${id}` },
  });
  const upsert = (events: BaileysEvents, ...messages: WAMessage[]) =>
    events.handleMessagesUpsert({ messages, type: 'notify' });

  beforeEach(() => {
    downloadMediaMessage.mockReset();
    downloadMediaMessage.mockImplementation(() => Promise.resolve(stream()));
  });

  describe.each([1, 4])('at INBOUND_MEDIA_CONCURRENCY=%i', k => {
    beforeEach(() => {
      process.env.INBOUND_MEDIA_CONCURRENCY = String(k);
    });

    // K payloads stored in K chats whose inserts stall: the room is full and stays full.
    const fillRoom = async (h: ReturnType<typeof heldProjector>, events: BaileysEvents) => {
      const holders = Array.from({ length: k }, (_, i) => `H${i}`);
      const releases = holders.map(id => h.stall(id));
      upsert(events, ...holders.map((id, i) => media(id, `hold${i}@s.whatsapp.net`)));
      await flush();
      expect(downloadMediaMessage).toHaveBeenCalledTimes(k);
      return () => releases.forEach(release => release());
    };

    it('lets another chat text through while media waits for room, its limiter slot given up', async () => {
      const h = heldProjector();
      const { events, emitted } = build(k, h.callbacks);
      const release = await fillRoom(h, events);

      // K media waiting for room would hold every limiter slot if they did not give theirs up.
      upsert(events, ...Array.from({ length: k }, (_, i) => media(`W${i}`, `wait${i}@s.whatsapp.net`)));
      upsert(events, text('T', 'other@s.whatsapp.net'));
      await flush();

      expect(emitted).toContain('T');
      expect(h.inserted()).toEqual(['T']);
      expect(downloadMediaMessage).toHaveBeenCalledTimes(k);

      // Room frees: the media that waited is stored here, not by its wait timer after the file is done.
      release();
      await flush();
      expect(h.inserted()).toEqual(expect.arrayContaining(Array.from({ length: k }, (_, i) => `W${i}`)));
    });

    it('commits a same-chat text after the media it arrived behind', async () => {
      const h = heldProjector();
      const { events, emitted } = build(k, h.callbacks);
      const release = await fillRoom(h, events);
      upsert(events, media('M', 'chat@s.whatsapp.net'), text('T', 'chat@s.whatsapp.net'));
      await flush();
      // The text is processed meanwhile, but its hook and row wait for the media.
      expect(emitted).toContain('T');
      expect(h.hookStarts).not.toContain('T');

      release();
      await flush();
      const order = h.inserted().filter(id => id === 'M' || id === 'T');
      expect(order).toEqual(['M', 'T']);
      expect(h.hookStarts.indexOf('M')).toBeLessThan(h.hookStarts.indexOf('T'));
    });

    it('emits the omitted marker without downloading when no room comes free in time', async () => {
      process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '20';
      const h = heldProjector();
      const seen: IncomingMessage[] = [];
      const onMessage = h.callbacks.onMessage!;
      const { events } = build(k, { ...h.callbacks, onMessage: (m, t) => (seen.push(m), onMessage(m, t)) });
      await fillRoom(h, events);
      upsert(events, media('LATE', 'late@s.whatsapp.net', { fileLength: 7 }));
      await sleep(80);
      await flush();

      expect(downloadMediaMessage).toHaveBeenCalledTimes(k);
      expect(seen.find(m => m.id === 'LATE')?.media).toEqual(expect.objectContaining({ omitted: true, sizeBytes: 7 }));
      expect(h.inserted()).toContain('LATE');
    });
  });

  it("keeps the room of a retired engine's download until it settles, so a replacement engine's media waits", async () => {
    process.env.INBOUND_MEDIA_CONCURRENCY = '1';
    const h = heldProjector();
    const old = build(1, h.callbacks);
    const pending = deferred<ReturnType<typeof stream>>();
    downloadMediaMessage.mockImplementationOnce(() => pending.promise);
    upsert(old.events, media('A', 'a@s.whatsapp.net'));
    await flush();
    expect(downloadMediaMessage).toHaveBeenCalledTimes(1);

    // Retiring the engine drops its pending turn, so only the hold on the processing keeps the slot.
    const fresh = {} as IWhatsAppEngine;
    h.engines.set('s1', fresh);
    const next = build(1, h.callbacksFor(fresh));
    upsert(next.events, media('B', 'b@s.whatsapp.net'));
    await flush();
    expect(downloadMediaMessage).toHaveBeenCalledTimes(1);

    pending.resolve(stream());
    await flush();
    expect(downloadMediaMessage).toHaveBeenCalledTimes(2);
    expect(h.inserted()).toEqual(['B']);
  });

  it('downloads nothing for media granted room but deleted for everyone before its download starts', async () => {
    // Room for both; the limiter has one slot, so GONE is granted room at arrival but queued behind H.
    process.env.INBOUND_MEDIA_CONCURRENCY = '2';
    const h = heldProjector();
    const { events } = build(1, h.callbacks);
    const pending = deferred<ReturnType<typeof stream>>();
    downloadMediaMessage.mockImplementationOnce(() => pending.promise);
    upsert(events, media('H', 'hold@s.whatsapp.net'), media('GONE', 'chat@s.whatsapp.net'));
    await flush();
    // The delete is applied outside the limiter, which GONE still waits in (a delete delivered through
    // the same limiter would queue behind it).
    h.callbacks.onMessageRevoked!({
      id: 'GONE',
      revokedId: 'GONE',
      chatId: 'chat@s.whatsapp.net',
      from: 'chat@s.whatsapp.net',
      to: 'me@s.whatsapp.net',
      type: 'revoked',
      body: '',
      timestamp: 1_700_000_001,
    });
    await flush();
    expect(downloadMediaMessage).toHaveBeenCalledTimes(1);

    pending.resolve(stream());
    await flush();

    expect(downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(h.inserted().sort()).toEqual(['GONE', 'H']);
    expect(h.rows.find(r => r.waMessageId === 'GONE')).toEqual(expect.objectContaining({ body: '', type: 'revoked' }));
    expect(h.announced()).toEqual(['H']);
  });

  it('stores a message deleted for everyone while it downloaded cleared, unannounced, and gives its slot back', async () => {
    // One slot of room; the limiter has spare slots, so the delete is processed during the download.
    process.env.INBOUND_MEDIA_CONCURRENCY = '1';
    const h = heldProjector();
    const { events, emitted } = build(4, h.callbacks);
    const pending = deferred<ReturnType<typeof stream>>();
    downloadMediaMessage.mockImplementationOnce(() => pending.promise);
    upsert(events, media('GONE', 'chat@s.whatsapp.net'), media('NEXT', 'next@s.whatsapp.net'));
    await flush();
    upsert(events, {
      key: { id: 'REV', remoteJid: 'chat@s.whatsapp.net', fromMe: false },
      messageTimestamp: 1_700_000_001,
      message: { protocolMessage: { type: 0, key: { id: 'GONE', remoteJid: 'chat@s.whatsapp.net', fromMe: false } } },
    });
    await flush();
    expect(downloadMediaMessage).toHaveBeenCalledTimes(1);

    pending.resolve(stream());
    await flush();

    // As on whatsapp-web.js: the row is kept, cleared, and only what was not taken back is announced.
    expect(emitted).toEqual(['GONE', 'NEXT']);
    expect(downloadMediaMessage).toHaveBeenCalledTimes(2);
    expect(h.inserted()).toEqual(['GONE', 'NEXT']);
    expect(h.rows[0]).toEqual(expect.objectContaining({ body: '', type: 'revoked' }));
    expect(h.announced()).toEqual(['NEXT']);
  });

  it('downloads nothing for media deleted for everyone while it waits for room, and stores it cleared', async () => {
    process.env.INBOUND_MEDIA_CONCURRENCY = '1';
    const h = heldProjector();
    const { events } = build(4, h.callbacks);
    const release = h.stall('H');
    upsert(events, media('H', 'hold@s.whatsapp.net'), media('GONE', 'chat@s.whatsapp.net'));
    await flush();
    expect(downloadMediaMessage).toHaveBeenCalledTimes(1);
    upsert(events, {
      key: { id: 'REV', remoteJid: 'chat@s.whatsapp.net', fromMe: false },
      messageTimestamp: 1_700_000_001,
      message: { protocolMessage: { type: 0, key: { id: 'GONE', remoteJid: 'chat@s.whatsapp.net', fromMe: false } } },
    });
    await flush();

    expect(downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(h.rows).toEqual([expect.objectContaining({ waMessageId: 'GONE', body: '', type: 'revoked' })]);
    expect(h.announced()).toEqual([]);
    release();
    await flush();
    expect(h.inserted()).toEqual(['GONE', 'H']);
  });

  it.each([
    ['from another chat', { remoteJid: '628222@s.whatsapp.net', fromMe: false }],
    ['from the wrong author', { remoteJid: '628111@s.whatsapp.net', fromMe: true }],
  ])('ignores a delete and an edit %s aimed at media waiting for room', async (_, envelope) => {
    process.env.INBOUND_MEDIA_CONCURRENCY = '1';
    const h = heldProjector();
    const { events } = build(4, h.callbacks);
    const release = h.stall('H');
    upsert(
      events,
      media('H', 'hold@s.whatsapp.net'),
      media('MREV', '628111@s.whatsapp.net', { caption: 'real caption' }),
      media('MEDIT', '628111@s.whatsapp.net', { caption: 'real caption 2' }),
    );
    await flush();
    const target = (id: string) => ({ id, remoteJid: envelope.remoteJid, fromMe: false });
    upsert(
      events,
      {
        key: { id: 'REV', ...envelope },
        messageTimestamp: 1_700_000_001,
        message: { protocolMessage: { type: 0, key: target('MREV') } },
      },
      {
        key: { id: 'ED', ...envelope },
        messageTimestamp: 1_700_000_001,
        message: { protocolMessage: { type: 14, key: target('MEDIT'), editedMessage: { conversation: 'forged' } } },
      },
    );
    await flush();
    release();
    await flush();

    const row = (id: string) => h.rows.find(r => r.waMessageId === id);
    expect(row('MREV')).toEqual(expect.objectContaining({ body: 'real caption', type: 'image' }));
    expect(row('MEDIT')).toEqual(expect.objectContaining({ body: 'real caption 2' }));
    expect(h.hookedBodies.MEDIT).toBe('real caption 2');
    expect([...h.announced()].sort()).toEqual(['H', 'MEDIT', 'MREV']);
    expect(downloadMediaMessage).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['waiting for room (PostgreSQL)', true],
    ['still downloading (SQLite)', false],
  ])('drops a reaction from another chat aimed at media %s', async (_, admitted) => {
    process.env.INBOUND_MEDIA_CONCURRENCY = '1';
    const h = heldProjector();
    const reactions: Array<{ messageId: string; chatId: string }> = [];
    const onMessageReaction: EngineEventCallbacks['onMessageReaction'] = r => reactions.push(r);
    const download = deferred<void>();
    let release: () => void;
    let callbacks: EngineEventCallbacks;
    if (admitted) {
      // The session judges what the engine hands it, as it does in production.
      release = h.stall('H');
      callbacks = h.callbacks;
    } else {
      // No admission callback, as SQLite wires the engine: M is held only by its own download.
      release = () => download.resolve();
      downloadMediaMessage.mockImplementation(() => download.promise.then(() => stream()));
      callbacks = { onMessage: jest.fn(), onMessageReaction };
    }
    const { events } = build(4, callbacks);
    const chat = '628111@s.whatsapp.net';
    upsert(events, ...(admitted ? [media('H', 'hold@s.whatsapp.net')] : []), media('M', chat));
    await flush();
    const react = (id: string, remoteJid: string, text: string): WAMessage => ({
      key: { id, remoteJid, fromMe: false },
      messageTimestamp: 1_700_000_001,
      message: { reactionMessage: { key: { id: 'M', remoteJid, fromMe: false }, text } },
    });
    upsert(events, react('R1', '628222@s.whatsapp.net', 'forged'), react('R2', chat, 'genuine'));
    await flush();
    release();
    await flush();

    const reached = admitted ? h.announcedAs('message.reaction') : reactions;
    expect(reached).toEqual([expect.objectContaining({ messageId: 'M', chatId: chat, reaction: 'genuine' })]);
  });

  it('neither ingests nor emits a status post deleted while it waits for room', async () => {
    process.env.INBOUND_MEDIA_CONCURRENCY = '1';
    const h = heldProjector();
    const { events, emitted } = build(4, h.callbacks);
    const release = h.stall('H');
    const poster = { remoteJid: 'status@broadcast', participant: '628111@s.whatsapp.net', fromMe: false };
    upsert(events, media('H', 'hold@s.whatsapp.net'), {
      key: { id: 'ST', ...poster },
      messageTimestamp: 1_700_000_000,
      message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 3, caption: 'secret' } },
    });
    await flush();
    // The projector keeps no in-flight entry for a status post, so it never sees this revoke.
    upsert(events, {
      key: { id: 'REV', ...poster },
      messageTimestamp: 1_700_000_001,
      message: { protocolMessage: { type: 0, key: { id: 'ST', ...poster } } },
    });
    await flush();
    release();
    await flush();

    expect(emitted).toEqual(['H']);
    expect(h.ingested).toEqual([]);
  });

  it('neither emits nor stores a held message a history revoke deleted', async () => {
    process.env.INBOUND_MEDIA_CONCURRENCY = '1';
    const h = heldProjector();
    const { events, emitted } = build(4, h.callbacks);
    const release = h.stall('H');
    const chat = 'chat@s.whatsapp.net';
    upsert(events, media('H', 'hold@s.whatsapp.net'), media('GONE', chat));
    await flush();
    await events.applyHistoryRevoke({ id: 'GONE', remoteJid: chat, fromMe: false }, { remoteJid: chat, fromMe: false });
    release();
    await flush();

    expect(emitted).toEqual(['H']);
    expect(h.hookStarts).toEqual(['H']);
    expect(h.inserted()).toEqual(['H']);
    expect(h.announced()).toEqual(['H']);
  });

  // An id names one message of one chat. The table refuses a delivery that reuses the id of a message it
  // holds under another chat, and a delete from the reusing chat is the delete of that delivery, never of
  // the stored message: its row keeps its content, and nothing announces it as deleted.
  describe.each([
    ['PostgreSQL', false],
    ['SQLite', true],
  ])('a delivery that reuses the id of a stored message of another chat, deleted by its sender on %s', (_, sqlite) => {
    const CHAT_A = '628111@s.whatsapp.net';
    const CHAT_B = '628222@s.whatsapp.net';
    const real = (): Row => ({
      sessionId: 's1',
      waMessageId: 'X',
      chatId: CHAT_A,
      direction: 'incoming',
      type: 'text',
      body: 'the real one',
      metadata: null,
    });
    const revokeFrom = (chat: string): WAMessage => ({
      key: { id: 'REV', remoteJid: chat, fromMe: false },
      messageTimestamp: 1_700_000_001,
      message: { protocolMessage: { type: 0, key: { id: 'X', remoteJid: chat, fromMe: false } } },
    });

    it.each([
      ['text', (): WAMessage => text('X', CHAT_B)],
      ['media', (): WAMessage => media('X', CHAT_B)],
    ])('leaves the stored message alone when the delivery is %s', async (_kind, reuse) => {
      process.env.INBOUND_MEDIA_CONCURRENCY = '1';
      const h = heldProjector({ unique: true, sqlite });
      h.rows.push(real());
      const download = deferred<ReturnType<typeof stream>>();
      downloadMediaMessage.mockImplementationOnce(() => download.promise);
      const { events } = build(4, h.callbacks);
      upsert(events, reuse(), revokeFrom(CHAT_B));
      await flush();
      download.resolve(stream());
      await flush();

      expect(h.rows).toEqual([real()]);
      expect(h.announcedAs('message.revoked')).toEqual([]);
      expect(h.announced()).toEqual([]);
    });

    // The delivery's row waits for an earlier message of its chat: on SQLite as well, it is in flight
    // from its emit until that commit ends, and a delete from its chat reaches it there.
    it('leaves the stored message alone when the delivery waits for an earlier message of its chat', async () => {
      const h = heldProjector({ unique: true, sqlite });
      h.rows.push(real());
      const release = h.stall('EARLIER');
      const { events } = build(4, h.callbacks);
      upsert(events, text('EARLIER', CHAT_B), text('X', CHAT_B));
      await flush();
      upsert(events, revokeFrom(CHAT_B));
      await flush();
      release();
      await flush();

      expect(h.rows.find(r => r.waMessageId === 'X')).toEqual(real());
      expect(h.inserted()).toEqual(['X', 'EARLIER']);
      expect(h.announcedAs('message.revoked')).toEqual([]);
      expect(h.announced()).toEqual(['EARLIER']);
    });

    it('still takes a later edit from the real message chat', async () => {
      const h = heldProjector({ unique: true, sqlite });
      h.rows.push(real());
      const { events } = build(4, h.callbacks);
      upsert(events, text('X', CHAT_B), revokeFrom(CHAT_B));
      await flush();
      upsert(events, {
        key: { id: 'ENV', remoteJid: CHAT_A, fromMe: false },
        messageTimestamp: 1_700_000_002,
        message: {
          protocolMessage: {
            type: 14,
            key: { id: 'X', remoteJid: CHAT_A, fromMe: false },
            editedMessage: { conversation: 'fixed' },
            timestampMs: 1_700_000_002_000,
          },
        },
      });
      await flush();

      expect(h.rows).toEqual([{ ...real(), body: 'fixed', metadata: { edited: true } }]);
    });
  });

  // The session holds a change that reaches a message before its emit to the rule of the row it will
  // become, which needs the direction and the sender from the arrival on.
  it('names whose message it is in the arrival, and the sender behind a group message', async () => {
    const h = heldProjector();
    const admitInbound = jest.fn(h.callbacks.admitInbound);
    const { events } = build(4, { ...h.callbacks, admitInbound });
    const own = { ...text('B', 'c@s.whatsapp.net'), key: { id: 'B', remoteJid: 'c@s.whatsapp.net', fromMe: true } };
    const member = {
      ...text('C', '120363000000000001@g.us'),
      key: { id: 'C', remoteJid: '120363000000000001@g.us', fromMe: false, participant: 'm@s.whatsapp.net' },
    };
    upsert(events, text('A', 'c@s.whatsapp.net'), own, member);
    await flush();

    expect(admitInbound.mock.calls.map(([a]) => [a.id, a.fromMe, a.author])).toEqual([
      ['A', false, undefined],
      ['B', true, undefined],
      ['C', false, 'm@s.whatsapp.net'],
    ]);
  });

  it('names the sender behind a broadcast-list or status message too, and none behind a one-to-one chat', async () => {
    const h = heldProjector();
    const admitInbound = jest.fn(h.callbacks.admitInbound);
    const { events } = build(4, { ...h.callbacks, admitInbound });
    const key = (id: string, remoteJid: string, fromMe: boolean, participant?: string) => ({
      ...text(id, remoteJid),
      key: { id, remoteJid, fromMe, ...(participant ? { participant } : {}) },
    });
    upsert(
      events,
      key('L', '1700000002@broadcast', false, 'p@s.whatsapp.net'),
      key('S', 'status@broadcast', false, 's@s.whatsapp.net'),
      key('M', 'c@s.whatsapp.net', false, 'x@s.whatsapp.net'),
    );
    await flush();

    expect(admitInbound.mock.calls.map(([a]) => [a.id, a.author])).toEqual([
      ['L', 'p@s.whatsapp.net'],
      ['S', 's@s.whatsapp.net'],
      ['M', undefined],
    ]);
  });

  it('still processes a message, and the rest of its batch, when its admission throws', async () => {
    const h = heldProjector();
    let calls = 0;
    const admitInbound: EngineEventCallbacks['admitInbound'] = a => {
      if (++calls === 1) throw new Error('boom');
      return h.callbacks.admitInbound!(a);
    };
    const seen: IncomingMessage[] = [];
    const onMessage = h.callbacks.onMessage!;
    const { events } = build(4, { ...h.callbacks, admitInbound, onMessage: (m, t) => (seen.push(m), onMessage(m, t)) });
    upsert(events, media('A', 'a@s.whatsapp.net', { fileLength: 7 }), text('B', 'b@s.whatsapp.net'));
    await flush();

    // No room was reserved for it, so its media is not downloaded.
    expect(seen.find(m => m.id === 'A')?.media).toEqual(expect.objectContaining({ omitted: true, sizeBytes: 7 }));
    expect(downloadMediaMessage).not.toHaveBeenCalled();
    expect(h.inserted().sort()).toEqual(['A', 'B']);
  });

  it.each([
    ['an image', media('A', 'c@s.whatsapp.net'), true],
    [
      'a disappearing image',
      {
        ...media('A', 'c@s.whatsapp.net'),
        message: { ephemeralMessage: { message: { imageMessage: { fileLength: 3 } } } },
      },
      true,
    ],
    [
      'a view-once image',
      {
        ...media('A', 'c@s.whatsapp.net'),
        message: { viewOnceMessage: { message: { imageMessage: { fileLength: 3 } } } },
      },
      true,
    ],
    ['media declared over the cap', media('A', 'c@s.whatsapp.net', { fileLength: 60 * 1024 * 1024 }), false],
    [
      'the account own status post',
      { ...media('A', 'status@broadcast'), key: { id: 'A', remoteJid: 'status@broadcast', fromMe: true } },
      false,
    ],
    ['a protocol message', { ...text('A', 'c@s.whatsapp.net'), message: { protocolMessage: { type: 5 } } }, false],
    [
      'a reaction',
      { ...text('A', 'c@s.whatsapp.net'), message: { reactionMessage: { key: { id: 'X' }, text: 'ok' } } },
      false,
    ],
    ['a text', text('A', 'c@s.whatsapp.net'), false],
  ] as Array<[string, WAMessage, boolean]>)(
    'plans a download for %s exactly when processing downloads it',
    async (_, msg, planned) => {
      const { events } = build(4);
      expect(events.plannedMediaDownload(lib, msg)).toBe(planned);
      upsert(events, msg);
      await flush();
      expect(downloadMediaMessage).toHaveBeenCalledTimes(planned ? 1 : 0);
    },
  );

  it('plans no download, and downloads nothing, with media downloads disabled', async () => {
    process.env.MEDIA_DOWNLOAD_ENABLED = 'false';
    const { events } = build(4);
    const msg = media('A', 'c@s.whatsapp.net');
    expect(events.plannedMediaDownload(lib, msg)).toBe(false);
    upsert(events, msg);
    await flush();
    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });

  it('records the key lid pairs once per message, with or without a ticket', async () => {
    const h = heldProjector();
    const held = build(4, h.callbacks);
    upsert(held.events, text('A', 'c@s.whatsapp.net'));
    const plain = build(4);
    upsert(plain.events, text('B', 'c@s.whatsapp.net'));
    await flush();
    expect(held.recordKeyLidMappings).toHaveBeenCalledTimes(1);
    expect(plain.recordKeyLidMappings).toHaveBeenCalledTimes(1);
  });

  // A message the table holds from history is not in the adapter's store, so a delivery that reuses its id
  // from another chat is stored there under its own key before the table refuses its row.
  describe('a delivery that reuses the id of a message the table holds', () => {
    const CHAT_A = '628111@s.whatsapp.net';
    const CHAT_B = '628222@s.whatsapp.net';
    const seeded = (): Row => ({ waMessageId: 'X', chatId: CHAT_A, direction: 'incoming', body: 'the real one' });
    /** An edit of X sent from `chat`, under an envelope id of its own. */
    const editFrom = (chat: string, envelopeId: string, body: string): WAMessage => ({
      key: { id: envelopeId, remoteJid: chat, fromMe: false },
      messageTimestamp: 1_700_000_002,
      message: {
        protocolMessage: {
          type: 14,
          key: { id: 'X', remoteJid: chat, fromMe: false },
          editedMessage: { conversation: body },
          timestampMs: 1_700_000_002_000,
        },
      },
    });
    const realEdit = (): WAMessage => editFrom(CHAT_A, 'EDIT_ENV', 'fixed');

    it('removes the copy it stored, so the real message edit lands on the row', async () => {
      const h = heldProjector({ unique: true });
      h.rows.push(seeded());
      const store = memoryStore();
      const { events } = build(4, h.callbacks, store);

      upsert(events, text('X', CHAT_B));
      await flush();

      // The row is not touched and nothing is announced; the copy that stood in for it is gone.
      expect(h.rows).toEqual([seeded()]);
      expect(h.announced()).toEqual([]);
      expect(store.copies.has('X')).toBe(false);

      upsert(events, realEdit());
      await flush();
      expect(h.rows[0]).toEqual(expect.objectContaining({ body: 'fixed' }));
    });

    it('keeps the copy of a re-fire of the message the table holds', async () => {
      const h = heldProjector({ unique: true });
      h.rows.push({ ...seeded(), chatId: CHAT_B });
      const store = memoryStore();
      const { events } = build(4, h.callbacks, store);

      upsert(events, text('X', CHAT_B));
      await flush();

      expect(store.copies.get('X')?.key.remoteJid).toBe(CHAT_B);
      expect(h.announced()).toEqual([]);
    });

    it('holds the real edit while the repeat is held, and lands it once the copy is refused', async () => {
      const h = heldProjector({ unique: true });
      h.rows.push(seeded());
      const release = h.stall('X');
      const store = memoryStore();
      const { events } = build(4, h.callbacks, store);

      upsert(events, text('X', CHAT_B));
      await flush();
      expect(store.copies.get('X')?.key.remoteJid).toBe(CHAT_B);

      // Judged against the copy alone it would be foreign, and lost with the copy's removal still to come.
      upsert(events, realEdit());
      await flush();
      expect(h.rows).toEqual([seeded()]);
      expect(h.announcedAs('message.edited')).toEqual([]);
      expect(store.copies.has('X')).toBe(true);

      release();
      await flush();
      expect(store.copies.has('X')).toBe(false);
      expect(h.rows).toEqual([expect.objectContaining({ chatId: CHAT_A, body: 'fixed' })]);
    });

    it('still drops an edit from a third chat, before and after the session answers', async () => {
      const h = heldProjector({ unique: true });
      h.rows.push(seeded());
      const release = h.stall('X');
      const { events } = build(4, h.callbacks, memoryStore());

      upsert(events, text('X', CHAT_B));
      await flush();
      upsert(events, editFrom('628333@s.whatsapp.net', 'FORGED_1', 'forged'));
      await flush();
      release();
      await flush();
      upsert(events, editFrom('628333@s.whatsapp.net', 'FORGED_2', 'forged again'));
      await flush();

      expect(h.rows).toEqual([seeded()]);
    });

    // The copy the change was judged foreign to is gone when the hold ends, wiped with the account or not
    // readable, and no conflict removed it: the key it was judged by stands, as it does for a delivery in flight.
    it('drops a change judged foreign to a copy that is gone when the hold ends, and was not removed as a conflict', async () => {
      const h = heldProjector({ unique: true });
      const release = h.stall('X');
      const store = memoryStore();
      const onMessageEdited = jest.fn(h.callbacks.onMessageEdited);
      const { events } = build(4, { ...h.callbacks, onMessageEdited }, store);

      upsert(events, text('X', CHAT_B));
      await flush();
      expect(store.copies.get('X')?.key.remoteJid).toBe(CHAT_B);
      upsert(events, editFrom('628333@s.whatsapp.net', 'FORGED_ENV', 'forged'));
      await flush();
      expect(onMessageEdited).not.toHaveBeenCalled();

      store.copies.clear();
      release();
      await flush();

      expect(onMessageEdited).not.toHaveBeenCalled();
      expect(h.rows).toEqual([expect.objectContaining({ waMessageId: 'X', chatId: CHAT_B })]);
    });

    // The delivery is not stored, and the session has no receipt for it, until its processing is over (the
    // limiter queue, the repeat check, a download). A change that arrives meanwhile is judged against the key
    // the delivery arrived under, which cannot say which message the id names.
    describe('while the delivery is still being processed', () => {
      type Kind = 'edit' | 'delete' | 'reaction';
      const CHAT_C = '628333@s.whatsapp.net';

      /**
       * A store whose reads of X wait until released, counted from 1 in the order they are made. Each answers
       * what the store held when it began; the first is the delivery's repeat check.
       */
      const holdingReads = (held: number[]) => {
        const store = memoryStore();
        const read = store.getStoredMessage;
        const gates = new Map<number, ReturnType<typeof deferred<void>>>();
        for (const n of held) gates.set(n, deferred<void>());
        let reads = 0;
        store.getStoredMessage = async (id: string) => {
          if (id !== 'X') return read(id);
          const n = ++reads;
          const seen = await read(id);
          await gates.get(n)?.promise;
          return seen;
        };
        return { store, open: (n: number) => gates.get(n)!.resolve() };
      };

      const change = (kind: Kind, chat: string, envelopeId: string): WAMessage => {
        if (kind === 'edit') return editFrom(chat, envelopeId, 'fixed');
        const target = { id: 'X', remoteJid: chat, fromMe: false };
        return {
          key: { id: envelopeId, remoteJid: chat, fromMe: false },
          messageTimestamp: 1_700_000_002,
          message:
            kind === 'delete'
              ? { protocolMessage: { type: 0, key: target } }
              : { reactionMessage: { key: target, text: 'ok' } },
        };
      };

      /** What the change has done to the session: the stored body, the stored type, or the reactions announced. */
      const effect = (h: ReturnType<typeof heldProjector>, kind: Kind): unknown => {
        const row = h.rows.find(r => r.waMessageId === 'X');
        if (kind === 'edit') return row?.body;
        if (kind === 'delete') return row?.type;
        return h.announcedAs('message.reaction').map(r => r.messageId);
      };

      /** The seeded row says 'the real one' and has no type; a delivery that is the message stores 'text X'. */
      const untouched = (kind: Kind, seededRow: boolean): unknown => {
        if (kind === 'reaction') return [];
        if (kind === 'edit') return seededRow ? 'the real one' : 'text X';
        return seededRow ? undefined : 'text';
      };
      const landed: Record<Kind, unknown> = { edit: 'fixed', delete: 'revoked', reaction: ['X'] };
      const kinds = ['edit', 'delete', 'reaction'] as const;

      describe.each([
        ['PostgreSQL', false],
        ['SQLite', true],
      ])('on %s', (_, sqlite) => {
        it.each(kinds.flatMap(kind => [true, false].map(stall => [kind, stall] as const)))(
          'lands the real %s once the delivery is refused (answer held: %s)',
          async (kind, stall) => {
            const h = heldProjector({ unique: true, sqlite });
            h.rows.push(seeded());
            const release = stall ? h.stall('X') : undefined;
            const { store, open } = holdingReads([1]);
            const { events } = build(4, h.callbacks, store);

            upsert(events, text('X', CHAT_B));
            await flush();
            upsert(events, change(kind, CHAT_A, 'REAL_ENV'));
            await flush();
            expect(effect(h, kind)).toEqual(untouched(kind, true));

            open(1);
            await flush();
            release?.();
            await flush();

            expect(effect(h, kind)).toEqual(landed[kind]);
            expect(store.copies.has('X')).toBe(false);
            expect(h.announced()).toEqual([]);
          },
        );

        // The delivery's answer is pending when the change is judged, so the adapter holds it: it does nothing
        // for it until the answer, when it drops it, or, with the copy gone, leaves it to the session, which
        // drops it by the row.
        it.each(kinds.flatMap(kind => [true, false].map(conflicts => [kind, conflicts] as const)))(
          'holds a forged %s from a third chat until the delivery is answered, then drops it (delivery conflicts: %s)',
          async (kind, conflicts) => {
            const h = heldProjector({ unique: true, sqlite });
            // Without a row of another message, the delivery is the message the id names.
            if (conflicts) h.rows.push(seeded());
            const release = h.stall('X');
            const { store, open } = holdingReads([1]);
            const handedOn = {
              onMessageEdited: jest.fn(h.callbacks.onMessageEdited),
              onMessageRevoked: jest.fn(h.callbacks.onMessageRevoked),
              onMessageReaction: jest.fn(h.callbacks.onMessageReaction),
            };
            const { events } = build(4, { ...h.callbacks, ...handedOn }, store);
            const reached = (): number => Object.values(handedOn).reduce((n, fn) => n + fn.mock.calls.length, 0);

            upsert(events, text('X', CHAT_B));
            await flush();
            upsert(events, change(kind, CHAT_C, 'FORGED_ENV'));
            await flush();
            open(1);
            await flush();
            expect(reached()).toBe(0);
            release();
            await flush();

            expect(reached()).toBe(conflicts ? 1 : 0);
            expect(effect(h, kind)).toEqual(untouched(kind, conflicts));
            expect(h.announcedAs('message.edited')).toEqual([]);
            expect(h.announcedAs('message.revoked')).toEqual([]);
          },
        );

        // The answer comes before the change is judged again, so the adapter has the copy (the delivery is
        // the message) or nothing (it conflicted and the copy was removed) to judge it by.
        it.each(kinds.flatMap(kind => [true, false].map(conflicts => [kind, conflicts] as const)))(
          'drops a forged %s from a third chat judged after the answer (delivery conflicts: %s)',
          async (kind, conflicts) => {
            const h = heldProjector({ unique: true, sqlite });
            if (conflicts) h.rows.push(seeded());
            const { store, open } = holdingReads([1, 3]);
            const { events } = build(4, h.callbacks, store);

            upsert(events, text('X', CHAT_B));
            await flush();
            upsert(events, change(kind, CHAT_C, 'FORGED_ENV'));
            await flush();
            open(1);
            await flush();
            open(3);
            await flush();

            expect(effect(h, kind)).toEqual(untouched(kind, conflicts));
            expect(h.announcedAs('message.edited')).toEqual([]);
            expect(h.announcedAs('message.revoked')).toEqual([]);
            // The copy of a delivery that is the message stays; a conflicting one is gone.
            expect(store.copies.has('X')).toBe(!conflicts);
          },
        );
      });

      // The park gives up what the change holds, whichever kind it is: it is announced as nothing, and the
      // delivery it waits for needs its slot and its turn back.
      it.each(kinds)(
        'lets the delivery take its limiter slot back when its room frees, while a %s waits',
        async kind => {
          process.env.INBOUND_MEDIA_CONCURRENCY = '1';
          process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '1000';
          const h = heldProjector({ unique: true });
          h.rows.push(seeded());
          const { events, emitted } = build(1, h.callbacks, memoryStore());
          const release = h.stall('H');

          upsert(events, media('H', 'hold@s.whatsapp.net'));
          await flush();
          // X asks for the room H holds until its row is written, and gives its only limiter slot up meanwhile.
          upsert(events, media('X', CHAT_B));
          await flush();
          upsert(events, change(kind, CHAT_A, 'REAL_ENV'));
          await flush();
          expect(emitted).toEqual(['H']);
          expect(h.rows).toEqual([seeded()]);

          release();
          await flush();
          expect(emitted).toEqual(['H', 'X']);
          expect(h.rows.find(r => r.waMessageId === 'X')).toEqual(expect.objectContaining({ chatId: CHAT_A }));
          expect(effect(h, kind)).toEqual(landed[kind]);
        },
      );

      it.each(kinds)('keeps no limiter slot while a %s waits for the answer', async kind => {
        process.env.INBOUND_MEDIA_CONCURRENCY = '1';
        const h = heldProjector({ unique: true });
        h.rows.push(seeded());
        const release = h.stall('X');
        const { events } = build(1, h.callbacks, memoryStore());

        upsert(events, text('X', CHAT_B));
        await flush();
        upsert(events, change(kind, CHAT_A, 'REAL_ENV'));
        await flush();
        // The only slot is free for what arrives next, though the change has not been judged.
        upsert(events, text('N', CHAT_C));
        await flush();
        expect(h.inserted()).toContain('N');
        expect(effect(h, kind)).toEqual(untouched(kind, true));

        release();
        await flush();
        expect(h.rows.find(r => r.waMessageId === 'X')).toEqual(expect.objectContaining({ chatId: CHAT_A }));
        expect(effect(h, kind)).toEqual(landed[kind]);
      });

      it.each(kinds)('does not hold back the later messages of its own chat while a %s waits', async kind => {
        const h = heldProjector({ unique: true });
        h.rows.push(seeded());
        const { store, open } = holdingReads([1]);
        const { events } = build(4, h.callbacks, store);

        upsert(events, text('X', CHAT_B));
        await flush();
        upsert(events, change(kind, CHAT_A, 'REAL_ENV'), text('F', CHAT_A));
        await flush();

        expect(h.hookStarts).toContain('F');
        expect(h.inserted()).toContain('F');
        open(1);
        await flush();
        expect(h.rows[0]).toEqual(expect.objectContaining({ waMessageId: 'X', chatId: CHAT_A }));
        expect(effect(h, kind)).toEqual(landed[kind]);
      });

      // The host keeps no copy and cannot remove one, so the key the delivery arrived under judges the change,
      // and the removal of the conflicting copy of U fails. A message of another id that conflicts meanwhile has
      // no say in what X is.
      it.each([
        ['PostgreSQL', false],
        ['SQLite', true],
      ])(
        'keeps holding a forged change when another id conflicts while the delivery downloads, on %s',
        async (_, sqlite) => {
          const h = heldProjector({ unique: true, sqlite });
          h.rows.push({ waMessageId: 'U', chatId: CHAT_A, direction: 'incoming', body: 'another real one' });
          const download = deferred<ReturnType<typeof stream>>();
          downloadMediaMessage.mockImplementationOnce(() => download.promise);
          const onMessageEdited = jest.fn(h.callbacks.onMessageEdited);
          const { events } = build(4, { ...h.callbacks, onMessageEdited });

          upsert(events, media('X', CHAT_B));
          await flush();
          upsert(events, change('edit', CHAT_C, 'FORGED_ENV'));
          await flush();
          upsert(events, text('U', '628444@s.whatsapp.net'));
          await flush();
          expect(h.rows.find(r => r.waMessageId === 'U')?.body).toBe('another real one');

          download.resolve(stream());
          await flush();

          expect(onMessageEdited).not.toHaveBeenCalled();
          expect(h.announcedAs('message.edited')).toEqual([]);
        },
      );
    });
  });

  // A reaction, an edit or a delete of a message that is still being processed. PostgreSQL holds the message from
  // its arrival, so the session keeps the change for the row whenever it comes. SQLite holds nothing before the
  // emit, so the adapter announces the change right after it, when the session holds the message.
  describe.each([
    ['PostgreSQL', false],
    ['SQLite', true],
  ])('a reaction, an edit or a delete of media still downloading, on %s', (_, sqlite) => {
    const CHAT = '628111@s.whatsapp.net';
    const target = (id: string) => ({ id, remoteJid: CHAT, fromMe: false });
    const change = (id: string, content: Row): WAMessage => ({
      key: { id, remoteJid: CHAT, fromMe: false },
      messageTimestamp: 1_700_000_001,
      message: content,
    });
    const react = (id: string, of: string, reaction: string): WAMessage =>
      change(id, { reactionMessage: { key: target(of), text: reaction } });
    const edit = (id: string, of: string, body: string): WAMessage =>
      change(id, {
        protocolMessage: {
          type: 14,
          key: target(of),
          editedMessage: { conversation: body },
          timestampMs: 1_700_000_002_000,
        },
      });
    const revoke = (id: string, of: string): WAMessage => change(id, { protocolMessage: { type: 0, key: target(of) } });
    /** The next download goes on until the returned function is called. */
    const download = (): (() => void) => {
      const pending = deferred<ReturnType<typeof stream>>();
      downloadMediaMessage.mockImplementationOnce(() => pending.promise);
      return () => pending.resolve(stream());
    };
    /** The callbacks the session is handed, noted in the order the adapter calls them. */
    const traced = (h: ReturnType<typeof heldProjector>) => {
      const log: string[] = [];
      const to = h.callbacks;
      const callbacks: EngineEventCallbacks = {
        ...to,
        onMessage: (m, t) => (log.push(`message ${m.id}`), to.onMessage!(m, t)),
        onMessageReaction: r => (log.push(`reaction ${r.messageId} ${r.reaction}`), to.onMessageReaction!(r)),
        onMessageEdited: e => (log.push(`edited ${e.messageId} ${e.body}`), to.onMessageEdited!(e)),
        onMessageRevoked: (m, actor) => (log.push(`revoked ${m.id}`), to.onMessageRevoked!(m, actor)),
      };
      return { log, callbacks };
    };
    const changesOnly = (log: string[]): string[] => log.filter(entry => !entry.startsWith('message '));

    it('keeps a reaction for the row of the message', async () => {
      const h = heldProjector({ unique: true, sqlite });
      const { events } = build(4, h.callbacks);
      const release = download();
      upsert(events, media('M', CHAT));
      await flush();
      upsert(events, react('R', 'M', 'THUMB'));
      await flush();
      release();
      await flush();

      expect(h.rows.map(r => [r.waMessageId, (r.metadata as Row | null)?.reactions])).toEqual([
        ['M', { [CHAT]: 'THUMB' }],
      ]);
      expect(h.announcedAs('message.reaction')).toEqual([
        expect.objectContaining({ messageId: 'M', reaction: 'THUMB' }),
      ]);
    });

    it('has the session hold the message when an edit reaches it, and the row takes the text', async () => {
      const h = heldProjector({ unique: true, sqlite });
      const quotedWhenEdited: boolean[] = [];
      const rowsWhenEdited: number[] = [];
      const onMessageEdited: EngineEventCallbacks['onMessageEdited'] = e => {
        quotedWhenEdited.push(h.projector.inFlightInbound('s1', e.messageId) !== undefined);
        rowsWhenEdited.push(h.rows.length);
        h.callbacks.onMessageEdited!(e);
      };
      const { events } = build(4, { ...h.callbacks, onMessageEdited });
      const release = download();
      upsert(events, media('M', CHAT, { caption: 'caption' }));
      await flush();
      upsert(events, edit('E', 'M', 'fixed caption'));
      await flush();
      release();
      await flush();

      expect(h.rows).toEqual([expect.objectContaining({ waMessageId: 'M', body: 'fixed caption' })]);
      expect(h.announcedAs('message.edited')).toEqual([
        expect.objectContaining({ messageId: 'M', body: 'fixed caption' }),
      ]);
      // The stored-message lookup has not finished, so neither database lends an unchecked quote.
      expect(quotedWhenEdited).toEqual([false]);
      // Either way the edit reaches it before its row is written, and an edit that meets the row with the same
      // text is no edit to the session.
      expect(rowsWhenEdited).toEqual([0]);
    });

    // The message is handed over with the edit applied, and the edit reaches the session too, so the session is told
    // the text the message arrived with to compare the edit with.
    it.each([
      ['an edit', 'fixed caption', 'caption'],
      ['an edit that repeats the text', 'caption', undefined],
    ])('hands the message over with %s and the text it arrived with', async (_, body, originalBody) => {
      const h = heldProjector({ unique: true, sqlite });
      const handedOver: Array<Pick<IncomingMessage, 'body' | 'originalBody'>> = [];
      const { events } = build(4, {
        ...h.callbacks,
        onMessage: (m, t) => (
          handedOver.push({ body: m.body, originalBody: m.originalBody }),
          h.callbacks.onMessage!(m, t)
        ),
      });
      const release = download();
      upsert(events, media('M', CHAT, { caption: 'caption' }));
      await flush();
      upsert(events, edit('E', 'M', body));
      await flush();
      release();
      await flush();

      expect(handedOver).toEqual([{ body, originalBody }]);
    });

    it.each([
      ['edits that restore it', ['fixed caption', 'caption'], 'caption'],
      ['edits that restore it and then repeat it', ['fixed caption', 'caption', 'caption'], 'caption'],
      ['edits that each repeat it', ['caption', 'caption'], undefined],
    ])(
      'hands the message over with the text it arrived with after %s only if one changed it',
      async (_, bodies, originalBody) => {
        const h = heldProjector({ unique: true, sqlite });
        const handedOver: Array<Pick<IncomingMessage, 'body' | 'originalBody'>> = [];
        const { events } = build(4, {
          ...h.callbacks,
          onMessage: (m, t) => (
            handedOver.push({ body: m.body, originalBody: m.originalBody }),
            h.callbacks.onMessage!(m, t)
          ),
        });
        const release = download();
        upsert(events, media('M', CHAT, { caption: 'caption' }));
        await flush();
        for (const [i, body] of bodies.entries()) {
          upsert(events, edit(`E${i}`, 'M', body));
          await flush();
        }
        release();
        await flush();

        expect(handedOver).toEqual([{ body: 'caption', originalBody }]);
      },
    );

    it.each([
      ['an edit', 'fixed caption', true],
      ['an edit that repeats the text', 'caption', undefined],
    ])('marks the row and the message edited for %s only if it changed the text', async (_, body, edited) => {
      const h = heldProjector({ unique: true, sqlite });
      const { events } = build(4, h.callbacks);
      const release = download();
      upsert(events, media('M', CHAT, { caption: 'caption' }));
      await flush();
      upsert(events, edit('E', 'M', body));
      await flush();
      release();
      await flush();

      expect(h.rows).toEqual([expect.objectContaining({ waMessageId: 'M', body })]);
      expect((h.rows[0].metadata as Row).edited).toBe(edited);
      expect(h.announcedAs('message.edited')).toEqual([expect.objectContaining({ messageId: 'M', body })]);
      const received = h.announcedAs('message.received');
      expect(received).toEqual([expect.objectContaining({ id: 'M', body })]);
      if (edited) expect(received[0]).toEqual(expect.objectContaining({ edited: true }));
      else expect(received[0]).not.toHaveProperty('edited');
    });

    it(
      sqlite
        ? 'announces them once the message has been handed on'
        : 'announces them at once, the session holds the message already',
      async () => {
        const h = heldProjector({ unique: true, sqlite });
        const { events } = build(4, h.callbacks);
        const release = download();
        upsert(events, media('M', CHAT));
        await flush();
        upsert(events, react('R', 'M', 'ok'), edit('E', 'M', 'fixed'));
        await flush();
        const early = [h.announcedAs('message.reaction').length, h.announcedAs('message.edited').length];
        release();
        await flush();

        expect(early).toEqual(sqlite ? [0, 0] : [1, 1]);
        expect([h.announcedAs('message.reaction').length, h.announcedAs('message.edited').length]).toEqual([1, 1]);
      },
    );

    it('announces a delete at once, and neither emits nor announces the message after it', async () => {
      const h = heldProjector({ unique: true, sqlite });
      const { events } = build(4, h.callbacks);
      const release = download();
      upsert(events, media('M', CHAT, { caption: 'caption' }));
      await flush();
      upsert(events, revoke('V', 'M'));
      await flush();
      expect(h.announcedAs('message.revoked')).toHaveLength(1);
      release();
      await flush();

      expect(h.announced()).toEqual([]);
      // As on whatsapp-web.js a held message is stored cleared; where nothing holds it (SQLite) it is not stored.
      expect(h.rows).toEqual(sqlite ? [] : [expect.objectContaining({ waMessageId: 'M', body: '', type: 'revoked' })]);
    });

    it.each([
      ['a reaction', (): WAMessage => react('R', 'M', 'ok'), 'reaction M ok'],
      ['an edit', (): WAMessage => edit('E', 'M', 'fixed'), 'edited M fixed'],
    ])(
      'announces %s before the delete that follows it, and no content after the delete',
      async (_kind, first, seen) => {
        const h = heldProjector({ unique: true, sqlite });
        const { log, callbacks } = traced(h);
        const { events } = build(4, callbacks);
        const release = download();
        upsert(events, media('M', CHAT, { caption: 'caption' }));
        await flush();
        upsert(events, first(), revoke('V', 'M'));
        await flush();
        release();
        await flush();

        expect(changesOnly(log)).toEqual([seen, 'revoked M']);
        expect(h.announced()).toEqual([]);
        expect(h.rows.map(r => r.body)).toEqual(sqlite ? [] : ['']);
      },
    );
  });

  // A message Baileys could not decrypt is upserted as a stub without content, and its content arrives later (a retry
  // or a resend from the phone) as an ordinary upsert under the same id. Baileys reports an edit only for an edit
  // message, so the content arriving is no edit.
  describe.each([
    ['PostgreSQL', false],
    ['SQLite', true],
  ])('a message that arrived undecrypted, on %s', (_, sqlite) => {
    it('stores and announces it once its content arrives, unedited', async () => {
      const h = heldProjector({ unique: true, sqlite });
      const { events } = build(4, h.callbacks, memoryStore());
      const key = { id: 'M', remoteJid: '628111@s.whatsapp.net', fromMe: false };
      const stub = { key, messageTimestamp: 1_700_000_000, messageStubType: 1, messageStubParameters: ['absent'] };
      upsert(events, stub);
      await flush();
      upsert(events, { key, messageTimestamp: 1_700_000_000, message: { conversation: 'hello' } });
      await flush();

      expect(h.rows).toEqual([expect.objectContaining({ waMessageId: 'M', body: 'hello' })]);
      expect(h.rows[0].metadata ?? {}).not.toHaveProperty('edited');
      expect(h.announcedAs('message.received')).toEqual([expect.objectContaining({ id: 'M', body: 'hello' })]);
      expect(h.announcedAs('message.received')[0]).not.toHaveProperty('edited');
      expect(h.announcedAs('message.edited')).toEqual([]);
    });
  });

  // Where nothing is admitted before the emit (SQLite), a change waits for its message, and the wait is bounded.
  describe('a change of a message still being processed, where nothing is admitted before the emit', () => {
    const CHAT = '628111@s.whatsapp.net';
    const target = (id: string) => ({ id, remoteJid: CHAT, fromMe: false });
    const reaction = (id: string, of: string, text: string): WAMessage => ({
      key: { id, remoteJid: CHAT, fromMe: false },
      messageTimestamp: 1_700_000_001,
      message: { reactionMessage: { key: target(of), text } },
    });
    const edit = (id: string, of: string, body: string): WAMessage => ({
      key: { id, remoteJid: CHAT, fromMe: false },
      messageTimestamp: 1_700_000_002,
      message: {
        protocolMessage: {
          type: 14,
          key: target(of),
          editedMessage: { conversation: body },
          timestampMs: 1_700_000_002_000,
        },
      },
    });
    const download = (): (() => void) => {
      const pending = deferred<ReturnType<typeof stream>>();
      downloadMediaMessage.mockImplementationOnce(() => pending.promise);
      return () => pending.resolve(stream());
    };

    it.each([1, 4])(
      'hands the session the message, then its reactions and edits in the order they arrived (limiter of %i)',
      async k => {
        const h = heldProjector({ unique: true, sqlite: true });
        const log: string[] = [];
        const to = h.callbacks;
        const { events } = build(k, {
          ...to,
          onMessage: (m, t) => (log.push(`message ${m.id}`), to.onMessage!(m, t)),
          onMessageReaction: r => (log.push(`reaction ${r.messageId} ${r.reaction}`), to.onMessageReaction!(r)),
          onMessageEdited: e => (log.push(`edited ${e.messageId} ${e.body}`), to.onMessageEdited!(e)),
        });
        const release = download();
        upsert(events, media('M', CHAT, { caption: 'caption' }));
        await flush();
        upsert(events, reaction('R1', 'M', 'ok'), edit('E1', 'M', 'fixed'), reaction('R2', 'M', 'ok2'));
        await flush();
        expect(log).toEqual([]);
        release();
        await flush();

        expect(log).toEqual(['message M', 'reaction M ok', 'edited M fixed', 'reaction M ok2']);
      },
    );

    it.each([1, 4])('orders mixed changes after their outcome wait and directory read (limiter %i)', async k => {
      const store = memoryStore();
      const outcome = deferred<{ conflict: boolean }>();
      const directory = deferred<string | null>();
      const findPersistedLidPhone = jest.fn(() => directory.promise);
      const log: string[] = [];
      const { events, limiter } = build(
        k,
        {
          onMessage: () => ({ settled: outcome.promise }),
          onMessageEdited: () => {
            log.push('edit');
          },
          onMessageReaction: () => {
            log.push('reaction');
          },
        },
        Object.assign(store, { findPersistedLidPhone }),
      );
      upsert(events, text('M', '628222@s.whatsapp.net'));
      await flush();
      const e = edit('E', 'M', 'fixed');
      const r = reaction('R', 'M', 'ok');
      e.key.remoteJid = r.key.remoteJid = '777@lid';
      upsert(events, e, r);
      await flush();
      expect(log).toEqual([]);
      outcome.resolve({ conflict: true });
      await flush();
      expect(findPersistedLidPhone).toHaveBeenCalledTimes(1);
      expect(log).toEqual([]);
      directory.resolve('628111');
      await flush();
      expect(log).toEqual(['edit', 'reaction']);
      expect(limiter.activeCount).toBe(0);
      expect(limiter.queuedCount).toBe(0);
    });

    it.each(['active', 'retired', 'throwing'] as const)(
      'prepares another target while one waits and releases its queue when %s',
      async ending => {
        const store = memoryStore();
        store.copies.set('M', text('M', CHAT));
        store.copies.set('N', text('N', CHAT));
        const read = store.getStoredMessage;
        const gate = deferred<void>();
        let first = true;
        store.getStoredMessage = id => {
          if (id === 'M' && first) {
            first = false;
            return gate.promise.then(() => read(id));
          }
          return read(id);
        };
        const log: string[] = [];
        const { events, limiter } = build(
          4,
          {
            onMessageEdited: e => {
              if (ending === 'throwing') throw new Error('consumer failed');
              log.push(`edit ${e.messageId}`);
            },
            onMessageReaction: r => {
              log.push(`reaction ${r.messageId}`);
            },
          },
          store,
        );
        upsert(events, edit('E', 'M', 'fixed'), reaction('R', 'M', 'a'), reaction('N1', 'N', 'b'));
        await flush();
        expect(log).toEqual(['reaction N']);
        expect(limiter.activeCount).toBe(0);
        expect(limiter.queuedCount).toBe(0);
        if (ending === 'retired') events.fenceStoredWrites();
        gate.resolve();
        await flush();
        expect(log).toEqual(
          ending === 'retired'
            ? ['reaction N']
            : ending === 'throwing'
              ? ['reaction N', 'reaction M']
              : ['reaction N', 'edit M', 'reaction M'],
        );
        expect(limiter.activeCount).toBe(0);
        expect(limiter.queuedCount).toBe(0);
        expect((events as unknown as { changesPreparing: number }).changesPreparing).toBe(0);
        upsert(events, reaction('CURRENT', 'M', 'current'));
        await flush();
        expect(log.at(-1)).toBe('reaction M');
      },
    );

    it.each([
      ['reaction', false],
      ['reaction', true],
      ['edit', false],
      ['edit', true],
      ['revoke', false],
      ['revoke', true],
    ] as const)('finishes a prepared %s only in its original generation (retired: %s)', async (kind, retired) => {
      const store = memoryStore();
      store.copies.set('M', text('M', CHAT));
      const read = store.getStoredMessage;
      const gate = deferred<void>();
      let first = true;
      store.getStoredMessage = id => {
        if (id === 'M' && first) {
          first = false;
          return gate.promise.then(() => read(id));
        }
        return read(id);
      };
      const announced = jest.fn();
      const { events, limiter } = build(
        4,
        {
          onMessageEdited: announced,
          onMessageRevoked: announced,
          onMessageReaction: announced,
        },
        store,
      );
      const message = kind === 'reaction' ? reaction('CHANGE', 'M', 'a') : edit('CHANGE', 'M', 'fixed');
      if (kind === 'revoke') message.message = { protocolMessage: { type: 0, key: target('M') } };
      upsert(events, message);
      await flush();
      if (retired) events.fenceStoredWrites();
      gate.resolve();
      await flush();
      expect(announced).toHaveBeenCalledTimes(retired ? 0 : 1);
      expect(limiter.activeCount).toBe(0);
      expect(limiter.queuedCount).toBe(0);
      announced.mockClear();
      upsert(events, reaction('CURRENT', 'M', 'current'));
      await flush();
      expect(announced).toHaveBeenCalledTimes(1);
    });

    it.each([1, 4])(
      'keeps all 64 prepared edits in arrival order without media slots (limiter %i)',
      async concurrency => {
        const store = memoryStore();
        store.copies.set('M', text('M', CHAT));
        const read = store.getStoredMessage;
        const gate = deferred<void>();
        let first = true;
        store.getStoredMessage = id => {
          if (id === 'M' && first) {
            first = false;
            return gate.promise.then(() => read(id));
          }
          return read(id);
        };
        const log: string[] = [];
        const { events, limiter } = build(
          concurrency,
          {
            onMessageEdited: e => {
              log.push(e.body);
            },
          },
          store,
        );
        upsert(events, ...Array.from({ length: 64 }, (_, i) => edit(`E${i}`, 'M', `v${i + 1}`)));
        await flush();
        expect(log).toEqual([]);
        expect(limiter.activeCount).toBe(0);
        gate.resolve();
        await flush();
        expect(log).toEqual(Array.from({ length: 64 }, (_, i) => `v${i + 1}`));
        expect(store.copies.get('M')?.message?.conversation).toBe('v64');
        expect(limiter.activeCount).toBe(0);
      },
    );

    it.each([1, 4])(
      'backpressures preparations above 64 without changing edit order (limiter %i)',
      async concurrency => {
        const store = memoryStore();
        store.copies.set('M', text('M', CHAT));
        const read = store.getStoredMessage;
        const gate = deferred<void>();
        let first = true;
        store.getStoredMessage = id => {
          if (id === 'M' && first) {
            first = false;
            return gate.promise.then(() => read(id));
          }
          return read(id);
        };
        const log: string[] = [];
        const { events, limiter } = build(
          concurrency,
          {
            onMessageEdited: e => {
              log.push(e.body);
            },
          },
          store,
        );
        upsert(events, edit('E0', 'M', 'v1'));
        await flush();
        upsert(events, ...Array.from({ length: 69 }, (_, i) => edit(`E${i + 1}`, 'M', `v${i + 2}`)));
        await flush();
        expect(log).toEqual([]);
        expect((events as unknown as { changesPreparing: number }).changesPreparing).toBe(64);
        gate.resolve();
        await flush();
        expect(log).toEqual(Array.from({ length: 70 }, (_, i) => `v${i + 1}`));
        expect(store.copies.get('M')?.message?.conversation).toBe('v70');
        expect((events as unknown as { changesPreparing: number }).changesPreparing).toBe(0);
        expect(limiter.activeCount).toBe(0);
        expect(limiter.queuedCount).toBe(0);
      },
    );

    it.each([1, 4])(
      'lets a queued original run while 70 foreign changes wait for it (limiter %i)',
      async concurrency => {
        const store = memoryStore();
        const arrived = deferred<string>();
        const edits: string[] = [];
        const { events, limiter, emitted } = build(
          concurrency,
          {
            onMessage: m => {
              arrived.resolve(m.id);
            },
            onMessageEdited: e => {
              edits.push(e.body);
            },
          },
          store,
        );
        upsert(
          events,
          ...Array.from({ length: 70 }, (_, i) => edit(`E${i}`, 'M', `v${i + 1}`)),
          text('M', '628222@s.whatsapp.net'),
        );
        expect(await Promise.race([arrived.promise, sleep(400).then(() => null)])).toBe('M');
        await flush();
        expect(emitted).toEqual(['M']);
        expect(edits).toEqual([]);
        expect(store.copies.get('M')?.key.remoteJid).toBe('628222@s.whatsapp.net');
        expect((events as unknown as { changesPreparing: number }).changesPreparing).toBe(0);
        expect(limiter.activeCount).toBe(0);
        expect(limiter.queuedCount).toBe(0);
      },
    );

    it.each([false, true])(
      'does not replay prepared callbacks when the limiter closes (retired: %s)',
      async retired => {
        const store = memoryStore();
        store.copies.set('M', text('M', CHAT));
        const read = store.getStoredMessage;
        const gate = deferred<void>();
        let first = true;
        store.getStoredMessage = id => {
          if (id === 'M' && first) {
            first = false;
            return gate.promise.then(() => read(id));
          }
          return read(id);
        };
        const log: string[] = [];
        const { events, limiter } = build(
          4,
          {
            onMessageEdited: e => {
              log.push(e.body);
            },
          },
          store,
        );
        upsert(events, edit('E0', 'M', 'v1'));
        await flush();
        upsert(events, ...Array.from({ length: 69 }, (_, i) => edit(`E${i + 1}`, 'M', `v${i + 2}`)));
        await flush();
        if (retired) events.fenceStoredWrites();
        limiter.close();
        gate.resolve();
        await flush();
        expect(log).toEqual(retired ? [] : Array.from({ length: 70 }, (_, i) => `v${i + 1}`));
        expect((events as unknown as { changesPreparing: number }).changesPreparing).toBe(0);
        expect(limiter.activeCount).toBe(0);
        expect(limiter.queuedCount).toBe(0);
      },
    );

    it('starts the current generation without waiting for an old preparation read', async () => {
      const store = memoryStore();
      store.copies.set('M', text('M', CHAT));
      const read = store.getStoredMessage;
      const gate = deferred<void>();
      let first = true;
      store.getStoredMessage = id => {
        if (id === 'M' && first) {
          first = false;
          return gate.promise.then(() => read(id));
        }
        return read(id);
      };
      const current = deferred<string>();
      const edited = jest.fn();
      const { events, limiter } = build(
        4,
        {
          onMessageEdited: edited,
          onMessageReaction: r => {
            current.resolve(r.reaction);
          },
        },
        store,
      );
      upsert(events, ...Array.from({ length: 64 }, (_, i) => edit(`E${i}`, 'M', 'old')));
      await flush();
      events.fenceStoredWrites();
      upsert(events, reaction('CURRENT', 'M', 'current'));
      try {
        expect(await Promise.race([current.promise, sleep(400).then(() => null)])).toBe('current');
      } finally {
        gate.resolve();
      }
      await flush();
      expect(edited).not.toHaveBeenCalled();
      expect((events as unknown as { changesPreparing: number }).changesPreparing).toBe(0);
      expect(limiter.activeCount).toBe(0);
    });

    // In the turn of the emit, so they reach the message before the session has written its row: an edit that
    // meets the row with the text it already has is no edit to the session, and takes no marker.
    it('announces what waited in the turn of the emit', async () => {
      const h = heldProjector({ unique: true, sqlite: true });
      const log: string[] = [];
      const to = h.callbacks;
      const { events } = build(4, {
        ...to,
        onMessage: (m, t) => {
          log.push(`message ${m.id}`);
          queueMicrotask(() => log.push('end of the turn'));
          return to.onMessage!(m, t);
        },
        onMessageReaction: r => (log.push(`reaction ${r.messageId}`), to.onMessageReaction!(r)),
        onMessageEdited: e => (log.push(`edited ${e.messageId}`), to.onMessageEdited!(e)),
      });
      const release = download();
      upsert(events, media('M', CHAT));
      await flush();
      upsert(events, reaction('R', 'M', 'ok'), edit('E', 'M', 'fixed'));
      await flush();
      release();
      await flush();

      expect(log).toEqual(['message M', 'reaction M', 'edited M', 'end of the turn']);
    });

    it('lets a change go three media deadlines after it began to wait, when the message is never handed on', async () => {
      process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '30';
      const h = heldProjector({ unique: true, sqlite: true });
      const store = memoryStore();
      const read = store.getStoredMessage;
      let checked = false;
      // The message's own check for a repeat delivery never answers, which keeps it in flight for good.
      store.getStoredMessage = (id: string) => {
        if (id !== 'M' || checked) return read(id);
        checked = true;
        return new Promise<WAMessage | null>(() => undefined);
      };
      const { events } = build(4, h.callbacks, store);
      upsert(events, text('M', CHAT));
      await flush();
      upsert(events, reaction('R', 'M', 'ok'));
      await sleep(40);
      expect(h.announcedAs('message.reaction')).toEqual([]);

      await sleep(120);
      expect(h.announcedAs('message.reaction')).toHaveLength(1);
      expect(internals(events)).toEqual({ waiting: 0, queued: 0 });
    });

    it('holds at most 64 changes at a time, and nothing once the message is handed on', async () => {
      const h = heldProjector({ unique: true, sqlite: true });
      const { events } = build(4, h.callbacks);
      const release = download();
      upsert(events, media('M', CHAT));
      await flush();
      upsert(events, ...Array.from({ length: 70 }, (_, i) => reaction(`R${i}`, 'M', `r${i}`)));
      await flush();
      // The six past the limit go out at once, as they did before.
      expect(h.announcedAs('message.reaction')).toHaveLength(6);
      expect(internals(events)).toEqual({ waiting: 64, queued: 1 });

      release();
      await flush();
      expect(h.announcedAs('message.reaction')).toHaveLength(70);
      expect(internals(events)).toEqual({ waiting: 0, queued: 0 });
    });

    // The limit is the one of the changes that wait for an outcome, but counted apart: a change that has to wait for
    // the answer of the session is held, not dropped, whatever number of others wait for their message.
    it('keeps a change that waits for the answer of the session held while 64 others wait for their message', async () => {
      const OTHER = '628222@s.whatsapp.net';
      const h = heldProjector({ unique: true, sqlite: true });
      h.rows.push({ waMessageId: 'X', chatId: CHAT, direction: 'incoming', body: 'the real one' });
      const answer = h.stall('X'); // the row of the delivery of X waits, so the session has not answered yet
      const { events } = build(4, h.callbacks, memoryStore());
      const release = download();
      upsert(events, media('M', CHAT), text('X', OTHER));
      await flush();
      upsert(events, ...Array.from({ length: 64 }, (_, i) => reaction(`R${i}`, 'M', `r${i}`)));
      await flush();
      expect(h.announcedAs('message.reaction')).toEqual([]);

      // The real edit of X reads as foreign to the copy the delivery stored, and waits for the answer.
      upsert(events, edit('E', 'X', 'fixed'));
      await flush();
      answer();
      release();
      await flush();

      expect(h.rows.find(r => r.waMessageId === 'X')).toEqual(expect.objectContaining({ chatId: CHAT, body: 'fixed' }));
      expect(h.announcedAs('message.reaction')).toHaveLength(64);
    });

    it('keeps a change waiting for its message while 64 others wait for the answer of the session', async () => {
      const OTHER = '628222@s.whatsapp.net';
      const h = heldProjector({ unique: true, sqlite: true });
      h.rows.push({ waMessageId: 'X', chatId: CHAT, direction: 'incoming', body: 'the real one' });
      const answer = h.stall('X'); // the row of the delivery of X waits, so the session has not answered yet
      const { events } = build(4, h.callbacks, memoryStore());
      const release = download();
      upsert(events, media('M', CHAT), text('X', OTHER));
      await flush();
      // The real edits of X read as foreign to the copy the delivery stored, and wait for the answer.
      upsert(events, ...Array.from({ length: 64 }, (_, i) => edit(`E${i}`, 'X', `v${i}`)));
      await flush();
      expect(h.announcedAs('message.edited')).toEqual([]);

      upsert(events, reaction('R', 'M', 'late'));
      await flush();
      expect(h.announcedAs('message.reaction')).toEqual([]);
      answer();
      release();
      await flush();

      expect(h.rows.map(r => (r.metadata as Row | null)?.reactions)).toContainEqual({ [CHAT]: 'late' });
      expect(h.announcedAs('message.reaction')).toHaveLength(1);
    });

    it('announces the other changes, and does not process the message again, when a consumer throws', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const h = heldProjector({ unique: true, sqlite: true });
      let thrown = false;
      const onMessageReaction: EngineEventCallbacks['onMessageReaction'] = r => {
        if (!thrown) {
          thrown = true;
          throw new Error('consumer failed');
        }
        h.callbacks.onMessageReaction!(r);
      };
      const { events, emitted } = build(4, { ...h.callbacks, onMessageReaction });
      const release = download();
      upsert(events, media('M', CHAT));
      await flush();
      upsert(events, reaction('R1', 'M', 'a'), reaction('R2', 'M', 'b'));
      await flush();
      release();
      await flush();

      expect(emitted).toEqual(['M']);
      expect(downloadMediaMessage).toHaveBeenCalledTimes(1);
      expect(h.announcedAs('message.reaction')).toEqual([expect.objectContaining({ reaction: 'b' })]);
    });

    it('does not make a reaction wait for itself, nor two reactions for each other', async () => {
      const h = heldProjector({ unique: true, sqlite: true });
      const { events } = build(4, h.callbacks);
      upsert(events, reaction('SELF', 'SELF', 'a'), reaction('A', 'B', 'b'), reaction('B', 'A', 'c'));
      await flush();

      expect(h.announcedAs('message.reaction')).toHaveLength(3);
      expect(internals(events)).toEqual({ waiting: 0, queued: 0 });
    });

    // An edit that cannot wait for its message is announced while the session holds nothing to mark. The message is
    // handed on with the edit applied and the text it arrived with, so its row and announcement carry the mark.
    it('marks a message whose edit was announced at once, past the 64 changes that wait', async () => {
      const h = heldProjector({ unique: true, sqlite: true });
      const { events } = build(4, h.callbacks);
      const releaseOther = download();
      const release = download();
      upsert(events, media('O', CHAT), media('M', CHAT, { caption: 'caption' }));
      await flush();
      upsert(events, ...Array.from({ length: 64 }, (_, i) => reaction(`R${i}`, 'O', `r${i}`)));
      await flush();
      upsert(events, edit('E', 'M', 'fixed caption'));
      await flush();
      expect(h.announcedAs('message.edited')).toHaveLength(1);
      releaseOther();
      release();
      await flush();

      const row = h.rows.find(r => r.waMessageId === 'M');
      expect(row).toEqual(expect.objectContaining({ body: 'fixed caption' }));
      expect((row?.metadata as Row).edited).toBe(true);
      expect(h.announcedAs('message.received').filter(m => m.id === 'M')).toEqual([
        expect.objectContaining({ body: 'fixed caption', edited: true }),
      ]);
    });

    it('marks a message whose edit was announced three media deadlines after it began to wait', async () => {
      process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '30';
      const h = heldProjector({ unique: true, sqlite: true });
      const store = memoryStore();
      const read = store.getStoredMessage;
      const answer = deferred<void>();
      let checked = false;
      // The message's own check for a repeat delivery answers late, as behind a long queue.
      store.getStoredMessage = (id: string) => {
        if (id !== 'M' || checked) return read(id);
        checked = true;
        return answer.promise.then(() => read(id));
      };
      const { events } = build(4, h.callbacks, store);
      upsert(events, text('M', CHAT));
      await flush();
      upsert(events, edit('E', 'M', 'fixed'));
      await sleep(120);
      expect(h.announcedAs('message.edited')).toHaveLength(1);
      answer.resolve();
      await flush();

      expect(h.rows).toEqual([expect.objectContaining({ waMessageId: 'M', body: 'fixed' })]);
      expect((h.rows[0].metadata as Row).edited).toBe(true);
      expect(h.announcedAs('message.received')).toEqual([
        expect.objectContaining({ id: 'M', body: 'fixed', edited: true }),
      ]);
    });

    // Its edits went out as message.edited, so it was edited, though the last one restored the text it arrived with.
    it.each([
      ['within the 64 changes that wait', false],
      ['past the 64 changes that wait', true],
    ])('marks a message edited and then restored to its text while it downloads, %s', async (_, pastBound) => {
      const h = heldProjector({ unique: true, sqlite: true });
      const { events } = build(4, h.callbacks);
      const releaseOther = download();
      const release = download();
      upsert(events, media('O', CHAT), media('M', CHAT, { caption: 'caption' }));
      await flush();
      if (pastBound) upsert(events, ...Array.from({ length: 64 }, (_x, i) => reaction(`R${i}`, 'O', `r${i}`)));
      await flush();
      upsert(events, edit('E1', 'M', 'fixed caption'));
      await flush();
      upsert(events, edit('E2', 'M', 'caption'));
      await flush();
      expect(h.announcedAs('message.edited')).toHaveLength(pastBound ? 2 : 0);
      releaseOther();
      release();
      await flush();

      const row = h.rows.find(r => r.waMessageId === 'M');
      expect(row).toEqual(expect.objectContaining({ body: 'caption' }));
      expect((row?.metadata as Row).edited).toBe(true);
      expect(h.announcedAs('message.received').filter(m => m.id === 'M')).toEqual([
        expect.objectContaining({ body: 'caption', edited: true }),
      ]);
    });

    it.each([
      ['within three media deadlines', false],
      ['three media deadlines after they began to wait', true],
    ])('marks a message edited and then restored to its text, its edits announced %s', async (_, late) => {
      process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '30';
      const h = heldProjector({ unique: true, sqlite: true });
      const store = memoryStore();
      const read = store.getStoredMessage;
      const answer = deferred<void>();
      let checked = false;
      store.getStoredMessage = (id: string) => {
        if (id !== 'M' || checked) return read(id);
        checked = true;
        return answer.promise.then(() => read(id));
      };
      const { events } = build(4, h.callbacks, store);
      upsert(events, text('M', CHAT));
      await flush();
      upsert(events, edit('E1', 'M', 'fixed'));
      await flush();
      upsert(events, edit('E2', 'M', 'text M'));
      await flush();
      if (late) await sleep(120);
      expect(h.announcedAs('message.edited')).toHaveLength(late ? 2 : 0);
      answer.resolve();
      await flush();

      expect(h.rows).toEqual([expect.objectContaining({ waMessageId: 'M', body: 'text M' })]);
      expect((h.rows[0].metadata as Row).edited).toBe(true);
      expect(h.announcedAs('message.received')).toEqual([
        expect.objectContaining({ id: 'M', body: 'text M', edited: true }),
      ]);
    });

    it('leaves a message unmarked whose edits announced at once each repeated its text', async () => {
      const h = heldProjector({ unique: true, sqlite: true });
      const { events } = build(4, h.callbacks);
      const releaseOther = download();
      const release = download();
      upsert(events, media('O', CHAT), media('M', CHAT, { caption: 'caption' }));
      await flush();
      upsert(events, ...Array.from({ length: 64 }, (_x, i) => reaction(`R${i}`, 'O', `r${i}`)));
      await flush();
      upsert(events, edit('E1', 'M', 'caption'));
      await flush();
      upsert(events, edit('E2', 'M', 'caption'));
      await flush();
      expect(h.announcedAs('message.edited')).toHaveLength(2);
      releaseOther();
      release();
      await flush();

      const row = h.rows.find(r => r.waMessageId === 'M');
      expect(row).toEqual(expect.objectContaining({ body: 'caption' }));
      expect(row?.metadata as Row).not.toHaveProperty('edited');
      expect(h.announcedAs('message.received').filter(m => m.id === 'M')[0]).not.toHaveProperty('edited');
    });

    /** How many changes wait, and for how many messages. */
    const internals = (events: BaileysEvents) => {
      const state = events as unknown as { changesAwaiting: number; changesAwaitingEmit: Map<string, unknown> };
      return { waiting: state.changesAwaiting, queued: state.changesAwaitingEmit?.size ?? 0 };
    };
  });
});

describe('whatsapp-web.js inbound messages held for storage', () => {
  const build = (callbacks: EngineEventCallbacks) => {
    const adapter = new WhatsAppWebJsAdapter({ sessionId: 'hold', sessionDataPath: './data/sessions', puppeteer: {} });
    const client = Object.assign(new EventEmitter(), {
      info: { wid: { user: '628123' }, pushname: 'Tester' },
      getState: jest.fn().mockResolvedValue(WAState.CONNECTED),
      pupPage: { evaluate: jest.fn().mockResolvedValue(true) },
    });
    (adapter as unknown as { client: unknown }).client = client;
    (adapter as unknown as { callbacks: unknown }).callbacks = callbacks;
    (adapter as unknown as { lifecycle: WwebjsLifecycle }).lifecycle.setupEventHandlers();
    return { adapter, client };
  };
  const incoming = (id: string, from: string, page?: jest.Mock, body = '') => ({
    id: { _serialized: id },
    from,
    to: '628123@c.us',
    body,
    type: page ? 'image' : 'chat',
    timestamp: 1_700_000_000,
    fromMe: false,
    hasMedia: Boolean(page),
    _data: { mimetype: 'image/png', size: 3 },
    client: { pupPage: { evaluate: page } },
    getContact: jest.fn().mockResolvedValue(null),
    hasQuotedMsg: false,
  });
  // The account's own send as whatsapp-web.js echoes it: `from` is the account, `to` the conversation.
  const ownEcho = (id: string, to: string, page?: jest.Mock, body = '') => ({
    ...incoming(id, '628123@c.us', page, body),
    to,
    fromMe: true,
  });

  beforeEach(() => {
    process.env.INBOUND_MEDIA_CONCURRENCY = '1';
  });

  it.each(['revoke', 'edit'] as const)(
    'applies the %s of a text held behind a same-chat image, never announcing or hooking what was taken back',
    async change => {
      const h = heldProjector();
      const { client } = build(h.callbacks);
      const page = deferred<{ mimetype: string; data: string }>();
      client.emit(
        'message',
        incoming(
          'm1',
          '628111@c.us',
          jest.fn(() => page.promise),
        ),
      );
      client.emit('message', incoming('t2', '628111@c.us', undefined, 'secret'));
      await flush();
      if (change === 'revoke') {
        client.emit(
          'message_revoke_everyone',
          { id: { _serialized: 'rev' }, from: '628111@c.us', to: '628123@c.us', fromMe: false, timestamp: 2 },
          { id: { _serialized: 't2' } },
        );
      } else {
        client.emit(
          'message_edit',
          {
            id: { _serialized: 't2' },
            from: '628111@c.us',
            to: '628123@c.us',
            body: 'corrected',
            type: 'chat',
            fromMe: false,
          },
          'corrected',
        );
      }
      await flush();
      page.resolve({ mimetype: 'image/png', data: 'QUJD' });
      await flush();

      const t2 = h.rows.find(r => r.waMessageId === 't2');
      expect(h.inserted()).toEqual(['m1', 't2']);
      if (change === 'revoke') {
        expect(t2).toEqual(expect.objectContaining({ body: '', type: 'revoked' }));
        expect(h.announced()).toEqual(['m1']);
        expect(h.hookStarts).toEqual(['m1']);
      } else {
        expect(t2).toEqual(expect.objectContaining({ body: 'corrected' }));
        expect(h.announced()).toEqual(['m1', 't2']);
        expect(h.hookStarts).toEqual(['m1', 't2']);
        expect(h.hookedBodies.t2).toBe('corrected');
      }
    },
  );

  it('keeps its slot while the processing of a downloaded message is parked, across a reconnect', async () => {
    process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '5000';
    const h = heldProjector();
    const { client } = build(h.callbacks);
    const quoted = deferred<{ id: { _serialized: string }; body: string }>();
    const first = jest.fn().mockResolvedValue({ mimetype: 'image/png', data: 'QUJD' });
    client.emit('message', {
      ...incoming('m1', '628111@c.us', first),
      hasQuotedMsg: true,
      getQuotedMessage: jest.fn(() => quoted.promise),
    });
    await flush();
    // The payload is downloaded; the processing waits for the quoted message, which a held message bounds
    // only by MEDIA_DOWNLOAD_TIMEOUT_MS.
    expect(first).toHaveBeenCalledTimes(1);

    // The engine is retired and its pending turn dropped, so only the hold on the processing keeps the slot.
    const fresh = {} as IWhatsAppEngine;
    h.engines.set('s1', fresh);
    const next = build(h.callbacksFor(fresh));
    const second = jest.fn().mockResolvedValue({ mimetype: 'image/png', data: 'QUJD' });
    next.client.emit('message', incoming('m2', '628222@c.us', second));
    await flush();
    expect(second).not.toHaveBeenCalled();

    quoted.resolve({ id: { _serialized: 'q' }, body: 'quoted' });
    await flush();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('plans the download of a declared size at the cap, and of none above it', () => {
    process.env.MEDIA_DOWNLOAD_MAX_BYTES = '1000';
    process.env.MEDIA_DOWNLOAD_ENABLED = 'true';
    const declared = (size: number): WwebjsMessage => ({ hasMedia: true, _data: { size } }) as unknown as WwebjsMessage;

    expect(plannedInboundDownload(declared(1000))).toBe(true);
    expect(plannedInboundDownload(declared(1001))).toBe(false);
  });

  it('ignores message_create for a message the account did not send, which has its own message event', async () => {
    const h = heldProjector();
    const callbacks = {
      ...h.callbacks,
      admitInbound: jest.fn(h.callbacks.admitInbound),
      onMessageCreate: jest.fn(),
    };
    const { client } = build(callbacks);
    const page = jest.fn().mockResolvedValue({ mimetype: 'image/png', data: 'QUJD' });

    client.emit('message_create', incoming('m1', '628111@c.us', page));
    await flush();

    expect(callbacks.admitInbound).not.toHaveBeenCalled();
    expect(callbacks.onMessageCreate).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();
  });

  it('keeps the slot of a timed-out page download until the page settles', async () => {
    process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '100';
    // The adapter's limiter gets a spare slot, so only the room (one slot) can hold the second download.
    process.env.INBOUND_MEDIA_CONCURRENCY = '2';
    const h = heldProjector();
    const { client } = build(h.callbacks);
    process.env.INBOUND_MEDIA_CONCURRENCY = '1';
    const page = deferred<{ mimetype: string; data: string }>();
    const second = jest.fn().mockResolvedValue({ mimetype: 'image/png', data: 'QUJD' });
    client.emit(
      'message',
      incoming(
        'slow',
        '628111@c.us',
        jest.fn(() => page.promise),
      ),
    );
    client.emit('message', incoming('next', '628222@c.us', second));
    await sleep(150);
    // Emitted without media at its deadline and stored, but the page still works on the payload.
    expect(h.inserted()).toEqual(['slow']);
    expect(second).not.toHaveBeenCalled();

    page.resolve({ mimetype: 'image/png', data: 'QUJD' });
    await flush();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('emits the declared-only marker without a page download when no room comes free in time', async () => {
    process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '20';
    const h = heldProjector();
    h.stall('held');
    const seen: IncomingMessage[] = [];
    const onMessage = h.callbacks.onMessage!;
    const { client } = build({ ...h.callbacks, onMessage: (m, t) => (seen.push(m), onMessage(m, t)) });
    const late = jest.fn();
    client.emit(
      'message',
      incoming('held', '628111@c.us', jest.fn().mockResolvedValue({ mimetype: 'image/png', data: 'QUJD' })),
    );
    client.emit('message', incoming('late', '628222@c.us', late));
    await sleep(80);
    await flush();

    expect(late).not.toHaveBeenCalled();
    expect(seen.find(m => m.id === 'late')?.media).toEqual(expect.objectContaining({ omitted: true, sizeBytes: 3 }));
  });

  it('downloads nothing for media revoked while it waits for room, and stores it cleared', async () => {
    const h = heldProjector();
    const release = h.stall('held');
    const { client } = build(h.callbacks);
    const page = jest.fn().mockResolvedValue({ mimetype: 'image/png', data: 'QUJD' });
    client.emit(
      'message',
      incoming('held', '628111@c.us', jest.fn().mockResolvedValue({ mimetype: 'image/png', data: 'QUJD' })),
    );
    client.emit('message', incoming('gone', '628222@c.us', page));
    await flush();
    client.emit(
      'message_revoke_everyone',
      { id: { _serialized: 'rev' }, from: '628222@c.us', to: '628123@c.us', fromMe: false, timestamp: 2 },
      { id: { _serialized: 'gone' } },
    );
    await flush();

    expect(page).not.toHaveBeenCalled();
    expect(h.rows).toEqual([expect.objectContaining({ waMessageId: 'gone', body: '', type: 'revoked' })]);
    release();
    await flush();
    expect(h.announced()).toEqual(['held']);
  });

  it('downloads nothing for media granted room but revoked while its contact lookup is pending', async () => {
    process.env.INBOUND_MEDIA_CONCURRENCY = '2';
    const h = heldProjector();
    const { client } = build(h.callbacks);
    const contact = deferred<null>();
    const page = jest.fn().mockResolvedValue({ mimetype: 'image/png', data: 'QUJD' });
    client.emit('message', { ...incoming('gone', '628222@c.us', page), getContact: jest.fn(() => contact.promise) });
    await flush();
    client.emit(
      'message_revoke_everyone',
      { id: { _serialized: 'rev' }, from: '628222@c.us', to: '628123@c.us', fromMe: false, timestamp: 2 },
      { id: { _serialized: 'gone' } },
    );
    await flush();
    contact.resolve(null);
    await flush();

    expect(page).not.toHaveBeenCalled();
    expect(h.rows).toEqual([expect.objectContaining({ waMessageId: 'gone', body: '', type: 'revoked' })]);
    expect(h.announced()).toEqual([]);
  });

  it('bounds the page lookups of a held message, so its chat does not wait on a hung one', async () => {
    process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '20';
    const h = heldProjector();
    const { client } = build(h.callbacks);
    const hung = {
      ...incoming('hung', '628111@c.us'),
      getContact: jest.fn(() => new Promise(() => undefined)),
      hasQuotedMsg: true,
      getQuotedMessage: jest.fn(() => new Promise(() => undefined)),
    };
    client.emit('message', hung);
    client.emit('message', incoming('next', '628111@c.us', undefined, 'after'));
    await sleep(80);
    await flush();

    expect(h.inserted()).toEqual(['hung', 'next']);
  });

  it('still emits a message whose admission throws, without downloading its media', async () => {
    const h = heldProjector();
    const seen: IncomingMessage[] = [];
    const onMessage = h.callbacks.onMessage!;
    const { client } = build({
      ...h.callbacks,
      admitInbound: () => {
        throw new Error('boom');
      },
      onMessage: (m, t) => (seen.push(m), onMessage(m, t)),
    });
    const page = jest.fn().mockResolvedValue({ mimetype: 'image/png', data: 'QUJD' });
    client.emit('message', incoming('a', '628111@c.us', page));
    await flush();

    expect(page).not.toHaveBeenCalled();
    expect(seen[0]?.media).toEqual(expect.objectContaining({ omitted: true, sizeBytes: 3 }));
    expect(h.inserted()).toEqual(['a']);
  });

  it('gives the status seed and history no ticket: they download outside the room', async () => {
    const h = heldProjector();
    h.stall('held');
    const admitInbound = jest.fn(h.callbacks.admitInbound);
    const { adapter, client } = build({ ...h.callbacks, admitInbound });
    client.emit(
      'message',
      incoming('held', '628111@c.us', jest.fn().mockResolvedValue({ mimetype: 'image/png', data: 'QUJD' })),
    );
    await flush();
    admitInbound.mockClear();

    const page = jest.fn().mockResolvedValue({ mimetype: 'image/png', data: 'QUJD' });
    const capped = await (
      adapter as unknown as { capInboundMediaFor: (msg: unknown, max?: number) => Promise<unknown> }
    ).capInboundMediaFor(incoming('seed', 'status@broadcast', page), 1000);
    expect(capped).toEqual(expect.objectContaining({ data: 'QUJD' }));
    expect(admitInbound).not.toHaveBeenCalled();

    // Only the live message events take tickets; the seed and history callers pass none.
    const callers = readdirSync(__dirname)
      .filter(f => f.startsWith('wwebjs-') && f.endsWith('.ts') && !f.endsWith('.spec.ts'))
      .filter(f => readFileSync(join(__dirname, f), 'utf8').includes('admitInbound'));
    expect(callers).toEqual(['wwebjs-message-events.ts']);
  });

  it('holds the room for an own media echo until its row is written, so the next echo waits', async () => {
    const h = heldProjector();
    const release = h.stall('echo1');
    const { client } = build(h.callbacks);
    const first = jest.fn().mockResolvedValue({ mimetype: 'image/png', data: 'QUJD' });
    const second = jest.fn().mockResolvedValue({ mimetype: 'image/png', data: 'QUJD' });
    client.emit('message_create', ownEcho('echo1', '628111@c.us', first));
    client.emit('message_create', ownEcho('echo2', '628222@c.us', second));
    await flush();

    // One slot of room: the first payload waits for its insert, so the second page download has not started.
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    release();
    await flush();
    expect(second).toHaveBeenCalledTimes(1);
    expect(h.inserted()).toEqual(['echo1', 'echo2']);
  });

  it('commits an own text echo after the own media echo it arrived behind in its chat', async () => {
    const h = heldProjector();
    const { client } = build(h.callbacks);
    const page = deferred<{ mimetype: string; data: string }>();
    client.emit(
      'message_create',
      ownEcho(
        'echo-image',
        '628111@c.us',
        jest.fn(() => page.promise),
      ),
    );
    client.emit('message_create', ownEcho('echo-text', '628111@c.us', undefined, 'after'));
    await flush();
    // The text is processed meanwhile, but its hook and row wait for the image.
    expect(h.hookStarts).toEqual([]);
    expect(h.inserted()).toEqual([]);

    page.resolve({ mimetype: 'image/png', data: 'QUJD' });
    await flush();
    expect(h.hookStarts).toEqual(['echo-image', 'echo-text']);
    expect(h.inserted()).toEqual(['echo-image', 'echo-text']);
  });

  it('asks the room for a slot only for an own echo that downloads, and stores no status echo', async () => {
    const h = heldProjector();
    const admitInbound = jest.fn(h.callbacks.admitInbound);
    const { client } = build({ ...h.callbacks, admitInbound });
    const page = jest.fn().mockResolvedValue({ mimetype: 'image/png', data: 'QUJD' });
    client.emit('message_create', ownEcho('echo-image', '628111@c.us', page));
    client.emit('message_create', ownEcho('echo-status', 'status@broadcast', page));
    client.emit('message_create', ownEcho('echo-text', '628111@c.us', undefined, 'hi'));
    await flush();

    expect(admitInbound.mock.calls.map(([a]) => [a.id, a.status, a.needsRoom])).toEqual([
      ['echo-image', false, true],
      ['echo-status', true, false],
      ['echo-text', false, false],
    ]);
    expect(page).toHaveBeenCalledTimes(1);
    expect(h.inserted()).toEqual(['echo-image', 'echo-text']);
  });

  it('names whose message it is in the arrival', async () => {
    const h = heldProjector();
    const admitInbound = jest.fn(h.callbacks.admitInbound);
    const { client } = build({ ...h.callbacks, admitInbound });
    client.emit('message_create', ownEcho('mine', '628111@c.us', undefined, 'hi'));
    client.emit('message', incoming('theirs', '628111@c.us', undefined, 'hello'));
    await flush();

    expect(admitInbound.mock.calls.map(([a]) => [a.id, a.fromMe])).toEqual([
      ['mine', true],
      ['theirs', false],
    ]);
  });

  it('names the sender behind a group message in the arrival', async () => {
    const h = heldProjector();
    const admitInbound = jest.fn(h.callbacks.admitInbound);
    const { client } = build({ ...h.callbacks, admitInbound });
    client.emit('message', { ...incoming('grp', '120363000000000001@g.us', undefined, 'hi'), author: '628222@c.us' });
    client.emit('message', incoming('one', '628111@c.us', undefined, 'hello'));
    await flush();

    expect(admitInbound.mock.calls.map(([a]) => [a.id, a.fromMe, a.author])).toEqual([
      ['grp', false, '628222@c.us'],
      ['one', false, undefined],
    ]);
  });

  it('settles the ticket of an own echo its handler never takes, so the chat is not held up', async () => {
    const h = heldProjector();
    // The handler ignores the ticket it is handed: only the adapter's own settle can release it.
    const { client } = build({ ...h.callbacks, onMessageCreate: () => undefined });
    client.emit('message_create', ownEcho('echo', '628111@c.us'));
    client.emit('message', incoming('after', '628111@c.us', undefined, 'hello'));
    await flush();

    expect(h.inserted()).toEqual(['after']);
  });

  it.each<[string, boolean, number, Record<string, string>, boolean]>([
    ['an image', true, 3, {}, true],
    ['an image with media downloads disabled', true, 3, { MEDIA_DOWNLOAD_ENABLED: 'false' }, false],
    ['media declared over the cap', true, 5000, { MEDIA_DOWNLOAD_MAX_BYTES: '1000' }, false],
    ['a text', false, 0, {}, false],
  ])('plans a download for %s exactly when processing downloads it', async (_case, media, size, vars, planned) => {
    Object.assign(process.env, vars);
    const h = heldProjector();
    const admitInbound = jest.fn(h.callbacks.admitInbound);
    const { client } = build({ ...h.callbacks, admitInbound });
    const page = jest.fn().mockResolvedValue({ mimetype: 'image/png', data: 'QUJD' });
    const msg = { ...incoming('a', '628111@c.us', media ? page : undefined), _data: { mimetype: 'image/png', size } };

    expect(plannedInboundDownload(msg as unknown as WwebjsMessage)).toBe(planned);
    client.emit('message', msg);
    await flush();

    expect(admitInbound).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', needsRoom: planned }));
    expect(page).toHaveBeenCalledTimes(planned ? 1 : 0);
  });
});
