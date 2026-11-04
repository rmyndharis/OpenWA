import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import type { Readable } from 'stream';
import type { S3Client } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../services/logger.service';
import { StorageService } from './storage.service';

// The real S3 SDK against a local S3 stand-in: the property under test is the socket timer of the SDK's HTTP handler.
jest.setTimeout(30_000);

/** Past the 3 s the SDK's HTTP handler waits, on a request still without its headers, before arming its socket timer. */
const HEADERS_AFTER_MS = 3500;

/**
 * Answers HEAD at once and every GET after HEADERS_AFTER_MS, as a loaded store does, with a body that never ends.
 * A GET for a key holding `checksum` also carries a CRC32 header, as an object the SDK uploaded does (it sends one
 * with every PutObject): the SDK then hands out a stream that validates it instead of the response itself.
 */
function slowStore(): http.Server {
  return http.createServer((req, res) => {
    if (req.method !== 'GET') {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { ETag: '"x"' });
        res.end();
      });
      return;
    }
    setTimeout(() => {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': String(1024 ** 3),
        ETag: '"x"',
        ...(req.url?.includes('checksum') ? { 'x-amz-checksum-crc32': 'AAAAAA==' } : {}),
      });
      res.write(Buffer.alloc(64 * 1024, 5));
    }, HEADERS_AFTER_MS);
  });
}

describe('StorageService S3 downloads whose headers came late', () => {
  const saved = { ...process.env };
  let stub: http.Server;
  let storage: StorageService;
  let dir: string;
  const streams: Readable[] = [];

  beforeEach(async () => {
    jest.spyOn(LoggerService.prototype, 'log').mockImplementation(() => undefined);
    stub = slowStore();
    await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', resolve));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-s3-late-headers-'));
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

  it.each(['plain', 'checksum'])(
    'leaves a %s body to its own idle bound instead of the socket timer the SDK armed while waiting',
    async kind => {
      // Calls through: it only notes which sockets were given a timer.
      const setTimeout = jest.spyOn(net.Socket.prototype, 'setTimeout');

      streams.push((await storage.openFile(`statuses/s1/${kind}.mp4`)).stream);

      // The SDK armed its timer on the download's socket while the headers were late. Left on, it would cut a
      // reader held back for 27 s, where the body's own bound allows S3_READER_IDLE_MS.
      const timed = new Set<net.Socket>(setTimeout.mock.contexts.filter((_, i) => setTimeout.mock.calls[i][0] > 0));
      expect(timed.size).toBe(1);
      for (const socket of timed) expect(socket.timeout).toBe(0);
    },
  );
});
