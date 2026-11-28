import { INestApplication } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PluginsController } from './plugins.controller';
import { PluginsService } from './plugins.service';
import { AuditService } from '../audit/audit.service';
import { REQUIRED_ROLE_KEY, UNRESTRICTED_KEY } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

describe('PluginsController authorization', () => {
  const reflector = new Reflector();

  // Plugin reads expose installed versions, non-secret config, and health/error text — privileged
  // inventory on par with the ADMIN-gated write routes and the infra controllers' convention. A
  // VIEWER/OPERATOR key (or a session-scoped key) must not be able to enumerate it via the raw API.
  // Install, update and uninstall run third-party code on the host.
  const adminOnly = [
    'findAll',
    'install',
    'installFromUrl',
    'catalog',
    'findOne',
    'healthCheck',
    'enable',
    'disable',
    'updateConfig',
    'getConfigUi',
    'updateSessionConfig',
    'updateSessions',
    'update',
    'uninstall',
  ] as const;

  it('lists every route handler, so a new route cannot skip the role check', () => {
    const proto = PluginsController.prototype as unknown as Record<string, unknown>;
    const routes = Object.getOwnPropertyNames(proto).filter(
      name => name !== 'constructor' && Reflect.getMetadata(PATH_METADATA, proto[name] as object) !== undefined,
    );
    expect([...routes].sort()).toEqual([...adminOnly].sort());
  });

  it.each(adminOnly)('%s requires the ADMIN role', method => {
    // Metadata lookup key, never invoked.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const handler = PluginsController.prototype[method];
    const role = reflector.get<ApiKeyRole | undefined>(REQUIRED_ROLE_KEY, handler);
    expect(role).toBe(ApiKeyRole.ADMIN);
  });

  it('updateSessions requires an unrestricted key because updateSessions replaces the complete active set', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const handler = PluginsController.prototype.updateSessions;
    expect(reflector.get<boolean>(UNRESTRICTED_KEY, handler)).toBe(true);
  });
});

describe('PluginsController.install() OpenAPI responses', () => {
  it('declares the 413 the upload size limit returns', () => {
    const responses = Reflect.getMetadata(
      'swagger/apiResponse',
      Object.getOwnPropertyDescriptor(PluginsController.prototype, 'install')!.value as object,
    ) as Record<string, unknown>;
    expect(Object.keys(responses)).toContain('413');
  });

  // The global ValidationPipe refuses an invalid body, or one carrying an undeclared field, with a 400.
  it.each(['updateConfig', 'updateSessionConfig', 'updateSessions'] as const)(
    'declares the validation 400 on %s',
    handler => {
      const responses = (Reflect.getMetadata(
        'swagger/apiResponse',
        Object.getOwnPropertyDescriptor(PluginsController.prototype, handler)!.value as object,
      ) ?? {}) as Record<string, { description?: string }>;
      expect(responses['400']?.description).toMatch(/validation/i);
    },
  );
});

describe('PluginsController.install() multipart limits', () => {
  let app: INestApplication<App>;
  const installPackage = jest.fn().mockResolvedValue({ id: 'demo', version: '1.0.0' });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [PluginsController],
      providers: [
        { provide: PluginsService, useValue: { installPackage } },
        { provide: AuditService, useValue: { logInfo: jest.fn() } },
      ],
    }).compile();
    app = mod.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => installPackage.mockClear());

  it('rejects extra non-file fields and extra files on multipart plugin install while allowing a single file', async () => {
    const extraField = await request(app.getHttpServer())
      .post('/plugins/install')
      .field('extra', 'value')
      .attach('file', Buffer.from('PKzip'), 'plugin.zip');
    expect(extraField.status).toBeGreaterThanOrEqual(400);
    expect(installPackage).not.toHaveBeenCalled();

    const extraFile = await request(app.getHttpServer())
      .post('/plugins/install')
      .attach('file', Buffer.from('PKzip1'), 'a.zip')
      .attach('file', Buffer.from('PKzip2'), 'b.zip');
    expect(extraFile.status).toBeGreaterThanOrEqual(400);
    expect(installPackage).not.toHaveBeenCalled();

    const singleFile = await request(app.getHttpServer())
      .post('/plugins/install')
      .attach('file', Buffer.from('PKzip'), 'plugin.zip');
    expect(singleFile.status).toBe(201);
    expect(installPackage).toHaveBeenCalledTimes(1);
  });
});
