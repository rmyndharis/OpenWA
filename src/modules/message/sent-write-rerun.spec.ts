import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { HookManager } from '../../core/hooks';
import { RecoveryJournal } from '../../common/utils/recovery-journal';
import {
  RECOVERY_MAX_AGE_MS,
  RECOVERY_MAX_BYTES,
  RECOVERY_MAX_RECORDS,
  RecoveryQueue,
} from '../../common/utils/recovery-queue';
import { Session } from '../session/entities/session.entity';
import { MessageProjector } from '../session/message-projector.service';
import type { SessionLidResolver } from '../session/session-lid-resolver.service';
import type { StatusStoreService } from '../status-store/status-store.service';
import type { EventsGateway } from '../events/events.gateway';
import type { WebhookService } from '../webhook/webhook.service';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { MessageSendService } from './message-send.service';
import { MessageService } from './message.service';
import { SendPacingService } from './send-pacing.service';
import { computeSendPacingConfig } from './send-pacing.config';
import { PendingMessageReaperService } from './pending-message-reaper.service';

/**
 * WhatsApp accepted a send, and the database then refused the write that records it as sent. That write is kept and
 * run again once the database answers, ahead of the changes kept for messages: the row of a single send already holds
 * the media, so only the patch is kept, and a bulk item keeps its whole insert. Meanwhile the pending reaper leaves the
 * row alone, a change naming the message waits for it rather than reading no row, and the journal keeps the write
 * across a restart.
 *
 * Real SQLite, both message services, the projector and the reaper; the engine can store the echo row before it
 * answers, or the test stores it afterwards.
 */
const ID = '3EB0C0FFEE000001';
const BYTES = 'QkFTRTY0UEFZTE9BRA==';
const PHONE = '628111@c.us';
const LID = '484848484848@lid';
const unavailable = () => Object.assign(new Error('SQLITE_IOERR: disk I/O error'), { code: 'SQLITE_IOERR' });

