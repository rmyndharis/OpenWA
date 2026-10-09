import { EventEmitter } from 'events';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WAState } from 'whatsapp-web.js';
import type { Repository } from 'typeorm';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import { BaileysEvents, type BaileysEventsHost } from './baileys-events';
import { WhatsAppWebJsAdapter } from './whatsapp-web-js.adapter';
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

/** The real projector over a stand-in `messages` table whose inserts a test can stall per message. */
function heldProjector() {
  const rows: Row[] = [];
  const hookStarts: string[] = [];
  const hookedBodies: Record<string, string> = {};
  const stalls = new Map<string, Promise<void>>();
  const repo = {
    manager: { connection: { options: { type: 'postgres' } } },
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(rows.find(r => r.waMessageId === where.waMessageId) ?? null),
    ),
    create: jest.fn((x: Row) => ({ ...x })),
    insert: jest.fn(async (row: Row) => {
      await stalls.get(String(row.waMessageId));
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
    admitInbound: a => projector.admitInbound('s1', e, a),
    onMessage: (m, t) => projector.handleInboundMessage('s1', e, m, t),
    onMessageCreate: (m, t) => projector.handleOwnSendEcho('s1', e, m, t),
    onMessageRevoked: m => projector.handleMessageRevoked('s1', e, m),
    onMessageEdited: m => projector.applyMessageEditQueued('s1', m),
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
  } as unknown as Awaited<ReturnType<BaileysEventsHost['loadLib']>>;

  const stream = (bytes = 3) => ({
    // eslint-disable-next-line @typescript-eslint/require-await
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(bytes, 1);
    },
    destroy: jest.fn(),
  });

  const build = (concurrency: number, callbacks?: EngineEventCallbacks) => {
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
        callbacks?.onMessage?.(m, t);
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
    } as unknown as BaileysEventsHost;
    return { events: new BaileysEvents(host), emitted, recordKeyLidMappings };
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
      await fillRoom(h, events);

      // K media waiting for room would hold every limiter slot if they did not give theirs up.
      upsert(events, ...Array.from({ length: k }, (_, i) => media(`W${i}`, `wait${i}@s.whatsapp.net`)));
      upsert(events, text('T', 'other@s.whatsapp.net'));
      await flush();

      expect(emitted).toContain('T');
      expect(h.inserted()).toEqual(['T']);
      expect(downloadMediaMessage).toHaveBeenCalledTimes(k);
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
    ['from another chat', { remoteJid: 'other@s.whatsapp.net', fromMe: false }],
    ['from the wrong author', { remoteJid: 'chat@s.whatsapp.net', fromMe: true }],
  ])('ignores a delete and an edit %s aimed at media waiting for room', async (_, envelope) => {
    process.env.INBOUND_MEDIA_CONCURRENCY = '1';
    const h = heldProjector();
    const { events } = build(4, h.callbacks);
    const release = h.stall('H');
    upsert(
      events,
      media('H', 'hold@s.whatsapp.net'),
      media('MREV', 'chat@s.whatsapp.net', { caption: 'real caption' }),
      media('MEDIT', 'chat@s.whatsapp.net', { caption: 'real caption 2' }),
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
      release = h.stall('H');
      callbacks = { ...h.callbacks, onMessageReaction };
    } else {
      // No admission callback, as SQLite wires the engine: M is held only by its own download.
      release = () => download.resolve();
      downloadMediaMessage.mockImplementation(() => download.promise.then(() => stream()));
      callbacks = { onMessage: jest.fn(), onMessageReaction };
    }
    const { events } = build(4, callbacks);
    const chat = 'chat@s.whatsapp.net';
    upsert(events, ...(admitted ? [media('H', 'hold@s.whatsapp.net')] : []), media('M', chat));
    await flush();
    const react = (id: string, remoteJid: string, text: string): WAMessage => ({
      key: { id, remoteJid, fromMe: false },
      messageTimestamp: 1_700_000_001,
      message: { reactionMessage: { key: { id: 'M', remoteJid, fromMe: false }, text } },
    });
    upsert(events, react('R1', 'other@s.whatsapp.net', 'forged'), react('R2', chat, 'genuine'));
    await flush();
    release();
    await flush();

    expect(reactions).toEqual([expect.objectContaining({ messageId: 'M', chatId: chat, reaction: 'genuine' })]);
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
    (adapter as unknown as { setupEventHandlers: () => void }).setupEventHandlers();
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
          { id: { _serialized: 't2' }, from: '628111@c.us', to: '628123@c.us', type: 'chat', fromMe: false },
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
});
