import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

// The S3 SDK is replaced so the bucket answers locally: HeadBucket succeeds and GetObject answers
// whatever the test sets.
jest.mock('@aws-sdk/client-s3', () => {
  class Command {
    constructor(readonly input: unknown) {}
  }
  class HeadBucketCommand extends Command {}
  class CreateBucketCommand extends Command {}
  class ListObjectsV2Command extends Command {}
  class GetObjectCommand extends Command {}
  class PutObjectCommand extends Command {}
  class DeleteObjectCommand extends Command {}
  const send = jest.fn();
  return {
    S3Client: jest.fn(() => ({ send })),
    HeadBucketCommand,
    CreateBucketCommand,
    ListObjectsV2Command,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    mockSend: send,
  };
});

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { StorageService } from '../../common/storage/storage.service';
import { ChatScopeService } from '../auth/chat-scope.service';
import { BulkMessageService } from './bulk-message.service';
import { SendIdempotencyService } from './idempotency/send-idempotency.service';
import { MessageController } from './message.controller';
import { MessageService } from './message.service';

const { mockSend } = jest.requireMock<{ mockSend: jest.Mock }>('@aws-sdk/client-s3');

interface RawAnswer {
  status?: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  outcome: 'end' | 'aborted' | 'request error' | 'pending';
}

/** GET over a real socket, reporting how the response ended. */
function get(port: number, route: string, waitMs?: number) {
  return new Promise<RawAnswer>(resolve => {
    const answer: RawAnswer = { headers: {}, body: Buffer.alloc(0), outcome: 'pending' };
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (outcome: RawAnswer['outcome']): void => {
      if (settled) return;
      settled = true;
      answer.body = Buffer.concat(chunks);
      answer.outcome = outcome;
      resolve(answer);
    };
    const req = http.get({ host: '127.0.0.1', port, path: route }, res => {
      answer.status = res.statusCode;
      answer.headers = res.headers;
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done('end'));
      res.on('aborted', () => done('aborted'));
      res.on('error', () => done('aborted'));
    });
    req.on('error', () => done('request error'));
    if (waitMs !== undefined) {
      setTimeout(() => {
        done('pending');
        req.destroy();
      }, waitMs);
    }
  });
}

const ROUTE = '/sessions/sess-1/messages/628111@c.us/WA1/media';
const INLINE = Buffer.from('inline copy bytes');

