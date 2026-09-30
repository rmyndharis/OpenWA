import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';

// archiver is ESM-only and never used here; stub it before StorageService is imported.
jest.mock('archiver', () => ({ default: jest.fn() }));

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
  HeadBucketCommand: jest.fn(),
  CreateBucketCommand: jest.fn(),
  ListObjectsV2Command: jest.fn(),
  GetObjectCommand: jest.fn(),
  PutObjectCommand: jest.fn(),
  DeleteObjectCommand: jest.fn(),
}));

import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { validateEnv } from '../../config/env.validation';
import { normalizeS3KeyPrefix } from './s3-key-prefix';
import { StorageService } from './storage.service';

/** The input object of every construction of a mocked AWS command. */
function inputs(command: unknown): Record<string, unknown>[] {
  return (command as jest.Mock).mock.calls.map(([input]) => input as Record<string, unknown>);
}

describe('normalizeS3KeyPrefix', () => {
  it.each([
    [undefined, 'media/'],
    ['', 'media/'],
    ['   ', 'media/'],
    ['staging', 'staging/'],
    ['staging/', 'staging/'],
    [' tenants/prod// ', 'tenants/prod/'],
  ])('%j gives %j', (raw, root) => {
    expect(normalizeS3KeyPrefix(raw)).toBe(root);
  });

  it.each(['/', '//', '/abs', '../x', 'a/../b', 'a\u0000b', '.', './', 'a//b', 'a/./b'])('rejects %j', raw => {
    expect(normalizeS3KeyPrefix(raw)).toBeNull();
  });

  it('fails boot on an unsafe S3_KEY_PREFIX and accepts a relative one', () => {
    expect(() => validateEnv({ S3_KEY_PREFIX: '../x' })).toThrow(/S3_KEY_PREFIX/);
    expect(() => validateEnv({ S3_KEY_PREFIX: '/abs' })).toThrow(/S3_KEY_PREFIX/);
    expect(() => validateEnv({ S3_KEY_PREFIX: '/' })).toThrow(/S3_KEY_PREFIX/);
    expect(() => validateEnv({ S3_KEY_PREFIX: 'tenants//prod' })).toThrow(/S3_KEY_PREFIX/);
    expect(() => validateEnv({ S3_KEY_PREFIX: 'staging/' })).not.toThrow();
    expect(() => validateEnv({ S3_KEY_PREFIX: '' })).not.toThrow();
  });
});

describe('StorageService S3 key prefix', () => {
  let tmpRoot: string;
  let svc: StorageService | undefined;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-s3-prefix-'));
    jest.clearAllMocks();
    mockSend.mockResolvedValue({});
    delete process.env.S3_KEY_PREFIX;
  });

  afterEach(() => {
    svc?.onModuleDestroy();
    svc = undefined;
    delete process.env.S3_KEY_PREFIX;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function makeService(keyPrefix?: string): Promise<StorageService> {
    const config = {
      get: (key: string) => {
        if (key === 'storage.type') return 's3';
        if (key === 'storage.localPath') return path.join(tmpRoot, 'media');
        if (key === 'storage.s3') return { accessKeyId: 'k', secretAccessKey: 's', keyPrefix };
        return undefined;
      },
    } as unknown as ConfigService;
    svc = new StorageService(config);
    await new Promise(resolve => setImmediate(resolve));
    expect(svc.isS3Available()).toBe(true);
    return svc;
  }

  it('routes put, get and delete through a custom prefix, adding the missing trailing slash', async () => {
    mockSend.mockImplementation((cmd: unknown) =>
      Promise.resolve(cmd instanceof GetObjectCommand ? { Body: Readable.from([Buffer.from('x')]) } : {}),
    );
    const storage = await makeService('staging');

    await storage.putFile('x.bin', Buffer.from('x'));
    await storage.getFile('x.bin');
    await storage.deleteFile('x.bin');

    expect(inputs(PutObjectCommand)[0].Key).toBe('staging/x.bin');
    expect(inputs(GetObjectCommand)[0].Key).toBe('staging/x.bin');
    expect(inputs(DeleteObjectCommand)[0].Key).toBe('staging/x.bin');
  });

  it('S3_KEY_PREFIX in the environment wins over the config value', async () => {
    process.env.S3_KEY_PREFIX = 'from-env/';
    const storage = await makeService('from-config');

    await storage.putFile('x.bin', Buffer.from('x'));

    expect(inputs(PutObjectCommand)[0].Key).toBe('from-env/x.bin');
  });

  it('lists under the prefix and never yields a key outside it', async () => {
    mockSend.mockImplementation((cmd: unknown) =>
      Promise.resolve(
        cmd instanceof ListObjectsV2Command
          ? {
              Contents: [
                { Key: 'staging/chat-media/a', Size: 3 },
                { Key: 'staging-old/chat-media/b', Size: 5 },
                { Key: 'media/chat-media/c', Size: 7 },
              ],
            }
          : {},
      ),
    );
    const storage = await makeService('staging');

    const seen: string[] = [];
    for await (const key of storage.iterateFiles('chat-media/')) seen.push(key);
    expect(inputs(ListObjectsV2Command)[0].Prefix).toBe('staging/chat-media/');
    expect(seen).toEqual(['chat-media/a']);

    const { count, sizeBytes } = await storage.getFileCount();
    expect(inputs(ListObjectsV2Command)[1].Prefix).toBe('staging/');
    expect({ count, sizeBytes }).toEqual({ count: 1, sizeBytes: 3 });
  });

  it.each([undefined, '', '  '])('keeps the media/ root when the prefix is %j', async keyPrefix => {
    const storage = await makeService(keyPrefix);

    await storage.putFile('x.bin', Buffer.from('x'));

    expect(inputs(PutObjectCommand)[0].Key).toBe('media/x.bin');
  });
});

describe('S3_KEY_PREFIX sharing guidance', () => {
  // Listing uses the root as a plain key prefix, so a nested root (media/ and media/staging/) puts
  // the inner deployment's objects in the outer one's stats, export and orphan sweeps.
  it.each(['.env.example', 'docs/10-devops-infrastructure.md'])('%s rules out nested prefixes', file => {
    const text = fs
      .readFileSync(path.join(__dirname, '../../..', file), 'utf8')
      .replace(/^\s*# ?/gm, '')
      .replace(/\s+/g, ' ');
    expect(text).toContain('neither may start with the other');
  });
});
