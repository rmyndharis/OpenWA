// archiver v8 is ESM-only (pulled in transitively via @Global StorageModule); stub for ts-jest CJS.
jest.mock('archiver', () => ({ TarArchive: jest.fn() }));

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { applyGlobalValidation } from './../src/config/app-validation';
import { AuthService } from './../src/modules/auth/auth.service';
import { ApiKeyRole } from './../src/modules/auth/entities/api-key.entity';
import { Session } from './../src/modules/session/entities/session.entity';
import { EngineRegistry } from './../src/engine/engine-registry.service';
import type { IWhatsAppEngine, MessageResult } from './../src/engine/interfaces/whatsapp-engine.interface';

/**
 * The send-* endpoints had no runtime exercise at all: the OpenAPI snapshot pins their route shape
 * but not that a POST actually reaches the engine and answers 201. These tests run the real HTTP
 * stack — guard, validation pipe, controller, MessageService (pacing gate, plugin gate, pending-row
 * persistence) — against a fake engine registered in the live EngineRegistry, so what is asserted
 * is the whole send path, not a controller mocked loose from its service.
 *
 * The fake engine is enough because everything else the path touches is real and local in this
 * harness: sqlite for the pending/sent rows, no enabled plugins, pacing disabled by default.
 * SIMULATE_TYPING is pinned off so the humanising pre-send pause doesn't slow the suite.
 *
 * Beyond the single-item verbs, the same harness covers send-template (resolution, rendering,
 * the 404s), reply/forward, and the async bulk pipeline end to end: 202 envelope, per-recipient
 * results settled through GET batch/:id, mixed success/failure, and the DTO's hard edges.
 */
