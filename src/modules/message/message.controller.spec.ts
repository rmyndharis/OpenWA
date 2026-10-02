import { StreamableFile } from '@nestjs/common';
import { RESPONSE_PASSTHROUGH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { Server } from 'http';
import { MessageController } from './message.controller';
import { MessageService } from './message.service';
import { BulkMessageService } from './bulk-message.service';
import { ChatScopeService } from '../auth/chat-scope.service';
import { CHAT_SCOPED_KEY } from '../auth/decorators/auth.decorators';
import type { ApiKey } from '../auth/entities/api-key.entity';
import type { SendBulkMessageDto } from './dto/bulk-message.dto';
import type { Response } from 'express';

describe('MessageController - message-time selection', () => {
  const getMessages = jest.fn().mockResolvedValue({ messages: [], total: 0, unknownTimestampTotal: 0 });
  const controller = new MessageController(
    { getMessages } as unknown as MessageService,
    {} as unknown as BulkMessageService,
    new ChatScopeService(),
  );
  beforeEach(() => getMessages.mockClear());

  it('passes new HTTP options into the existing bounded list', async () => {
    await controller.getMessages(
      's1',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'false',
      undefined,
      '1000000.5',
      '2000000',
      'incoming',
      'timestamp',
    );
    expect(getMessages).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        since: 1000000.5,
        until: 2000000,
        direction: 'incoming',
        orderBy: 'timestamp',
        inlineMedia: false,
      }),
    );
  });
  it('rejects invalid selection before accessing storage', async () => {
    await expect(
      controller.getMessages(
        's1',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        '2000',
        '1000',
      ),
    ).rejects.toThrow('since');
    expect(getMessages).not.toHaveBeenCalled();
  });
  it('keeps chat-restricted reads fenced even for new filters', async () => {
    await expect(
      controller.getMessages(
        's1',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { allowedChats: ['1@c.us'] } as ApiKey,
        '1000',
        '2000',
        'incoming',
        'timestamp',
      ),
    ).rejects.toThrow();
    expect(getMessages).not.toHaveBeenCalled();
  });
});

/**
 * `getChatMedia` serves third-party bytes from the API origin. The route shape, the roles and the
 * status codes are already held by the OpenAPI snapshot and the route-fence gates; the two headers
 * that keep those bytes inert in a browser were held by nothing — deleting either line from the
 * controller passed every suite in the repo.
 */
describe('MessageController — stored media download', () => {
  const getChatMedia = jest.fn().mockResolvedValue({ buffer: Buffer.from('GIF89a'), mimetype: 'image/gif' });
  const controller = new MessageController(
    { getChatMedia } as unknown as MessageService,
    {} as unknown as BulkMessageService,
    new ChatScopeService(),
  );

  /**
   * Express merges the object form of `res.set` into the header bag, so accumulating is both closer
   * to the real thing than recording the last call and independent of how many calls the handler
   * splits its headers across.
   */
  const mediaResponseHeaders = async (): Promise<Record<string, string>> => {
    const headers: Record<string, string> = {};
    const res = { set: (fields: Record<string, string>) => Object.assign(headers, fields) } as unknown as Response;
    await controller.getChatMedia('session-1', '628123@c.us', 'msg-1', res);
    return headers;
  };

  it('sends nosniff, so a wrong Content-Type cannot be re-interpreted as active content', async () => {
    expect((await mediaResponseHeaders())['X-Content-Type-Options']).toBe('nosniff');
  });

  it('sends the media as an attachment, so it is never rendered on the API origin', async () => {
    expect((await mediaResponseHeaders())['Content-Disposition']).toBe('attachment');
  });

  /**
   * The headers above are set on the response object directly, so they survive a handler that sends
   * no body at all — a `404` with a perfect `Content-Disposition` would satisfy both. What actually
   * carries the bytes is the returned `StreamableFile`, and Nest only sends that when the response
   * parameter is declared passthrough: without it Nest treats the handler as having taken the
   * response over and discards the return value entirely. Both halves are asserted here so the pair
   * above cannot end up describing a response that is never sent.
   *
   * Nest records the flag under its own metadata key rather than in the route arguments, and only
   * when it is truthy — so reading it back is what distinguishes `@Res({ passthrough: true })` from
   * a bare `@Res()`.
   */
  it('declares the response passthrough, so Nest sends the returned file rather than discarding it', () => {
    expect(Reflect.getMetadata(RESPONSE_PASSTHROUGH_METADATA, MessageController, 'getChatMedia')).toBe(true);
  });

  it('returns the stored bytes as the response body', async () => {
    const res = { set: () => undefined } as unknown as Response;

    const body = await controller.getChatMedia('session-1', '628123@c.us', 'msg-1', res);

    expect(body).toBeInstanceOf(StreamableFile);
    expect(body.getStream().read()).toEqual(Buffer.from('GIF89a'));
  });
});

/**
 * `inlineMedia` is an OPT-OUT, unlike every other boolean on this controller, so the parse reads the
 * same string pair the other way round. Inverting it would quietly strip media from every default
 * read, which no other suite would notice: the service takes a boolean and cannot tell who set it.
 */
