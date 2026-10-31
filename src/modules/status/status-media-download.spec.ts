import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { PassThrough, Readable } from 'stream';
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
import { StatusController } from './status.controller';
import { StatusService } from './status.service';

const { mockSend } = jest.requireMock<{ mockSend: jest.Mock }>('@aws-sdk/client-s3');

interface RawAnswer {
  status?: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  outcome: 'end' | 'aborted' | 'request error' | 'pending';
}

/** GET over a real socket, reporting how the response ended (a cut connection is not an error to the client). */
function get(port: number, route: string, opts: { abortAfterFirstChunk?: boolean; waitMs?: number } = {}) {
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
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        if (opts.abortAfterFirstChunk) {
          req.destroy();
          done('aborted');
        }
      });
      res.on('end', () => done('end'));
      res.on('aborted', () => done('aborted'));
      res.on('error', () => done('aborted'));
    });
    req.on('error', () => done('request error'));
    if (opts.waitMs !== undefined) {
      setTimeout(() => {
        done('pending');
        req.destroy();
      }, opts.waitMs);
    }
  });
}

const until = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 10));
};

describe('GET /sessions/:sessionId/status/:statusId/media', () => {
  const saved = { ...process.env };
  let dir: string;
  let media: string;
  let storage: StorageService;
  let app: INestApplication;
  let port: number;
  const store = { getMedia: jest.fn() };

  async function start(type: 'local' | 's3'): Promise<void> {
    storage = new StorageService({
      get: (key: string, fallback?: unknown) => ({ 'storage.type': type, 'storage.localPath': media })[key] ?? fallback,
    } as unknown as ConfigService);
    await new Promise(resolve => setImmediate(resolve)); // the boot HeadBucket marks the bucket available
    const service = new StatusService({} as never, {} as never, store as never, storage, {} as never);
    const moduleRef = await Test.createTestingModule({
      controllers: [StatusController],
      providers: [{ provide: StatusService, useValue: service }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    port = ((app.getHttpServer() as http.Server).address() as AddressInfo).port;
  }

  const s3Body = (body: Readable, contentLength?: number): void => {
    mockSend.mockImplementation((command: unknown) =>
      Promise.resolve(command instanceof GetObjectCommand ? { Body: body, ContentLength: contentLength } : {}),
    );
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-status-media-'));
    media = path.join(dir, 'media');
    process.env.S3_ACCESS_KEY_ID = 'test';
    process.env.S3_SECRET_ACCESS_KEY = 'test';
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    store.getMedia.mockReset();
    store.getMedia.mockResolvedValue({ path: 'statuses/sess-1/a.mp4', mimetype: 'video/mp4; codecs=avc1' });
  });

  afterEach(async () => {
    await app?.close();
    storage?.onModuleDestroy();
    jest.restoreAllMocks();
    process.env = { ...saved };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves a local file intact, with its length and the attachment headers', async () => {
    const bytes = Buffer.alloc(300 * 1024, 7);
    fs.mkdirSync(path.join(media, 'statuses', 'sess-1'), { recursive: true });
    fs.writeFileSync(path.join(media, 'statuses', 'sess-1', 'a.mp4'), bytes);
    await start('local');

    const answer = await get(port, '/sessions/sess-1/status/ST1/media');

    expect(answer.outcome).toBe('end');
    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toBe('video/mp4');
    expect(answer.headers['x-content-type-options']).toBe('nosniff');
    expect(answer.headers['content-disposition']).toBe('attachment');
    expect(answer.headers['content-length']).toBe(String(bytes.length));
    expect(answer.body.equals(bytes)).toBe(true);
  });

  it('serves an S3 object intact with its length, and without a length when the store reports none', async () => {
    const bytes = Buffer.alloc(200 * 1024, 3);
    await start('s3');
    s3Body(Readable.from([bytes]), bytes.length);
    const sized = await get(port, '/sessions/sess-1/status/ST1/media');
    s3Body(Readable.from([bytes]));
    const unsized = await get(port, '/sessions/sess-1/status/ST1/media');

    expect([sized.status, sized.headers['content-length'], sized.body.equals(bytes)]).toEqual([200, '204800', true]);
    expect([unsized.status, unsized.headers['content-length'], unsized.body.equals(bytes)]).toEqual([
      200,
      undefined,
      true,
    ]);
  });

  it('starts answering before the store has delivered the whole file', async () => {
    // A 4 MiB video whose first MiB has arrived and whose remainder is still on the wire.
    const body = new PassThrough();
    body.write(Buffer.alloc(1024 * 1024, 1));
    await start('s3');
    s3Body(body, 4 * 1024 * 1024);

    const answer = await get(port, '/sessions/sess-1/status/ST1/media', { waitMs: 500 });
    body.destroy();

    expect(answer.status).toBe(200);
    expect(answer.headers['content-length']).toBe(String(4 * 1024 * 1024));
  });

  it('answers a JSON 500 without the media headers when the store fails before the first byte', async () => {
    const body = new PassThrough();
    await start('s3');
    s3Body(body, 1000);
    setTimeout(() => body.destroy(new Error('connection reset by the store')), 50);

    const answer = await get(port, '/sessions/sess-1/status/ST1/media');

    expect(answer.status).toBe(500);
    expect(answer.headers['content-type']).toMatch(/^application\/json/);
    expect(answer.headers['content-disposition']).toBeUndefined();
    expect(JSON.parse(answer.body.toString())).toEqual({ statusCode: 500, message: 'Internal server error' });
  });

  it('cuts the connection when the store fails after the first byte, so a short body never looks complete', async () => {
    const body = new PassThrough();
    await start('s3');
    s3Body(body, 1000);
    body.write(Buffer.alloc(10, 1));
    setTimeout(() => body.destroy(new Error('connection reset by the store')), 50);

    const answer = await get(port, '/sessions/sess-1/status/ST1/media');

    expect(answer.status).toBe(200);
    expect(answer.outcome).toBe('aborted');
    expect(answer.body.length).toBeLessThan(1000);
  });

  it('releases the S3 body when the client goes away mid-download', async () => {
    const body = new PassThrough();
    body.write(Buffer.alloc(64 * 1024, 1));
    await start('s3');
    s3Body(body, 10 * 1024 * 1024);

    await get(port, '/sessions/sess-1/status/ST1/media', { abortAfterFirstChunk: true });
    await until(() => body.destroyed);

    expect(body.destroyed).toBe(true);
  });

  it('closes the local file when the client goes away mid-download', async () => {
    fs.mkdirSync(path.join(media, 'statuses', 'sess-1'), { recursive: true });
    fs.writeFileSync(path.join(media, 'statuses', 'sess-1', 'a.mp4'), Buffer.alloc(8 * 1024 * 1024, 5));
    await start('local');
    const opened: Readable[] = [];
    const openFile = storage.openFile.bind(storage);
    jest.spyOn(storage, 'openFile').mockImplementation(async key => {
      const source = await openFile(key);
      opened.push(source.stream);
      return source;
    });

    await get(port, '/sessions/sess-1/status/ST1/media', { abortAfterFirstChunk: true });
    await until(() => opened[0]?.destroyed === true);

    expect(opened[0]?.destroyed).toBe(true);
  });

  it.each([
    ['a local file the purge removed', 'local' as const],
    ['an S3 object the purge removed', 's3' as const],
  ])('answers 404 for %s', async (_label, type) => {
    await start(type);
    mockSend.mockImplementation((command: unknown) =>
      command instanceof GetObjectCommand
        ? Promise.reject(Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' }))
        : Promise.resolve({}),
    );

    const answer = await get(port, '/sessions/sess-1/status/ST1/media');

    expect(answer.status).toBe(404);
  });
});
