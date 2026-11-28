import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { HookManager } from '../../core/hooks';
import { RecoveryJournal } from '../../common/utils/recovery-journal';
import { LoggerService } from '../../common/services/logger.service';
import type { PluginLoaderService } from '../../core/plugins/plugin-loader.service';
import { Session } from '../session/entities/session.entity';
import { MessageProjector } from '../session/message-projector.service';
import type { SessionLidResolver } from '../session/session-lid-resolver.service';
import type { StatusStoreService } from '../status-store/status-store.service';
import type { EventsGateway } from '../events/events.gateway';
import type { WebhookService } from '../webhook/webhook.service';
import { WebhookOutboxService } from '../webhook/webhook-outbox.service';
import { WebhookDeliveryService } from '../webhook/webhook-delivery.service';
import { Message, MessageStatus } from './entities/message.entity';
import { MessageSendService } from './message-send.service';
import { SendPacingService } from './send-pacing.service';
import { computeSendPacingConfig } from './send-pacing.config';
import { PendingMessageReaperService } from './pending-message-reaper.service';

const ID = '3EB0C0FFEE000002';
const BYTES = 'QkFTRTY0UEFZTE9BRA==';
const PHONE = '628111@c.us';

/**
 * A send WhatsApp accepted whose SENT write the database refused, and a delivery receipt for it that came while that
 * write waited, kept with the message's changes: the process crashes, and a new one starts with its plugins still
 * coming back. Its journal brings both back; the reaper leaves the row alone meanwhile, and once the plugins are back
 * and the database answers, the row is written SENT with its bytes and then advanced by the receipt.
 *
 * Real SQLite and journal file, the queue owned by the delivery service as in the application (tried once the plugin
 * restore is over), the projector, the send service and the reaper.
 */
describe('a kept SENT write and a receipt for it, across a crash with plugins still restoring', () => {
  let ds: DataSource;
  let messages: Repository<Message>;
  let sessions: Repository<Session>;
  let engines: EngineRegistry;
  let dir: string;
  // The database refuses the SENT write of a send while set.
  let refusing: boolean;
  let processes: Array<ReturnType<typeof start>>;

  const rows = async () =>
    (await messages.find({ where: { sessionId: 's1' } })).map(row => ({
      waMessageId: row.waMessageId ?? null,
      status: row.status,
      bytes: (row.metadata as { media?: { data?: string } } | null)?.media?.data === BYTES,
    }));
  const journalLines = (): Array<{ l: string; v: Record<string, unknown> }> =>
    readFileSync(join(dir, 'recovery-journal.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { l: string; v: Record<string, unknown> });

  /** One process, with its plugin restore settling once `plugins` does. */
  const start = (plugins: Promise<void> = Promise.resolve()) => {
    const hooks = new HookManager();
    const journal = new RecoveryJournal(join(dir, 'recovery-journal.jsonl'));
    const outbox = new WebhookOutboxService({} as never, journal);
    const delivery = new WebhookDeliveryService(
      {} as never,
      {} as never,
      { get: (_key: string, def?: unknown) => def } as unknown as ConfigService,
      hooks,
      outbox,
      undefined,
      undefined,
      journal,
      { whenRestored: () => plugins } as unknown as PluginLoaderService,
    );
    const queue = delivery.recoveryQueue();
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
    const sender = new MessageSendService(
      messages,
      { findOne: (id: string) => sessions.findOneBy({ id }) } as never,
      engines,
      hooks,
      {} as never,
      new SendPacingService(messages, sessions, config),
      config,
      undefined,
      undefined,
      projector,
    );
    const reaper = new PendingMessageReaperService(messages, hooks, sender);
    delivery.onApplicationBootstrap();
    return { journal, queue, delivery, projector, sender, reaper };
  };

  /** The process dies: no pass of its own runs again, and nothing it holds reaches the journal the next one opens. */
  const crash = (process: ReturnType<typeof start>): void => {
    const queue = process.queue as unknown as { stopped: Set<string>; timer?: ReturnType<typeof setTimeout> };
    clearTimeout(queue.timer);
    for (const lane of ['send', 'change', 'dispatch']) queue.stopped.add(lane);
    process.journal.close();
    process.journal.put = () => false;
    process.journal.del = () => undefined;
  };
  const sweep = (reaper: PendingMessageReaperService) =>
    reaper.sweep({ intervalMs: 600_000, graceMs: 0, batchSize: 50 }, new Date(Date.now() + 1000));
  const chainSettled = (projector: MessageProjector) =>
    new Promise<void>(resolve => projector.enqueueMessageMutation('s1', ID, () => Promise.resolve(resolve())));

  beforeEach(async () => {
    process.env.SIMULATE_TYPING = 'false';
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => undefined);
    refusing = false;
    processes = [];
    dir = mkdtempSync(join(tmpdir(), 'sent-write-restart-'));
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Message],
      synchronize: true,
    }).initialize();
    sessions = ds.getRepository(Session);
    await sessions.save({ id: 's1', name: 'sender', createdAt: new Date() });
    messages = ds.getRepository(Message);
    engines = new EngineRegistry();
    engines.set('s1', {
      sendImageMessage: jest.fn().mockResolvedValue({ id: ID, timestamp: 1_786_000_000 }),
    } as unknown as IWhatsAppEngine);
    const update = messages.update.bind(messages);
    jest.spyOn(messages, 'update').mockImplementation(async (where, patch) => {
      if (refusing && (where as { status?: string }).status === MessageStatus.PENDING) {
        throw Object.assign(new Error('SQLITE_IOERR: disk I/O error'), { code: 'SQLITE_IOERR' });
      }
      return update(where, patch);
    });
  });

  afterEach(async () => {
    delete process.env.SIMULATE_TYPING;
    for (const { delivery, journal } of processes) {
      await delivery.onModuleDestroy();
      journal.close();
    }
    jest.restoreAllMocks();
    await ds.destroy();
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves the row to the new process, then writes it SENT with its bytes and advances it by the receipt', async () => {
    const first = start();
    processes.push(first);
    refusing = true;
    await first.sender.sendImage('s1', { chatId: PHONE, base64: BYTES, mimetype: 'image/jpeg' });
    first.projector.handleMessageAck('s1', engines.get('s1')!, ID, 'read', PHONE);
    await chainSettled(first.projector);
    // The SENT write in the send lane, and the receipt in the change lane, judged naming no chat.
    expect(journalLines().map(line => line.l)).toEqual(['send', 'change']);
    expect(journalLines()[1].v.acks).toEqual({ judge: { kind: 'reaction', chatId: '' }, acks: [[PHONE, 'read']] });
    crash(first);

    let pluginsBack!: () => void;
    const second = start(new Promise<void>(resolve => (pluginsBack = resolve)));
    processes.push(second);
    refusing = false;
    await sweep(second.reaper);
    await second.queue.flush();
    // The plugins are still coming back: nothing is tried, and the reaper leaves the row and its media alone.
    expect(await rows()).toEqual([{ waMessageId: null, status: 'pending', bytes: true }]);

    pluginsBack();
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    await second.queue.flush();
    await sweep(second.reaper);

    expect(await rows()).toEqual([{ waMessageId: ID, status: 'read', bytes: true }]);
    expect(readFileSync(join(dir, 'recovery-journal.jsonl'), 'utf8')).toBe('');
  });
});