describe('MessageController - inlineMedia is opt-out', () => {
  const getMessages = jest.fn().mockResolvedValue({ messages: [], total: 0 });
  const controller = new MessageController(
    { getMessages } as unknown as MessageService,
    {} as unknown as BulkMessageService,
    new ChatScopeService(),
  );

  const inlineMediaFor = async (raw?: string): Promise<boolean> => {
    getMessages.mockClear();
    await controller.getMessages('session-1', undefined, undefined, undefined, undefined, undefined, raw);
    const [, options] = getMessages.mock.calls[0] as [string, { inlineMedia: boolean }];
    return options.inlineMedia;
  };

  it.each([undefined, 'true', '1', '', 'no', 'False'])('keeps media inline for %p', async raw => {
    expect(await inlineMediaFor(raw)).toBe(true);
  });

  it.each(['false', '0'])('omits media for %p', async raw => {
    expect(await inlineMediaFor(raw)).toBe(false);
  });

  const afterFor = async (raw?: string): Promise<string | undefined> => {
    getMessages.mockClear();
    await controller.getMessages('session-1', undefined, undefined, undefined, undefined, raw, undefined);
    const [, options] = getMessages.mock.calls[0] as [string, { after?: string }];
    return options.after;
  };

  /**
   * The service only skips the keyset branch on `undefined`. A blank reached the anchor lookup,
   * matched no row, and answered 400 for what is an ordinary unfiltered first page: a client
   * templating a cursor it has not got yet sends exactly that.
   */
  it.each([undefined, '', '   '])('treats a blank after as absent for %p', async raw => {
    expect(await afterFor(raw)).toBeUndefined();
  });

  it('passes a real cursor through, trimmed', async () => {
    expect(await afterFor('db-42')).toBe('db-42');
    expect(await afterFor('  db-42  ')).toBe('db-42');
  });
});

/**
 * A key restricted to selected chats reads stored history only for a chat it names: the guard fences
 * the ?chatId= it sends, and the handler refuses the same key when it names none, which the service
 * would otherwise read as every chat in the session.
 */
describe('MessageController - stored history for a chat-restricted key', () => {
  const getMessages = jest.fn().mockResolvedValue({ messages: [], total: 0 });
  const controller = new MessageController(
    { getMessages } as unknown as MessageService,
    {} as unknown as BulkMessageService,
    new ChatScopeService(),
  );
  const restricted = { allowedChats: ['1@c.us'] } as ApiKey;
  const list = (chatId: string | undefined, apiKey?: ApiKey) =>
    controller.getMessages('s1', chatId, undefined, undefined, undefined, undefined, undefined, apiKey);

  beforeEach(() => getMessages.mockClear());

  it('is fenced', () => {
    expect(
      Reflect.getMetadata(
        CHAT_SCOPED_KEY,
        Object.getOwnPropertyDescriptor(MessageController.prototype, 'getMessages')!.value as object,
      ),
    ).toBe('fenced');
  });

  it.each([undefined, ''])('refuses a restricted key with chatId %p before reading', async chatId => {
    await expect(list(chatId, restricted)).rejects.toThrow('chatId is required for a key restricted to selected chats');
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('reads the named chat for a restricted key, passing chatId through as sent', async () => {
    await list('1@c.us', restricted);
    expect(getMessages).toHaveBeenCalledWith('s1', expect.objectContaining({ chatId: '1@c.us' }));
  });

  it('leaves an unrestricted key free to list every chat', async () => {
    await list(undefined, { allowedChats: null } as ApiKey);
    expect(getMessages).toHaveBeenCalledWith('s1', expect.objectContaining({ chatId: undefined }));
  });
});

/**
 * A caller may pick its own batchId. 'history' shares the two-segment shape of ':chatId/history',
 * and an id with a reserved character must survive the statusUrl handed back on creation.
 */
describe('MessageController - caller-supplied batch ids', () => {
  const bulk = {
    getBatchStatus: jest.fn().mockResolvedValue({ batchId: 'history', status: 'processing' }),
    createBatch: jest.fn().mockResolvedValue({ batchId: 'run/1?x', status: 'pending', messages: [] }),
  };
  const messages = { getChatHistory: jest.fn().mockResolvedValue([]) };

  it("routes GET batch/history to the batch status, not the history of chat 'batch'", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MessageController],
      providers: [
        { provide: MessageService, useValue: messages },
        { provide: BulkMessageService, useValue: bulk },
        ChatScopeService,
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      await request(app.getHttpServer() as Server)
        .get('/sessions/s1/messages/batch/history')
        .expect(200);
      expect(bulk.getBatchStatus).toHaveBeenCalledWith('s1', 'history');
      expect(messages.getChatHistory).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('percent-encodes the batch id in the returned statusUrl', async () => {
    const controller = new MessageController(
      messages as unknown as MessageService,
      bulk as unknown as BulkMessageService,
      new ChatScopeService(),
    );

    const res = await controller.sendBulk('s1', {} as SendBulkMessageDto);

    expect(res.statusUrl).toBe('/api/sessions/s1/messages/batch/run%2F1%3Fx');
  });
});
