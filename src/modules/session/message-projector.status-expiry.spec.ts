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
