import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { HookManager } from '../../core/hooks';
import { Session } from '../session/entities/session.entity';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import { MessageSendService } from './message-send.service';
import { SendPacingService } from './send-pacing.service';
import { computeSendPacingConfig } from './send-pacing.config';
import { PendingMessageReaperService } from './pending-message-reaper.service';

/**
 * The pending reaper tells a stranded PENDING row from a live send by age alone, and MESSAGE_REAPER_GRACE_MS=0
 * is accepted ("act on a row as soon as it is seen"). A sweep during a media send fails the row and drops its
 * payload. When the own-send echo already holds the id and its metadata merge fails, the send keeps its own row
 * instead, "so the pending reaper cannot strip successfully sent media", and that row has to come out SENT with its
 * payload whether the sweep landed before the send's own SENT write or while the merge was being tried.
 */
describe.each([
  ['during the engine call', 'engine'],
  ['while the merge onto the echo row is tried', 'merge'],
] as const)('a media send reaped %s, whose echo merge then fails', (_when, sweepAt) => {
  const ID = '3EB0C0FFEE000001';
  let ds: DataSource;
  let messages: Repository<Message>;
  let sender: MessageSendService;
  let reaper: PendingMessageReaperService;

  /** A sweep with a zero grace, as MESSAGE_REAPER_GRACE_MS=0 would run it. */
  const sweep = (): Promise<unknown> =>
    reaper.sweep({ intervalMs: 600_000, graceMs: 0, batchSize: 50 }, new Date(Date.now() + 1000));

  beforeEach(async () => {
    process.env.SIMULATE_TYPING = 'false';
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message],
      synchronize: true,
    });
    await ds.initialize();
    const sessions = ds.getRepository(Session);
    await sessions.save({ id: 's1', name: 'sender', createdAt: new Date() });
    messages = ds.getRepository(Message);
    const config = {
      get: (key: string) => (key === 'sendPacing' ? { ...computeSendPacingConfig({}), enabled: false } : undefined),
    } as ConfigService;
    const hooks = new HookManager();
    reaper = new PendingMessageReaperService(messages, hooks);
    const engines = new EngineRegistry();
    const engine = {
      sendImageMessage: jest.fn(async () => {
        if (sweepAt === 'engine') await sweep();
        // The own-send echo wins the id, carrying only a media marker, as a Baileys API-send echo does.
        await messages.insert({
          sessionId: 's1',
          waMessageId: ID,
          chatId: '628111@c.us',
          from: '628999@c.us',
          to: '628111@c.us',
          type: 'image',
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENT,
          metadata: { media: { mimetype: 'image/jpeg', omitted: true } },
        });
        return { id: ID, timestamp: 1_786_000_000 };
      }),
    };
    engines.set('s1', engine as unknown as IWhatsAppEngine);
    sender = new MessageSendService(
      messages,
      { findOne: (id: string) => sessions.findOneBy({ id }) } as never,
      engines,
      hooks,
      {} as never,
      new SendPacingService(messages, sessions, config),
      config,
    );
    // The echo row's metadata cannot be merged (a write that keeps failing).
    const update = messages.update.bind(messages);
    jest.spyOn(messages, 'update').mockImplementation(async (where, patch) => {
      if (where && typeof where === 'object' && 'metadata' in (where as object)) {
        if (sweepAt === 'merge') await sweep();
        throw new Error('database is locked');
      }
      return update(where, patch);
    });
  });

  afterEach(async () => {
    delete process.env.SIMULATE_TYPING;
    jest.restoreAllMocks();
    await reaper.onModuleDestroy();
    await ds.destroy();
  });

  it('keeps the sent media on a row that is not FAILED', async () => {
    const response = await sender.sendImage('s1', {
      chatId: '628111@c.us',
      base64: 'QkFTRTY0UEFZTE9BRA==',
      mimetype: 'image/jpeg',
    });

    expect(response).toEqual({ messageId: ID, timestamp: 1_786_000_000 });
    const rows = await messages.find({ where: { sessionId: 's1' }, order: { createdAt: 'ASC' } });
    const state = rows.map(row => ({
      waMessageId: row.waMessageId ?? null,
      status: row.status,
      bytes: (row.metadata as { media?: { data?: string } } | null)?.media?.data === 'QkFTRTY0UEFZTE9BRA==',
    }));
    // One row may carry the sent bytes, and it is not reported as a failed send.
    expect(state.filter(row => row.bytes)).toEqual([expect.objectContaining({ status: MessageStatus.SENT })]);
    expect(state.filter(row => row.status === MessageStatus.FAILED)).toEqual([]);
  });
});
