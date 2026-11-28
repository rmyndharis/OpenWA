import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { applyGlobalValidation, GLOBAL_VALIDATION_OPTIONS, GlobalValidationPipe } from '../../config/app-validation';
import { configureApp } from '../../configure-app';
import { readExport } from '../../../test/helpers/read-export';
import { ImportDataDto } from './dto/import-data.dto';
import { InfraDataController } from './infra-data.controller';
import { InfraDataService } from './infra-data.service';
import { TABLE_IMPORTERS } from './table-importers';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { Webhook } from '../webhook/entities/webhook.entity';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { MessageBatch } from '../message/entities/message-batch.entity';
import { Template } from '../template/entities/template.entity';
import { BaileysStoredMessage } from '../../engine/adapters/baileys-stored-message.entity';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';
import { ChatState } from '../../engine/adapters/baileys-chat-state.entity';
import { PluginInstance } from '../integration/entities/plugin-instance.entity';
import { ConversationMapping } from '../integration/entities/conversation-mapping.entity';
import { IngressEvent } from '../integration/entities/ingress-event.entity';
import { WebhookDeliveryFailure } from '../webhook/entities/webhook-delivery-failure.entity';
import { WebhookOutboxEvent } from '../webhook/entities/webhook-outbox-event.entity';
import { IntegrationDeliveryFailure } from '../integration/entities/integration-delivery-failure.entity';
import { StatusUpdate } from '../status-store/entities/status-update.entity';
import { SendIdempotencyKey } from '../message/entities/send-idempotency-key.entity';
import { AutomationRule } from '../automation/entities/automation-rule.entity';

