import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import type { Readable } from 'stream';
import type { S3Client } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../services/logger.service';
import { StorageService } from './storage.service';

// The real S3 SDK against a local S3 stand-in: the property under test is the SDK's per-client socket pool.
jest.setTimeout(30_000);

/** The SDK's default pool size per client (@smithy/node-http-handler). */
const POOL_SIZE = 50;

/**
 * Answers PUT, DELETE and HEAD at once, and every GET with a body that never ends: one chunk of a declared
 * gigabyte. Each opened download therefore keeps its socket checked out until its reader takes the rest,
 * whatever the loopback buffers hold, which is what a client reading slowly does to a streamed download.
 */
function s3Stub(): http.Server {
  return http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(1024 ** 3), ETag: '"x"' });
      res.write(Buffer.alloc(64 * 1024, 5));
      return;
    }
    req.resume();
    req.on('end', () => {
      res.writeHead(req.method === 'DELETE' ? 204 : 200, { ETag: '"x"' });
      res.end();
    });
  });
}

describe('StorageService S3 downloads and the socket pool', () => {
  const saved = { ...process.env };
  let stub: http.Server;
  let storage: StorageService;
  let dir: string;
  const streams: Readable[] = [];

  beforeEach(async () => {
    jest.spyOn(LoggerService.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    stub = s3Stub();
    await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', resolve));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-s3-stream-pool-'));
    process.env.S3_ENDPOINT = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
    process.env.S3_ACCESS_KEY_ID = 'test';
    process.env.S3_SECRET_ACCESS_KEY = 'test';
    process.env.S3_BUCKET = 'openwa';
    const values: Record<string, string> = { 'storage.type': 's3', 'storage.localPath': path.join(dir, 'media') };
    storage = new StorageService({ get: (key: string) => values[key] } as unknown as ConfigService);
    expect(await storage.refreshS3Availability()).toBe(true);
  });

  afterEach(async () => {
    for (const stream of streams.splice(0)) stream.destroy();
    storage.onModuleDestroy();
    const clients = storage as unknown as Record<string, S3Client | null>;
    for (const key of ['s3Client', 's3StreamClient']) clients[key]?.destroy();
    stub.closeAllConnections();
    await new Promise(resolve => stub.close(resolve));
    process.env = { ...saved };
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('still writes and deletes while a full pool of opened downloads is unread', async () => {
    // A status video or chat media file opened for each of fifty clients that have stopped reading.
    for (let i = 0; i < POOL_SIZE; i++) streams.push((await storage.openFile(`statuses/s1/v${i}.mp4`)).stream);

    // The next inbound status is written, and a retention purge deletes, on the same bucket. Waiting for a
    // socket instead would end in the SDK's connect timeout (5 s, three attempts), so 3 s is ample.
    const work = Promise.all([
      storage.putFile('statuses/s1/next.jpg', Buffer.from('x')),
      storage.deleteFile('statuses/s1/old.jpg'),
    ]).then(() => 'done');
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise(resolve => (timer = setTimeout(() => resolve('still waiting'), 3000)));
    const outcome = await Promise.race([work, waited]).finally(() => clearTimeout(timer));

    expect(outcome).toBe('done');
  });
});
