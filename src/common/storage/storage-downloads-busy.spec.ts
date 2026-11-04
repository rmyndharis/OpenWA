import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

// The S3 SDK is replaced so the bucket answers locally: HeadBucket succeeds and every GetObject answers a
// body that never ends, so each opened download keeps its place.
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
import { ChatScopeService } from '../../modules/auth/chat-scope.service';
import { BulkMessageService } from '../../modules/message/bulk-message.service';
import { SendIdempotencyService } from '../../modules/message/idempotency/send-idempotency.service';
import { MessageController } from '../../modules/message/message.controller';
import { MessageService } from '../../modules/message/message.service';
import { StatusController } from '../../modules/status/status.controller';
import { StatusService } from '../../modules/status/status.service';
import { S3_MAX_OPEN_DOWNLOADS, StorageService } from './storage.service';

const { mockSend } = jest.requireMock<{ mockSend: jest.Mock }>('@aws-sdk/client-s3');

function get(port: number, route: string): Promise<{ status?: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: route }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
  });
}

describe('S3 media download routes once every download place is held', () => {
  const saved = { ...process.env };
  const bodies: PassThrough[] = [];
  let dir: string;
  let storage: StorageService;
  let app: INestApplication;
  let port: number;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-downloads-busy-'));
    process.env.S3_ACCESS_KEY_ID = 'test';
    process.env.S3_SECRET_ACCESS_KEY = 'test';
    mockSend.mockReset();
    mockSend.mockImplementation((command: unknown) => {
      if (!(command instanceof GetObjectCommand)) return Promise.resolve({});
      const body = new PassThrough();
      bodies.push(body);
      return Promise.resolve({ Body: body, ContentLength: 1000 });
    });
    const media = path.join(dir, 'media');
    storage = new StorageService({
      get: (key: string, fallback?: unknown) => ({ 'storage.type': 's3', 'storage.localPath': media })[key] ?? fallback,
    } as unknown as ConfigService);
    await new Promise(resolve => setImmediate(resolve)); // the boot HeadBucket marks the bucket available

    const statusStore = {
      getMedia: jest.fn().mockResolvedValue({ path: 'statuses/sess-1/a.mp4', mimetype: 'video/mp4' }),
    };
    const archive = {
      getMedia: jest.fn().mockResolvedValue({ path: 'chat-media/sess-1/a.mp4', mimetype: 'video/mp4' }),
    };
    const lids = {
      findPhoneForLid: jest.fn().mockResolvedValue(null),
      findLidsForPhone: jest.fn().mockResolvedValue([]),
    };
    const statusService = new StatusService({} as never, {} as never, statusStore as never, storage, {} as never);
    const messageService = new MessageService(
      { findOne: jest.fn().mockResolvedValue(null) } as never,
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
      controllers: [StatusController, MessageController],
      providers: [
        { provide: StatusService, useValue: statusService },
        { provide: MessageService, useValue: messageService },
        { provide: BulkMessageService, useValue: {} },
        { provide: ChatScopeService, useValue: {} },
        { provide: SendIdempotencyService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    port = ((app.getHttpServer() as http.Server).address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const body of bodies.splice(0)) body.destroy();
    await app?.close();
    storage?.onModuleDestroy();
    process.env = { ...saved };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function holdEveryPlace(): Promise<void> {
    for (let i = 0; i < S3_MAX_OPEN_DOWNLOADS; i++) await storage.openFile(`statuses/sess-1/held${i}.mp4`);
  }

  it.each([
    ['status media', '/sessions/sess-1/status/ST1/media'],
    ['chat media', '/sessions/sess-1/messages/628111@c.us/WA1/media'],
  ])('refuses %s with a 503 that says when to retry', async (_name, route) => {
    await holdEveryPlace();

    const answer = await get(port, route);

    expect([answer.status, answer.headers['retry-after']]).toEqual([503, '1']);
  });

  it('sends no Retry-After with another store failure', async () => {
    mockSend.mockImplementation((command: unknown) =>
      command instanceof GetObjectCommand
        ? Promise.reject(Object.assign(new Error('SlowDown'), { name: 'SlowDown' }))
        : Promise.resolve({}),
    );

    const answer = await get(port, '/sessions/sess-1/status/ST1/media');

    expect([answer.status, answer.headers['retry-after']]).toEqual([500, undefined]);
  });
});
