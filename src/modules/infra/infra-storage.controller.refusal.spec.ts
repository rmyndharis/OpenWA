import * as fs from 'fs';
import type { Server } from 'http';
import * as os from 'os';
import * as path from 'path';
import type { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { StorageService } from '../../common/storage/storage.service';
import { InfraStorageController } from './infra-storage.controller';

/**
 * The count and the export refuse a store the walk cannot enumerate completely, because an answer that leaves
 * files out would lose them on the next backend. That refusal has to reach the ADMIN who runs the migration with
 * its cause, not as a bare 500, and only that refusal: any other failure stays an internal error.
 */
describe('GET /infra/storage/files/count and GET /infra/storage/export over a store the walk refuses', () => {
  let tmp: string;
  let media: string;
  let app: INestApplication;
  let storage: StorageService;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-refusal-'));
    media = path.join(tmp, 'media');
    fs.mkdirSync(media, { recursive: true });
    fs.writeFileSync(path.join(media, 'real.bin'), 'real');
    // The export writes under <cwd>/data/exports.
    jest.spyOn(process, 'cwd').mockReturnValue(tmp);
    storage = new StorageService({
      get: (key: string) => ({ 'storage.type': 'local', 'storage.localPath': media })[key],
    } as unknown as ConfigService);
    const moduleRef = await Test.createTestingModule({
      controllers: [InfraStorageController],
      providers: [{ provide: StorageService, useValue: storage }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    storage.onModuleDestroy();
    jest.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A mode-000 directory is still readable by root, so the failure is injected for the one path. */
  const failReaddirAt = (suffix: string, code: string): void => {
    const error = Object.assign(new Error(`${code}: cannot read ${path.join(media, suffix)}`), { code });
    const readdir = fs.promises.readdir.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    jest
      .spyOn(fs.promises, 'readdir')
      .mockImplementation(((target: fs.PathLike, ...rest: unknown[]) =>
        String(target).endsWith(path.join(media, suffix)) ? Promise.reject(error) : readdir(target, ...rest)) as never);
  };

  const linkMediaAway = (): void => {
    fs.mkdirSync(path.join(tmp, 'bigdisk'));
    fs.writeFileSync(path.join(tmp, 'bigdisk', 'archived.bin'), 'archived');
    fs.symlinkSync(path.join(tmp, 'bigdisk'), path.join(media, 'chat-media'));
  };

  const exportsLeft = (): string[] => {
    const dir = path.join(tmp, 'data', 'exports');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };

  it.each(['/infra/storage/files/count', '/infra/storage/export'])(
    'answers 409 naming the symbolic link, and not the host path, for %s',
    async route => {
      linkMediaAway();

      const response = await request(app.getHttpServer() as Server).get(route);

      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        statusCode: 409,
        message: 'Storage path is a symbolic link and is not followed: chat-media',
        error: 'Conflict',
      });
      expect(JSON.stringify(response.body)).not.toContain(tmp);
      expect(exportsLeft()).toEqual([]);
    },
  );

  it.each(['/infra/storage/files/count', '/infra/storage/export'])(
    'answers 409 naming a directory the app cannot read, and the cause, for %s',
    async route => {
      fs.mkdirSync(path.join(media, 'locked'));
      failReaddirAt('locked', 'EACCES');

      const response = await request(app.getHttpServer() as Server).get(route);

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        statusCode: 409,
        message: 'Storage directory cannot be read: locked (EACCES)',
      });
      expect(JSON.stringify(response.body)).not.toContain(tmp);
    },
  );

  it.each(['/infra/storage/files/count', '/infra/storage/export'])(
    'still answers 500 for a failure that is not a refusal of the walk, for %s',
    async route => {
      fs.mkdirSync(path.join(media, 'broken'));
      failReaddirAt('broken', 'EIO');

      const response = await request(app.getHttpServer() as Server).get(route);

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ statusCode: 500, message: 'Internal server error' });
      expect(exportsLeft()).toEqual([]);
    },
  );

  it('counts a store with nothing to refuse', async () => {
    const response = await request(app.getHttpServer() as Server).get('/infra/storage/files/count');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ storageType: 'local', count: 1, sizeBytes: 4 });
  });
});