describe('GET /sessions/:sessionId/messages/:chatId/:messageId/media', () => {
  const saved = { ...process.env };
  let dir: string;
  let media: string;
  let storage: StorageService;
  let app: INestApplication;
  let port: number;
  const archive = { getMedia: jest.fn() };
  const repository = { findOne: jest.fn() };

  async function start(type: 'local' | 's3'): Promise<void> {
    storage = new StorageService({
      get: (key: string, fallback?: unknown) => ({ 'storage.type': type, 'storage.localPath': media })[key] ?? fallback,
    } as unknown as ConfigService);
    await new Promise(resolve => setImmediate(resolve)); // the boot HeadBucket marks the bucket available
    const lids = {
      findPhoneForLid: jest.fn().mockResolvedValue(null),
      findLidsForPhone: jest.fn().mockResolvedValue([]),
    };
    const service = new MessageService(
      repository as never,
      {} as never,
      {} as never,
      {} as never,
      lids as never,
      {} as never,
      {} as never,
      archive as never,
      storage,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [MessageController],
      providers: [
        { provide: MessageService, useValue: service },
        { provide: BulkMessageService, useValue: {} },
        { provide: ChatScopeService, useValue: {} },
        // The send routes' replay control; the media route never reaches it.
        { provide: SendIdempotencyService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    port = ((app.getHttpServer() as http.Server).address() as AddressInfo).port;
  }

  const s3Answers = (answer: () => Promise<unknown>): void => {
    mockSend.mockImplementation((command: unknown) =>
      command instanceof GetObjectCommand ? answer() : Promise.resolve({}),
    );
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-chat-media-'));
    media = path.join(dir, 'media');
    process.env.S3_ACCESS_KEY_ID = 'test';
    process.env.S3_SECRET_ACCESS_KEY = 'test';
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    archive.getMedia.mockReset();
    archive.getMedia.mockResolvedValue({ path: 'chat-media/sess-1/a.mp4', mimetype: 'video/mp4' });
    repository.findOne.mockReset();
    repository.findOne.mockResolvedValue({
      type: 'video',
      metadata: { media: { mimetype: 'video/mp4', data: INLINE.toString('base64') } },
    });
  });

  afterEach(async () => {
    await app?.close();
    storage?.onModuleDestroy();
    process.env = { ...saved };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves an archived local file intact, with its length and the attachment headers', async () => {
    const bytes = Buffer.alloc(300 * 1024, 9);
    fs.mkdirSync(path.join(media, 'chat-media', 'sess-1'), { recursive: true });
    fs.writeFileSync(path.join(media, 'chat-media', 'sess-1', 'a.mp4'), bytes);
    await start('local');

    const answer = await get(port, ROUTE);

    expect(answer.outcome).toBe('end');
    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toBe('video/mp4');
    expect(answer.headers['x-content-type-options']).toBe('nosniff');
    expect(answer.headers['content-disposition']).toBe('attachment');
    expect(answer.headers['content-length']).toBe(String(bytes.length));
    expect(answer.body.equals(bytes)).toBe(true);
  });

  it('starts answering before the store has delivered the whole archived file', async () => {
    // A 20 MiB archived video (under the 25 MiB archive cap) whose first MiB has arrived.
    const body = new PassThrough();
    body.write(Buffer.alloc(1024 * 1024, 1));
    await start('s3');
    s3Answers(() => Promise.resolve({ Body: body, ContentLength: 20 * 1024 * 1024 }));

    const answer = await get(port, ROUTE, 500);
    body.destroy();

    expect(answer.status).toBe(200);
    expect(answer.headers['content-length']).toBe(String(20 * 1024 * 1024));
  });

  it.each([
    ['NoSuchKey', { name: 'NoSuchKey' }],
    ['NotFound', { name: 'NotFound' }],
    ['a 404 answer', { $metadata: { httpStatusCode: 404 } }],
  ])('falls back to the inline copy when the archived S3 object is gone (%s)', async (_label, shape) => {
    await start('s3');
    s3Answers(() => Promise.reject(Object.assign(new Error('gone'), shape)));

    const answer = await get(port, ROUTE);

    expect([answer.status, answer.headers['content-length'], answer.body.toString()]).toEqual([
      200,
      String(INLINE.length),
      INLINE.toString(),
    ]);
  });

  it('falls back to the inline copy when the archived local file is gone', async () => {
    await start('local');

    const answer = await get(port, ROUTE);

    expect([answer.status, answer.body.toString()]).toEqual([200, INLINE.toString()]);
  });

  it('answers 404 for a revoked message', async () => {
    archive.getMedia.mockResolvedValue(null);
    repository.findOne.mockResolvedValue({
      type: 'revoked',
      metadata: { media: { mimetype: 'video/mp4', data: 'QQ==' } },
    });
    await start('local');

    expect((await get(port, ROUTE)).status).toBe(404);
  });

  it('answers a JSON 500 for a store fault while opening, without falling back', async () => {
    await start('s3');
    s3Answers(() => Promise.reject(Object.assign(new Error('SlowDown'), { name: 'SlowDown' })));

    const answer = await get(port, ROUTE);

    expect(answer.status).toBe(500);
    expect(answer.headers['content-disposition']).toBeUndefined();
  });

  it('answers a JSON 500 without the media headers when the store fails before the first byte', async () => {
    const body = new PassThrough();
    await start('s3');
    s3Answers(() => Promise.resolve({ Body: body, ContentLength: 1000 }));
    setTimeout(() => body.destroy(new Error('connection reset by the store')), 50);

    const answer = await get(port, ROUTE);

    expect(answer.status).toBe(500);
    expect(answer.headers['content-type']).toMatch(/^application\/json/);
    expect(answer.headers['content-disposition']).toBeUndefined();
    expect(answer.headers['content-length']).not.toBe('1000');
    expect(JSON.parse(answer.body.toString())).toEqual({ statusCode: 500, message: 'Internal server error' });
  });

  it('serves the inline copy with its length when nothing is archived', async () => {
    archive.getMedia.mockResolvedValue(null);
    await start('local');

    const answer = await get(port, ROUTE);

    expect([answer.status, answer.headers['content-length'], answer.body.toString()]).toEqual([
      200,
      String(INLINE.length),
      INLINE.toString(),
    ]);
  });
});
