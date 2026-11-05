import { DataSource } from 'typeorm';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { Message } from '../message/entities/message.entity';
import { Session } from './entities/session.entity';
import { MessageProjector } from './message-projector.service';
import type { EventsGateway } from '../events/events.gateway';
import type { WebhookService } from '../webhook/webhook.service';
import type { HookManager } from '../../core/hooks';
import type { StatusStoreService } from '../status-store/status-store.service';
import type { SessionLidResolver } from './session-lid-resolver.service';

/**
 * `sessions.lastActiveAt` is read only by the session response (`lastActive`). Writing it, and with it the
 * `@UpdateDateColumn`, once per message turns a session's message rate into the same rate of writes on its one
 * session row: an extra serialized write per message on SQLite, a dead tuple per message on PostgreSQL. A burst
 * stamps the row once, and the stamp is still there for the response to read.
 */
describe('session activity writes during a message burst', () => {
  let db: DataSource;

  afterEach(() => db?.destroy());

  it('stamps the session row once for a burst of messages', async () => {
    db = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message, Session],
      synchronize: true,
    });
    await db.initialize();
    const sessions = db.getRepository(Session);
    await sessions.save({ id: 's1', name: 'busy', config: {} });
    const update = jest.spyOn(sessions, 'update');
    const engines = new EngineRegistry();
    const engine = { tag: 'burst' } as unknown as IWhatsAppEngine;
    engines.set('s1', engine);
    const projector = new MessageProjector(
      db.getRepository(Message),
      sessions,
      engines,
      { emitMessage: jest.fn() } as unknown as EventsGateway,
      { dispatch: jest.fn().mockResolvedValue(undefined) } as unknown as WebhookService,
      {
        execute: jest.fn((_e: string, data: unknown) => Promise.resolve({ continue: true, data })),
      } as unknown as HookManager,
      {} as StatusStoreService,
      {} as SessionLidResolver,
    );

    for (let i = 0; i < 50; i++) {
      projector.handleInboundMessage('s1', engine, {
        id: `IN${i}`,
        from: '628111@c.us',
        to: '628999@c.us',
        chatId: '628111@c.us',
        body: `message ${i}`,
        type: 'text',
        timestamp: 1_786_000_000 + i,
        fromMe: false,
        isGroup: false,
        kind: 'individual',
      });
    }
    await new Promise(resolve => setTimeout(resolve, 200));

    const activityWrites = update.mock.calls.filter(([, patch]) => 'lastActiveAt' in (patch as object)).length;
    expect(activityWrites).toBe(1);
    expect((await sessions.findOneByOrFail({ id: 's1' })).lastActiveAt).toBeInstanceOf(Date);
  });
});
