import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';

// The S3 SDK is replaced so the bucket answers locally: HeadBucket succeeds and ListObjectsV2 pages
// through the keys the test sets.
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

import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { StorageService } from './storage.service';

const { mockSend } = jest.requireMock<{ mockSend: jest.Mock }>('@aws-sdk/client-s3');

describe('listing an S3 store unioned with its local fallback dir', () => {
  const saved = { ...process.env };
  let dir: string;
  let storage: StorageService;

  // Two pages of archive keys in the bucket, one of which also sits in the local fallback dir.
  const bucketKeys = Array.from({ length: 1200 }, (_, i) => `chat-media/sess-1/k${i}.jpg`);
  const shared = bucketKeys[7];
  const localOnly = 'chat-media/sess-1/written-during-outage.jpg';

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-s3-union-'));
    const media = path.join(dir, 'media');
    for (const key of [shared, localOnly]) {
      fs.mkdirSync(path.dirname(path.join(media, key)), { recursive: true });
      fs.writeFileSync(path.join(media, key), 'x');
    }
    process.env.S3_ACCESS_KEY_ID = 'test';
    process.env.S3_SECRET_ACCESS_KEY = 'test';
    mockSend.mockReset();
    mockSend.mockImplementation((command: { input: { ContinuationToken?: string } }) => {
      if (!(command instanceof ListObjectsV2Command)) return Promise.resolve({});
      const page = Number(command.input.ContinuationToken ?? 0);
      const keys = bucketKeys.slice(page * 1000, page * 1000 + 1000);
      return Promise.resolve({
        Contents: keys.map(key => ({ Key: `media/${key}` })),
        NextContinuationToken: page * 1000 + 1000 < bucketKeys.length ? String(page + 1) : undefined,
      });
    });
    storage = new StorageService({
      get: (key: string, fallback?: unknown) => ({ 'storage.type': 's3', 'storage.localPath': media })[key] ?? fallback,
    } as unknown as ConfigService);
    await new Promise(resolve => setImmediate(resolve)); // the boot HeadBucket marks the bucket available
  });

  afterEach(() => {
    storage.onModuleDestroy();
    jest.restoreAllMocks();
    process.env = { ...saved };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists every key once, from the bucket and from the fallback dir', async () => {
    const listed: string[] = [];
    for await (const key of storage.iterateFiles('chat-media/')) listed.push(key);

    expect(listed.length).toBe(bucketKeys.length + 1);
    expect([...listed].sort()).toEqual([...bucketKeys, localOnly].sort());
  });

  it('does not keep the bucket keys it streams past', async () => {
    // Calls through: the Sets keep working, the spy only records what goes into them.
    const added = jest.spyOn(Set.prototype, 'add');

    let listed = 0;
    for await (const key of storage.iterateFiles('chat-media/')) {
      void key;
      listed += 1;
    }

    expect(listed).toBe(bucketKeys.length + 1);
    // Only what the fallback dir holds is remembered for the union, never the bucket's own keys.
    const remembered = added.mock.calls.map(([value]) => value as unknown);
    expect(
      remembered.filter(value => typeof value === 'string' && bucketKeys.includes(value) && value !== shared),
    ).toEqual([]);
  });
});