describe('Message send endpoints (e2e)', () => {
  let app: INestApplication<App>;
  let sessionId: string;
  let operatorKey: string;
  let templateId: string;
  let templateNameFixture: string;
  const prevSimulateTyping = process.env.SIMULATE_TYPING;

  const result: MessageResult = { id: 'wamid.e2e-send', timestamp: 1_706_868_000 };
  const engine = {
    sendTextMessage: jest.fn().mockResolvedValue(result),
    sendImageMessage: jest.fn().mockResolvedValue(result),
    sendVideoMessage: jest.fn().mockResolvedValue(result),
    sendAudioMessage: jest.fn().mockResolvedValue(result),
    sendDocumentMessage: jest.fn().mockResolvedValue(result),
    sendStickerMessage: jest.fn().mockResolvedValue(result),
    sendLocationMessage: jest.fn().mockResolvedValue(result),
    sendContactMessage: jest.fn().mockResolvedValue(result),
    sendPollMessage: jest.fn().mockResolvedValue(result),
    replyToMessage: jest.fn().mockResolvedValue(result),
    forwardMessage: jest.fn().mockResolvedValue(result),
  };

  const post = (verb: string, body: object, session: string = sessionId) =>
    request(app.getHttpServer())
      .post(`/api/sessions/${session}/messages/${verb}`)
      .set('X-API-Key', operatorKey)
      .send(body);

  const get = (path: string, session: string = sessionId) =>
    request(app.getHttpServer()).get(`/api/sessions/${session}/messages/${path}`).set('X-API-Key', operatorKey);

  /** GET batch/:id payload, in the settled shape the assertions read. */
  type BatchBody = {
    batchId: string;
    status: string;
    progress: { total: number; sent: number; failed: number; pending: number; cancelled: number };
    results: Array<{ chatId: string; status: string; messageId?: string; error?: { code: string; message: string } }>;
    startedAt?: string;
    completedAt?: string;
  };

  /** Poll the batch endpoint until the fire-and-forget processor settles the batch. */
  const waitForBatch = async (batchId: string): Promise<BatchBody> => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const res = await get(`batch/${batchId}`).expect(200);
      const body = res.body as BatchBody;
      if (body.status !== 'pending' && body.status !== 'processing') return body;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`batch ${batchId} did not settle within 3s`);
  };

  beforeAll(async () => {
    process.env.SIMULATE_TYPING = 'false';
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    applyGlobalValidation(app);
    await app.init();

    const sessionRepo: Repository<Session> = app.get(getRepositoryToken(Session, 'data'));
    sessionId = (await sessionRepo.save(sessionRepo.create({ name: `e2e-send-${Date.now()}` }))).id;

    app.get(EngineRegistry).set(sessionId, engine as unknown as IWhatsAppEngine);
    operatorKey = (await app.get(AuthService).createApiKey({ name: 'e2e-send', role: ApiKeyRole.OPERATOR })).rawKey;

    // A real template row via the real route, so send-template exercises resolution and rendering
    // against persisted data rather than a seeded fixture.
    templateNameFixture = `e2e-greet-${Date.now()}`;
    const template = await request(app.getHttpServer())
      .post(`/api/sessions/${sessionId}/templates`)
      .set('X-API-Key', operatorKey)
      .send({
        name: templateNameFixture,
        header: 'Hi',
        body: 'Hello {{customer}}, order {{orderId}} is ready.',
        footer: 'Thanks',
      })
      .expect(201);
    templateId = (template.body as { id: string }).id;
  });

  afterAll(async () => {
    process.env.SIMULATE_TYPING = prevSimulateTyping;
    try {
      await app?.close();
    } catch {
      /* ignore teardown-only multi-datasource quirk */
    }
  });

  beforeEach(() => jest.clearAllMocks());

  it('send-text returns 201 and hands chatId + text to the engine', async () => {
    const res = await post('send-text', { chatId: '628123@c.us', text: 'hello from e2e' }).expect(201);

    expect(res.body).toEqual({ messageId: result.id, timestamp: result.timestamp });
    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(engine.sendTextMessage).toHaveBeenCalledWith('628123@c.us', 'hello from e2e');
  });

  it('send-image returns 201 and hands the base64 payload to the engine', async () => {
    const base64 = Buffer.from('GIF89a').toString('base64');
    const res = await post('send-image', {
      chatId: '628123@c.us',
      base64,
      mimetype: 'image/gif',
      caption: 'a gif',
    }).expect(201);

    expect(res.body).toEqual({ messageId: result.id, timestamp: result.timestamp });
    expect(engine.sendImageMessage).toHaveBeenCalledWith(
      '628123@c.us',
      expect.objectContaining({ data: base64, mimetype: 'image/gif', caption: 'a gif' }),
    );
  });

  it('send-video returns 201 and invokes the engine', async () => {
    const base64 = Buffer.from('fake-video').toString('base64');
    await post('send-video', { chatId: '628123@c.us', base64, mimetype: 'video/mp4' }).expect(201);

    expect(engine.sendVideoMessage).toHaveBeenCalledWith(
      '628123@c.us',
      expect.objectContaining({ data: base64, mimetype: 'video/mp4' }),
    );
  });

  it('send-audio returns 201 and forwards the ptt flag as a voice note', async () => {
    const base64 = Buffer.from('fake-audio').toString('base64');
    await post('send-audio', { chatId: '628123@c.us', base64, mimetype: 'audio/ogg; codecs=opus', ptt: true }).expect(
      201,
    );

    expect(engine.sendAudioMessage).toHaveBeenCalledWith(
      '628123@c.us',
      expect.objectContaining({ data: base64, ptt: true }),
    );
  });

  it('send-document returns 201 and keeps the filename', async () => {
    const base64 = Buffer.from('fake-pdf').toString('base64');
    await post('send-document', {
      chatId: '628123@c.us',
      base64,
      mimetype: 'application/pdf',
      filename: 'doc.pdf',
    }).expect(201);

    expect(engine.sendDocumentMessage).toHaveBeenCalledWith(
      '628123@c.us',
      expect.objectContaining({ data: base64, filename: 'doc.pdf' }),
    );
  });

  it('send-location returns 201 and forwards the coordinates', async () => {
    await post('send-location', {
      chatId: '628123@c.us',
      latitude: -6.2088,
      longitude: 106.8456,
      description: 'Monas',
    }).expect(201);

    expect(engine.sendLocationMessage).toHaveBeenCalledWith(
      '628123@c.us',
      expect.objectContaining({ latitude: -6.2088, longitude: 106.8456, description: 'Monas' }),
    );
  });

  it('send-contact returns 201 and forwards the card', async () => {
    await post('send-contact', {
      chatId: '628123@c.us',
      contactName: 'Ada',
      contactNumber: '628456',
    }).expect(201);

    expect(engine.sendContactMessage).toHaveBeenCalledWith(
      '628123@c.us',
      expect.objectContaining({ name: 'Ada', number: '628456' }),
    );
  });

  it('send-poll returns 201 and forwards the question and options', async () => {
    await post('send-poll', {
      chatId: '628123@c.us',
      name: 'Lunch?',
      options: ['Nasi padang', 'Bakso'],
    }).expect(201);

    expect(engine.sendPollMessage).toHaveBeenCalledWith(
      '628123@c.us',
      expect.objectContaining({ name: 'Lunch?', options: ['Nasi padang', 'Bakso'], allowMultipleAnswers: false }),
    );
  });

  it('send-sticker returns 201 and invokes the engine', async () => {
    const base64 = Buffer.from('fake-webp').toString('base64');
    await post('send-sticker', { chatId: '628123@c.us', base64, mimetype: 'image/webp' }).expect(201);

    expect(engine.sendStickerMessage).toHaveBeenCalledWith(
      '628123@c.us',
      expect.objectContaining({ data: base64, mimetype: 'image/webp' }),
    );
  });

  it('send-template renders the resolved template and sends it as text', async () => {
    const res = await post('send-template', {
      chatId: '628123@c.us',
      templateName: templateNameFixture,
      vars: { customer: 'Ada', orderId: '42' },
    }).expect(201);

    expect(res.body).toEqual({ messageId: result.id, timestamp: result.timestamp });
    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(engine.sendTextMessage).toHaveBeenCalledWith('628123@c.us', 'Hi\n\nHello Ada, order 42 is ready.\n\nThanks');
  });

  it('send-template also resolves by id', async () => {
    await post('send-template', {
      chatId: '628123@c.us',
      templateId,
      vars: { customer: 'Grace', orderId: '7' },
    }).expect(201);

    expect(engine.sendTextMessage).toHaveBeenCalledWith(
      '628123@c.us',
      'Hi\n\nHello Grace, order 7 is ready.\n\nThanks',
    );
  });

  it('send-template with an unknown name is a 404 and never reaches the engine', async () => {
    const res = await post('send-template', { chatId: '628123@c.us', templateName: 'missing' }).expect(404);

    expect((res.body as { message: string }).message).toMatch(/not found/);
    expect(engine.sendTextMessage).not.toHaveBeenCalled();
  });

  it('send-template without either identifier is a 404 naming the requirement', async () => {
    const res = await post('send-template', { chatId: '628123@c.us' }).expect(404);

    expect((res.body as { message: string }).message).toBe('Either templateId or templateName must be provided');
    expect(engine.sendTextMessage).not.toHaveBeenCalled();
  });

  it('reply returns 201 and quotes the original message', async () => {
    const res = await post('reply', {
      chatId: '628123@c.us',
      quotedMessageId: 'wamid.quoted.1',
      text: 'replying',
    }).expect(201);

    expect(res.body).toEqual({ messageId: result.id, timestamp: result.timestamp });
    expect(engine.replyToMessage).toHaveBeenCalledTimes(1);
    expect(engine.replyToMessage).toHaveBeenCalledWith('628123@c.us', 'wamid.quoted.1', 'replying');
  });

  it('forward returns 201 and forwards via the engine', async () => {
    const res = await post('forward', {
      fromChatId: '628123@c.us',
      toChatId: '628999@c.us',
      messageId: 'wamid.src.1',
    }).expect(201);

    expect(res.body).toEqual({ messageId: result.id, timestamp: result.timestamp });
    expect(engine.forwardMessage).toHaveBeenCalledTimes(1);
    expect(engine.forwardMessage).toHaveBeenCalledWith('628123@c.us', '628999@c.us', 'wamid.src.1');
  });

  it('send-bulk answers 202 with the batch envelope, then settles through the batch endpoint', async () => {
    const res = await post('send-bulk', {
      messages: [{ chatId: '628111@c.us', type: 'text', content: { text: 'bulk one' } }],
    }).expect(202);

    const body = res.body as {
      batchId: string;
      status: string;
      totalMessages: number;
      statusUrl: string;
      estimatedCompletionTime: string;
    };
    const batchId: string = body.batchId;
    expect(batchId).toMatch(/^batch_/);
    expect(body.status).toBe('pending');
    expect(body.totalMessages).toBe(1);
    expect(body.statusUrl).toBe(`/api/sessions/${sessionId}/messages/batch/${batchId}`);
    expect(body.estimatedCompletionTime).toEqual(expect.any(String));

    const settled = await waitForBatch(batchId);
    expect(settled.status).toBe('completed');
    expect(settled.progress).toEqual({ total: 1, sent: 1, failed: 0, pending: 0, cancelled: 0 });
    expect(settled.results).toEqual([
      expect.objectContaining({ chatId: '628111@c.us', status: 'sent', messageId: result.id }),
    ]);
    expect(settled.startedAt).toEqual(expect.any(String));
    expect(settled.completedAt).toEqual(expect.any(String));

    expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(engine.sendTextMessage).toHaveBeenCalledWith('628111@c.us', 'bulk one');
  });

  it('send-bulk reports per-recipient outcomes with variables applied', async () => {
    engine.sendTextMessage.mockResolvedValueOnce(result).mockRejectedValueOnce(new Error('engine refused'));

    const res = await post('send-bulk', {
      messages: [
        { chatId: '628111@c.us', type: 'text', content: { text: 'hey {{name}}' }, variables: { name: 'Bo' } },
        { chatId: '628222@c.us', type: 'text', content: { text: 'second' } },
      ],
      options: { delayBetweenMessages: 1000, randomizeDelay: false },
    }).expect(202);
    expect((res.body as { totalMessages: number }).totalMessages).toBe(2);

    const settled = await waitForBatch((res.body as { batchId: string }).batchId);
    expect(settled.status).toBe('completed');
    expect(settled.progress).toEqual({ total: 2, sent: 1, failed: 1, pending: 0, cancelled: 0 });
    expect(engine.sendTextMessage).toHaveBeenNthCalledWith(1, '628111@c.us', 'hey Bo');
    expect(settled.results[1]).toEqual(
      expect.objectContaining({
        chatId: '628222@c.us',
        status: 'failed',
        error: { code: 'SEND_FAILED', message: 'engine refused' },
      }),
    );
  });

  it('send-bulk rejects a delay under the 1s floor', async () => {
    await post('send-bulk', {
      messages: [{ chatId: '628111@c.us', type: 'text', content: { text: 'x' } }],
      options: { delayBetweenMessages: 500 },
    }).expect(400);
  });

  it('send-bulk rejects a message type the batch does not carry', async () => {
    await post('send-bulk', {
      messages: [{ chatId: '628111@c.us', type: 'sticker', content: {} }],
    }).expect(400);
  });

  it('batch status for an unknown id is a 404 naming it', async () => {
    const res = await get('batch/does-not-exist').expect(404);

    expect((res.body as { message: string }).message).toBe("Batch 'does-not-exist' not found");
  });

  it('a send to a session with no live engine is a 400, not a 500', async () => {
    const sessionRepo: Repository<Session> = app.get(getRepositoryToken(Session, 'data'));
    const idle = await sessionRepo.save(sessionRepo.create({ name: `e2e-send-idle-${Date.now()}` }));

    const res = await post('send-text', { chatId: '628123@c.us', text: 'hi' }, idle.id).expect(400);

    expect((res.body as { message: string }).message).toMatch(/not active/);
    expect(engine.sendTextMessage).not.toHaveBeenCalled();
  });
});
