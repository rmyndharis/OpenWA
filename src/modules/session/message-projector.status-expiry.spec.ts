import type { Repository } from 'typeorm';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IncomingMessage, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import type { HookManager } from '../../core/hooks';
import type { EventsGateway } from '../events/events.gateway';
import type { Message } from '../message/entities/message.entity';
import type { StatusStoreService } from '../status-store/status-store.service';
import type { StatusUpdate } from '../status-store/entities/status-update.entity';
import type { WebhookService } from '../webhook/webhook.service';
import { MessageProjector } from './message-projector.service';
import type { SessionLidResolver } from './session-lid-resolver.service';
import type { Session } from './entities/session.entity';

const status: IncomingMessage = {
  id: 'st1',
  chatId: 'status@broadcast',
  from: 'status@broadcast',
  to: '620000@c.us',
  author: '628111@c.us',
  fromMe: false,
  isStatusBroadcast: true,
  body: 'hi',
  type: 'text',
  timestamp: 1_700_000_000,
  isGroup: false,
  kind: 'status',
};

describe('status.received for a status that was ingested', () => {
  const run = async (expiresAt: number, created = true) => {
    const engines = new EngineRegistry();
    const engine = {} as IWhatsAppEngine;
    engines.set('s1', engine);
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const emitStatusReceived = jest.fn();
    const row = { waStatusId: 'st1', contactJid: '628111@c.us', type: 'text', mediaOmitted: false, expiresAt };
    const projector = new MessageProjector(
      {} as Repository<Message>,
      {} as Repository<Session>,
      engines,
      { emitStatusReceived } as unknown as EventsGateway,
      { dispatch } as unknown as WebhookService,
      {} as HookManager,
      { ingest: jest.fn().mockResolvedValue({ row: row as StatusUpdate, created }) } as unknown as StatusStoreService,
      {} as SessionLidResolver,
    );
    await projector.handleInboundMessage('s1', engine, status)?.settled;
    return { dispatch, emitStatusReceived };
  };

  it('announces a status that is still live', async () => {
    const { dispatch, emitStatusReceived } = await run(Date.now() + 60_000);
    expect(dispatch).toHaveBeenCalledWith('s1', 'status.received', expect.objectContaining({ statusId: 'st1' }));
    expect(emitStatusReceived).toHaveBeenCalledTimes(1);
  });

  it('announces nothing for a status that expired while it was being ingested', async () => {
    const { dispatch, emitStatusReceived } = await run(Date.now() - 1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(emitStatusReceived).not.toHaveBeenCalled();
  });

  it('announces nothing for a status that was already stored', async () => {
    const { dispatch } = await run(Date.now() + 60_000, false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('a status the database refused', () => {
  const unavailable = (): Error =>
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
  const setup = () => {
    const engines = new EngineRegistry();
    const engine = {} as IWhatsAppEngine;
    engines.set('s1', engine);
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const row = { waStatusId: 'st1', contactJid: '628111@c.us', type: 'text', mediaOmitted: false };
    const ingest = jest.fn();
    const removeRevoked = jest.fn();
    const projector = new MessageProjector(
      {} as Repository<Message>,
      {} as Repository<Session>,
      engines,
      { emitStatusReceived: jest.fn() } as unknown as EventsGateway,
      { dispatch } as unknown as WebhookService,
      {} as HookManager,
      { ingest, removeRevoked } as unknown as StatusStoreService,
      {} as SessionLidResolver,
    );
    const stored = { row: { ...row, expiresAt: Date.now() + 60_000 } as StatusUpdate, created: true };
    // The story's delete, as the projector hands it to the status store.
    const remove = (): void =>
      (projector as unknown as { removeDeletedStory(id: string, statusId: string): void }).removeDeletedStory(
        's1',
        'st1',
      );
    return { projector, engine, dispatch, ingest, removeRevoked, stored, remove };
  };
  const turns = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  };

  it('is stored and announced once the database answers', async () => {
    const { projector, engine, dispatch, ingest, stored } = setup();
    ingest.mockRejectedValueOnce(unavailable()).mockResolvedValue(stored);

    await projector.handleInboundMessage('s1', engine, status)?.settled;
    await turns();
    expect(dispatch).not.toHaveBeenCalled();
    await projector.retryParkedChanges();

    expect(ingest).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith('s1', 'status.received', expect.objectContaining({ statusId: 'st1' }));
  });

  it.each([
    ['its row was already stored by then', false, 60_000],
    ['it expired meanwhile', true, -1],
  ] as const)(
    'announces nothing of a kept status stored once the database answers when %s',
    async (_l, created, ttl) => {
      const { projector, engine, dispatch, ingest, stored } = setup();
      ingest
        .mockRejectedValueOnce(unavailable())
        .mockResolvedValue({ row: { ...stored.row, expiresAt: Date.now() + ttl }, created });
      await projector.handleInboundMessage('s1', engine, status)?.settled;
      await turns();

      await projector.retryParkedChanges();

      expect(ingest).toHaveBeenCalledTimes(2);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it('keeps nothing of a status, or of its delete, refused for a reason of its own', async () => {
    const { projector, engine, ingest, removeRevoked, remove } = setup();
    const constraint = Object.assign(new Error('CHECK constraint failed'), { code: 'SQLITE_CONSTRAINT_CHECK' });
    ingest.mockRejectedValue(constraint);
    removeRevoked.mockRejectedValue(constraint);

    await projector.handleInboundMessage('s1', engine, status)?.settled;
    remove();
    await turns();
    await projector.retryParkedChanges();

    expect([ingest.mock.calls.length, removeRevoked.mock.calls.length]).toEqual([1, 1]);
  });

  it("keeps a status through an unlink of the account, as it is the session's own", async () => {
    const { projector, engine, dispatch, ingest, stored } = setup();
    ingest.mockRejectedValueOnce(unavailable()).mockResolvedValue(stored);
    await projector.handleInboundMessage('s1', engine, status)?.settled;
    await turns();

    projector.forgetKeptInbound('s1');
    await projector.retryParkedChanges();

    expect(dispatch).toHaveBeenCalledWith('s1', 'status.received', expect.objectContaining({ statusId: 'st1' }));
  });

  it('removes a story its poster deleted once the database answers', async () => {
    const { projector, removeRevoked, remove } = setup();
    removeRevoked.mockRejectedValueOnce(unavailable()).mockResolvedValue(true);

    remove();
    await turns();
    await projector.retryParkedChanges();

    expect(removeRevoked).toHaveBeenCalledTimes(2);
    expect(removeRevoked).toHaveBeenLastCalledWith('s1', 'st1', undefined);
  });

  it('removes a story kept while the database was away after it lands, when its delete came meanwhile', async () => {
    const { projector, engine, ingest, removeRevoked, stored, remove } = setup();
    const order: string[] = [];
    ingest.mockRejectedValueOnce(unavailable()).mockImplementation(() => {
      order.push('stored');
      return Promise.resolve(stored);
    });
    removeRevoked.mockImplementation(() => {
      order.push('removed');
      return Promise.resolve(true);
    });
    await projector.handleInboundMessage('s1', engine, status)?.settled;
    await turns();

    // The database answers again, the delete arrives before the story was stored.
    remove();
    await turns();
    await projector.retryParkedChanges();

    expect(order).toEqual(['stored', 'removed']);
  });
});
