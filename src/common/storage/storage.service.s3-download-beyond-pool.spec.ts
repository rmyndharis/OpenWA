import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { PassThrough, type Readable } from 'stream';
import { finished } from 'stream/promises';
import type { S3Client } from '@aws-sdk/client-s3';
import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from '../services/logger.service';
import { StorageService } from './storage.service';
import * as transfer from './storage-transfer';

// The real S3 SDK against a local S3 stand-in, as in storage.service.s3-stream-pool.spec.ts.
jest.setTimeout(40_000);

/** The SDK's default pool size per client (@smithy/node-http-handler). */
const POOL_SIZE = 50;

/**
 * A GET for a key naming `missing` answers NoSuchKey, one naming `small` a whole three-byte object, and any
 * other one chunk of a declared gigabyte that never ends, so each opened download keeps its socket.
 */
function s3Stub(): http.Server {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.includes('missing')) {
      res.writeHead(404, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>gone</Message></Error>');
      return;
    }
    if (req.method === 'GET' && req.url?.includes('small')) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': '3', ETag: '"x"' });
      res.end('abc');
      return;
    }
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(1024 ** 3), ETag: '"x"' });
      res.write(Buffer.alloc(64 * 1024, 5));
      return;
    }
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { ETag: '"x"' });
      res.end();
    });
  });
}

describe('StorageService S3 download once every pooled socket is held by a slow reader', () => {
  const saved = { ...process.env };
  let stub: http.Server;
  let storage: StorageService;
  let dir: string;
  const streams: Readable[] = [];

  const outcomeOf = (error: unknown): string =>
    error instanceof HttpException ? `http ${error.getStatus()}` : `error ${(error as Error).name}`;

  /** Fifty clients that stopped reading a status video or a chat media file. */
  async function holdEveryPlace(): Promise<void> {
    for (let i = 0; i < POOL_SIZE; i++) streams.push((await storage.openFile(`statuses/s1/v${i}.mp4`)).stream);
  }

  /** Opens `key`, retrying while it is refused as busy, until `ms` have passed. */
  async function openWithin(key: string, ms: number): Promise<string> {
    const deadline = Date.now() + ms;
    for (;;) {
      try {
        streams.push((await storage.openFile(key)).stream);
        return 'opened';
      } catch (error: unknown) {
        if (outcomeOf(error) !== 'http 503' || Date.now() > deadline) return outcomeOf(error);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }

  beforeEach(async () => {
    jest.spyOn(LoggerService.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(LoggerService.prototype, 'debug').mockImplementation(() => undefined);
    stub = s3Stub();
    await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', resolve));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-s3-beyond-pool-'));
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

  it('serves the next download, or refuses it as a retryable 503, rather than failing it as a server error', async () => {
    // Each holds its socket until it has gone unread for the reader bound, and a client that keeps
    // reading slowly holds it for its whole download.
    await holdEveryPlace();

    const startedAt = Date.now();
    const outcome = await storage.openFile('statuses/s1/next.mp4').then(source => {
      streams.push(source.stream);
      return 'opened';
    }, outcomeOf);

    // A non-HTTP error leaves both media routes answering 500.
    const waited = Date.now() - startedAt > 10_000 ? 'over' : 'under';
    expect(`${outcome}, waited ${waited} 10 s`).toMatch(/^(opened|http 503), waited under 10 s$/);
  });

  it('serves the next download once a held one goes away', async () => {
    await holdEveryPlace();
    const gone = streams.shift()!;
    gone.destroy();
    await finished(gone).catch(() => undefined);

    expect(await openWithin('statuses/s1/next.mp4', 5000)).toBe('opened');
  });

  it('frees the place of a download read to the end and of one that failed to open', async () => {
    for (let i = 0; i < POOL_SIZE; i++) {
      const { stream } = await storage.openFile(`statuses/s1/small${i}.jpg`);
      stream.resume();
      await finished(stream);
    }
    for (let i = 0; i <= POOL_SIZE; i++) {
      await expect(storage.openFile(`statuses/s1/missing${i}.jpg`)).rejects.toMatchObject({ name: 'NoSuchKey' });
    }

    await holdEveryPlace();
    expect(await storage.openFile('statuses/s1/next.mp4').then(() => 'opened', outcomeOf)).toBe('http 503');
  });

  it('holds no place for a file served from the local fallback dir', async () => {
    // Written while S3 was down: the bucket answers NoSuchKey and the read goes through to the local copy.
    fs.mkdirSync(path.join(dir, 'media', 'statuses', 's1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'media', 'statuses', 's1', 'missing-local.jpg'), 'local');
    streams.push((await storage.openFile('statuses/s1/missing-local.jpg')).stream);

    await holdEveryPlace();
    expect(streams).toHaveLength(POOL_SIZE + 1);
  });

  it('still opens the storage export entries while every download place is held', async () => {
    const exported = jest.spyOn(transfer, 'createExportStream').mockResolvedValue(new PassThrough());
    await storage.createExportStream();
    const openEntry = exported.mock.calls[0][1];
    await holdEveryPlace();

    const startedAt = Date.now();
    const outcome = await openEntry('statuses/s1/archived.mp4').then(source => {
      streams.push(source.stream);
      return 'opened';
    }, outcomeOf);

    const waited = Date.now() - startedAt > 10_000 ? 'over' : 'under';
    expect(`${outcome}, waited ${waited} 10 s`).toBe('opened, waited under 10 s');
  });
});