describe('the SENT write of a send the database refused', () => {
  let ds: DataSource;
  let messages: Repository<Message>;
  let sessions: Repository<Session>;
  let hooks: HookManager;
  let engines: EngineRegistry;
  let journalDir: string;
  let queues: RecoveryQueue[];
  let echoInside: boolean;
  /** Run while the engine is answering, before the send path writes anything (a receipt that arrives that early). */
  let whileAnswering: (() => Promise<void>) | undefined;
  /** SENT writes (the guarded update of a single send, the insert of a bulk item) that fail before one lands. */
  let sentWriteFails: number;

  const echo = () =>
    messages.insert({
      sessionId: 's1',
      waMessageId: ID,
      chatId: PHONE,
      from: '628999@c.us',
      to: PHONE,
      type: 'image',
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      metadata: { media: { mimetype: 'image/jpeg', omitted: true } },
    });
  const rows = async () =>
    (await messages.find({ where: { sessionId: 's1' }, order: { createdAt: 'ASC' } })).map(row => ({
      waMessageId: row.waMessageId ?? null,
      status: row.status,
      bytes: (row.metadata as { media?: { data?: string } } | null)?.media?.data === BYTES,
      reactions: (row.metadata as { reactions?: Record<string, string> } | null)?.reactions,
    }));

  /** One process: its queue (with the journal in `journalDir`), projector, send service, message service and reaper. */
  const start = () => {
    const queue = new RecoveryQueue({
      maxBytes: RECOVERY_MAX_BYTES,
      maxRecords: { ...RECOVERY_MAX_RECORDS },
      maxAgeMs: {
        send: RECOVERY_MAX_AGE_MS,
        receive: RECOVERY_MAX_AGE_MS,
        change: RECOVERY_MAX_AGE_MS,
        dispatch: RECOVERY_MAX_AGE_MS,
      },
      // Only the test's own flush runs a pass.
      baseDelayMs: 600_000,
      capDelayMs: 600_000,
      journal: new RecoveryJournal(join(journalDir, 'recovery-journal.jsonl')),
    });
    queues.push(queue);
    const webhooks = new Proxy(
      { dispatch: jest.fn().mockResolvedValue(undefined), recoveryQueue: () => queue },
      { get: (target, key) => (key in target ? target[key as keyof typeof target] : () => Promise.resolve(undefined)) },
    );
    const projector = new MessageProjector(
      messages,
      sessions,
      engines,
      new Proxy({}, { get: () => () => undefined }) as unknown as EventsGateway,
      webhooks as unknown as WebhookService,
      hooks,
      { ingest: jest.fn() } as unknown as StatusStoreService,
      { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
    );
    const config = {
      get: (key: string) => (key === 'sendPacing' ? { ...computeSendPacingConfig({}), enabled: false } : undefined),
    } as ConfigService;
    const pacing = new SendPacingService(messages, sessions, config);
    const sender = new MessageSendService(
      messages,
      { findOne: (id: string) => sessions.findOneBy({ id }) } as never,
      engines,
      hooks,
      {} as never,
      pacing,
      config,
      undefined,
      undefined,
      projector,
    );
    const lids = { findPhoneForLid: () => Promise.resolve(null), findLidsForPhone: () => Promise.resolve([]) };
    const service = new MessageService(messages, engines, projector, hooks, lids as never, pacing, sender);
    const reaper = new PendingMessageReaperService(messages, hooks, sender);
    queue.ready();
    return { queue, projector, sender, service, reaper };
  };
  const sweep = (reaper: PendingMessageReaperService) =>
    reaper.sweep({ intervalMs: 600_000, graceMs: 0, batchSize: 50 }, new Date(Date.now() + 1000));

  beforeEach(async () => {
    process.env.SIMULATE_TYPING = 'false';
    echoInside = true;
    whileAnswering = undefined;
    sentWriteFails = 0;
    queues = [];
    journalDir = mkdtempSync(join(tmpdir(), 'sent-write-rerun-'));
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message],
      synchronize: true,
    });
    await ds.initialize();
    sessions = ds.getRepository(Session);
    await sessions.save({ id: 's1', name: 'sender', createdAt: new Date() });
    messages = ds.getRepository(Message);
    hooks = new HookManager();
    engines = new EngineRegistry();
    engines.set('s1', {
      sendImageMessage: jest.fn(async () => {
        if (echoInside) await echo();
        await whileAnswering?.();
        return { id: ID, timestamp: 1_786_000_000 };
      }),
    } as unknown as IWhatsAppEngine);
    const update = messages.update.bind(messages);
    jest.spyOn(messages, 'update').mockImplementation(async (where, patch) => {
      if (sentWriteFails > 0 && (where as { status?: string }).status === MessageStatus.PENDING) {
        sentWriteFails--;
        throw unavailable();
      }
      return update(where, patch);
    });
    const save = messages.save.bind(messages) as (entity: Message, options?: object) => Promise<Message>;
    jest.spyOn(messages, 'save').mockImplementation((async (entity: Message, options?: object) => {
      if (sentWriteFails > 0 && entity.waMessageId) {
        sentWriteFails--;
        throw unavailable();
      }
      return save(entity, options);
    }) as never);
  });

  afterEach(async () => {
    delete process.env.SIMULATE_TYPING;
    jest.restoreAllMocks();
    for (const queue of queues) await queue.drain(0);
    await ds.destroy();
    rmSync(journalDir, { recursive: true, force: true });
  });

  it.each([
    ['the echo row is stored before the engine answers', true],
    ['the echo row is stored after the engine answered', false],
  ])('leaves one SENT row with the bytes once it is written again, when %s', async (_order, inside) => {
    const { queue, sender, service, reaper } = start();
    echoInside = inside;
    sentWriteFails = 1;

    await expect(sender.sendImage('s1', { chatId: PHONE, base64: BYTES, mimetype: 'image/jpeg' })).resolves.toEqual({
      messageId: ID,
      timestamp: 1_786_000_000,
    });
    if (!inside) await echo();
    await queue.flush();
    await sweep(reaper);

    expect(await rows()).toEqual([{ waMessageId: ID, status: 'sent', bytes: true, reactions: undefined }]);
    await expect(service.getChatMedia('s1', PHONE, ID)).resolves.toMatchObject({ size: 13 });
  });

  it('leaves the row to its SENT write in a sweep while the database still refuses it', async () => {
    const { queue, sender, reaper } = start();
    echoInside = false;
    sentWriteFails = 2;

    await sender.sendImage('s1', { chatId: PHONE, base64: BYTES, mimetype: 'image/jpeg' });
    await queue.flush();
    expect(sentWriteFails).toBe(0);
    await sweep(reaper);
    expect(await rows()).toEqual([{ waMessageId: null, status: 'pending', bytes: true, reactions: undefined }]);

    await queue.flush();

    expect(await rows()).toEqual([{ waMessageId: ID, status: 'sent', bytes: true, reactions: undefined }]);
  });

  it('keeps the SENT write across a restart, the row left alone by the new process until it is written', async () => {
    const first = start();
    echoInside = false;
    sentWriteFails = 1;
    await first.sender.sendImage('s1', { chatId: PHONE, base64: BYTES, mimetype: 'image/jpeg' });

    const second = start();
    await sweep(second.reaper);
    expect(await rows()).toEqual([{ waMessageId: null, status: 'pending', bytes: true, reactions: undefined }]);
    await second.queue.flush();

    expect(await rows()).toEqual([{ waMessageId: ID, status: 'sent', bytes: true, reactions: undefined }]);
  });

  it('holds a change naming the message until the SENT write lands, rather than reading no row', async () => {
    const { queue, projector, sender } = start();
    echoInside = false;
    sentWriteFails = 1;
    await sender.sendImage('s1', { chatId: PHONE, base64: BYTES, mimetype: 'image/jpeg' });

    projector.applyReactionQueued('s1', { messageId: ID, chatId: PHONE, reaction: '+', senderId: PHONE });
    // The reaction is judged, on the message's chain, before the SENT write runs again.
    await new Promise<void>(resolve => projector.enqueueMessageMutation('s1', ID, () => Promise.resolve(resolve())));
    expect(await rows()).toEqual([{ waMessageId: null, status: 'pending', bytes: true, reactions: undefined }]);
    await queue.flush();

    expect(await rows()).toEqual([{ waMessageId: ID, status: 'sent', bytes: true, reactions: { [PHONE]: '+' } }]);
  });

  it('keeps a delivery receipt for the message until the SENT write lands, rather than dropping it after one retry', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const { queue, projector, sender } = start();
      echoInside = false;
      sentWriteFails = 1;
      await sender.sendImage('s1', { chatId: PHONE, base64: BYTES, mimetype: 'image/jpeg' });
      const engine = engines.get('s1')!;

      projector.handleMessageAck('s1', engine, ID, 'read', PHONE);
      await new Promise<void>(resolve => projector.enqueueMessageMutation('s1', ID, () => Promise.resolve(resolve())));
      // The one retry of an ack that matched no row has come and gone.
      await jest.advanceTimersByTimeAsync(10_000);
      expect((await rows())[0]).toMatchObject({ waMessageId: null, status: 'pending' });
      await queue.flush();

      expect(await rows()).toEqual([{ waMessageId: ID, status: 'read', bytes: true, reactions: undefined }]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a delivery receipt whose first try came before the SENT write was refused, from its retry', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const { queue, projector, sender } = start();
      echoInside = false;
      sentWriteFails = 1;
      whileAnswering = async () => {
        projector.handleMessageAck('s1', engines.get('s1')!, ID, 'read', PHONE);
        // Its first try finds no row and nothing kept for the send yet: only the one retry is left.
        await new Promise<void>(resolve =>
          projector.enqueueMessageMutation('s1', ID, () => Promise.resolve(resolve())),
        );
      };

      await sender.sendImage('s1', { chatId: PHONE, base64: BYTES, mimetype: 'image/jpeg' });
      await jest.advanceTimersByTimeAsync(10_000);
      expect((await rows())[0]).toMatchObject({ waMessageId: null, status: 'pending' });
      await queue.flush();

      expect(await rows()).toEqual([{ waMessageId: ID, status: 'read', bytes: true, reactions: undefined }]);
    } finally {
      jest.useRealTimers();
    }
  });

  // A kept receipt is judged as a receipt is, against the row read: a lid and a phone number with no reported pairing
  // prove nothing, so a receipt from the lid a send went to, which an engine that reports no delivered chat leaves
  // unrecorded on the row, still advances it.
  it.each([
    ['from the unpaired lid of a send addressed to the phone number', PHONE, LID, 'read'],
    ['from the unpaired phone number of a send addressed to the lid', LID, PHONE, 'read'],
    ['from a recipient of a send to a broadcast list', '1700000002@broadcast', PHONE, 'read'],
    ['from another phone number', PHONE, '628999@c.us', 'sent'],
    ['from a group', PHONE, '120363000000000001@g.us', 'sent'],
  ])('judges a kept receipt %s as a receipt', async (_case, chatId, receiptChat, status) => {
    const { queue, projector, sender } = start();
    echoInside = false;
    sentWriteFails = 1;
    await sender.sendImage('s1', { chatId, base64: BYTES, mimetype: 'image/jpeg' });

    projector.handleMessageAck('s1', engines.get('s1')!, ID, 'read', receiptChat);
    await new Promise<void>(resolve => projector.enqueueMessageMutation('s1', ID, () => Promise.resolve(resolve())));
    await queue.flush();

    expect(await rows()).toEqual([{ waMessageId: ID, status, bytes: true, reactions: undefined }]);
  });

  it('drops the SENT writes of a removed session, writing nothing for it', async () => {
    const { queue, projector, sender } = start();
    echoInside = false;
    sentWriteFails = 2;
    await sender.sendImage('s1', { chatId: PHONE, base64: BYTES, mimetype: 'image/jpeg' });
    const [row] = await messages.find();
    await expect(
      sender.saveOutgoingMessage('s1', {
        waMessageId: 'BULK-1',
        chatId: PHONE,
        type: 'text',
        status: MessageStatus.SENT,
        timestamp: 1_786_000_000,
      }),
    ).rejects.toThrow('SQLITE_IOERR');
    expect(sender.hasPendingSentWrite(row.id)).toBe(true);

    projector.forgetSession('s1');
    await queue.flush();

    expect(sender.hasPendingSentWrite(row.id)).toBe(false);
    expect(await rows()).toEqual([{ waMessageId: null, status: 'pending', bytes: true, reactions: undefined }]);
  });

  it('inserts a bulk item again once the database answers', async () => {
    const { queue, sender } = start();
    sentWriteFails = 1;

    await expect(
      sender.saveOutgoingMessage('s1', {
        waMessageId: ID,
        chatId: PHONE,
        type: 'image',
        status: MessageStatus.SENT,
        timestamp: 1_786_000_000,
        metadata: { media: { mimetype: 'image/jpeg', data: BYTES } },
      }),
    ).rejects.toThrow('SQLITE_IOERR');
    expect(await rows()).toEqual([]);
    await queue.flush();

    expect(await rows()).toEqual([{ waMessageId: ID, status: 'sent', bytes: true, reactions: undefined }]);
  });

  it('keeps the SENT write of a template send, which goes out as a text', async () => {
    const { queue, sender } = start();
    const engine = engines.get('s1') as unknown as Record<string, unknown>;
    engine.sendTextMessage = jest.fn().mockResolvedValue({ id: ID, timestamp: 1_786_000_000 });
    (sender as unknown as { templateService: unknown }).templateService = {
      resolve: () => Promise.resolve({ body: 'Hello {{name}}' }),
    };
    sentWriteFails = 1;

    await sender.sendTemplate('s1', { templateId: 'welcome', chatId: PHONE, vars: { name: 'Ana' } });
    expect(sender.hasPendingSentWrite((await messages.findOneByOrFail({ body: 'Hello Ana' })).id)).toBe(true);
    await queue.flush();

    expect(await messages.findOneByOrFail({ waMessageId: ID })).toMatchObject({
      status: MessageStatus.SENT,
      body: 'Hello Ana',
    });
  });
});