// The restore body is the whole database. The DTO never validates inside `tables`, so the rows reach the route as
// the body parser produced them, with no copy in between: a copy of every row held the event loop for seconds.
describe('POST /api/infra/import-data through the production parsers and pipes', () => {
  let app: INestApplication<App>;
  let ds: DataSource;
  let service: InfraDataService;
  /** The body as the JSON parser produced it, for the identity check. */
  let parsedBody: { tables?: unknown } | undefined;
  let archive: string;

  beforeAll(async () => {
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        Session,
        Webhook,
        Message,
        MessageBatch,
        Template,
        BaileysStoredMessage,
        LidMapping,
        ChatState,
        PluginInstance,
        ConversationMapping,
        IngressEvent,
        WebhookDeliveryFailure,
        WebhookOutboxEvent,
        IntegrationDeliveryFailure,
        StatusUpdate,
        AutomationRule,
        SendIdempotencyKey,
      ],
      synchronize: true,
    }).initialize();
    await ds.getRepository(Session).save({ id: 's1', name: 'main', status: SessionStatus.DISCONNECTED, config: {} });
    await ds.getRepository(Message).save({
      id: 'm1',
      sessionId: 's1',
      waMessageId: 'WA-1',
      chatId: '628111@c.us',
      from: '628111@c.us',
      to: '628222@c.us',
      body: 'hello',
      type: 'text',
      direction: MessageDirection.INCOMING,
      status: MessageStatus.SENT,
      timestamp: 1_700_000_000,
    });
    const config = { get: (key: string, fallback?: unknown) => (key === 'dataDatabase.type' ? 'sqlite' : fallback) };
    service = new InfraDataService(config as never, ds);
    archive = JSON.stringify(await readExport(service.exportData()));

    const mod = await Test.createTestingModule({
      controllers: [InfraDataController],
      providers: [{ provide: InfraDataService, useValue: service }],
    }).compile();
    app = mod.createNestApplication({ bodyParser: false, logger: false });
    configureApp(app);
    // After the parsers configureApp installs: the body exactly as they hand it on.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      parsedBody = req.body as { tables?: unknown };
      next();
    });
    applyGlobalValidation(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await ds?.destroy();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    parsedBody = undefined;
  });

  const post = (text: string) =>
    request(app.getHttpServer()).post('/api/infra/import-data').set('Content-Type', 'application/json').send(text);
  const tableRows = async (): Promise<Record<string, unknown[]>> => ({
    sessions: await ds.query('SELECT * FROM sessions ORDER BY id'),
    messages: await ds.query('SELECT * FROM messages ORDER BY id'),
  });

  it('hands the restore the parsed rows themselves', async () => {
    const importData = jest.spyOn(service, 'importData');

    const response = await post(archive);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ imported: true, warnings: [] });
    const [handed] = importData.mock.calls[0];
    expect(handed.tables).toBe(parsedBody?.tables);
  });

  it('copies neither the table map nor a row in the pipe itself', async () => {
    const body = JSON.parse(archive) as { tables: { messages: unknown[] } };
    const pipe = new GlobalValidationPipe(GLOBAL_VALIDATION_OPTIONS);

    const validated = (await pipe.transform(body, { type: 'body', metatype: ImportDataDto })) as ImportDataDto;

    expect(validated).toBeInstanceOf(ImportDataDto);
    expect(validated.tables).toBe(body.tables);
    expect(validated.tables.messages?.[0]).toBe(body.tables.messages[0]);
  });

  it.each([
    ['tables absent', '{}'],
    ['tables not an object', '{"tables":"x"}'],
    ['tables an array', '{"tables":[]}'],
    ['an unknown property', '{"tables":{},"extra":1}'],
    ['a flag spelled otherwise', '{"tables":{},"force":"yes"}'],
  ])('still refuses %s with 400', async (_case, text) => {
    const importData = jest.spyOn(service, 'importData');

    const response = await post(text);

    expect(response.status).toBe(400);
    expect(importData).not.toHaveBeenCalled();
  });

  it('still refuses a row that is not an object with 400', async () => {
    const response = await post('{"tables":{"sessions":[null]}}');

    expect(response.status).toBe(400);
    expect((response.body as { message?: unknown }).message).toBe('tables.sessions[0] must be a row object');
  });

  // JSON.parse makes `__proto__`, `constructor` and `prototype` plain own keys. Nothing that reads the rows may turn
  // one into a prototype, and they must not change what is restored.
  it('restores rows that carry prototype-named keys as they are, and changes no prototype', async () => {
    expect((await post(archive)).status).toBe(200);
    const restoredPlain = await tableRows();
    const own =
      '"__proto__":{"polluted":"row"},"constructor":{"prototype":{"polluted":"row"}},"prototype":{"polluted":"row"},';
    const hostile = archive
      .replace('"tables":{', '"tables":{"__proto__":[{"polluted":"tables"}],"constructor":[{}],"prototype":[{}],')
      .replace('{"id":"s1"', `{${own}"id":"s1"`)
      .replace('{"id":"m1"', `{${own}"id":"m1"`);
    expect(hostile.match(/"polluted":"row"/g)).toHaveLength(6);
    const handed: Array<Record<string, unknown>> = [];
    for (const key of ['sessions', 'messages']) {
      const importer = TABLE_IMPORTERS.find(entry => entry.key === key)!;
      const map = importer.map.bind(importer);
      jest.spyOn(importer, 'map').mockImplementation(row => {
        handed.push(row);
        return map(row);
      });
    }

    const response = await post(hostile);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ imported: true, warnings: [] });
    expect(handed).toHaveLength(2);
    for (const row of handed) {
      expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
      expect(Object.getOwnPropertyDescriptor(row, '__proto__')?.value).toEqual({ polluted: 'row' });
      expect(Object.getOwnPropertyDescriptor(row, 'constructor')?.value).toEqual({ prototype: { polluted: 'row' } });
      expect(row.prototype).toEqual({ polluted: 'row' });
    }
    const tables = parsedBody?.tables as object;
    expect(Object.getPrototypeOf(tables)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(tables, '__proto__')?.value).toEqual([{ polluted: 'tables' }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain('polluted');
    expect(await tableRows()).toEqual(restoredPlain);
  });
});
