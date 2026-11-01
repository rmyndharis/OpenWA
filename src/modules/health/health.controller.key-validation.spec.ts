import 'reflect-metadata';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ModuleRef } from '@nestjs/core';
import type { Request } from 'express';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AuditAction, AuditLog } from '../audit/entities/audit-log.entity';
import { ApiKeyUsageTracker } from '../auth/api-key-usage-tracker.service';
import { AuthService } from '../auth/auth.service';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { SlidingWindowLimiter } from '../events/ws-rate-limit';
import type { ShutdownService } from '../../common/services/shutdown.service';
import { HealthController } from './health.controller';

describe('HealthController key validation failure and limiter refund', () => {
  const CLIENT_IP = '203.0.113.42';

  let ds: DataSource;
  let keys: Repository<ApiKey>;
  let audits: Repository<AuditLog>;
  let authService: AuthService;
  let auditService: AuditService;
  let logWarnSpy: jest.SpyInstance;
  let controller: HealthController;

  const reqWith = (apiKey?: string, ip = CLIENT_IP): Request =>
    ({
      method: 'GET',
      path: '/api/health',
      headers: apiKey !== undefined ? { 'x-api-key': apiKey } : {},
      socket: { remoteAddress: ip },
    }) as unknown as Request;

  const flushAuditWrites = async (): Promise<void> => {
    await Promise.all(logWarnSpy.mock.results.map(r => r.value as Promise<unknown>));
  };

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ApiKey, AuditLog],
      synchronize: true,
    });
    await ds.initialize();
    keys = ds.getRepository(ApiKey);
    audits = ds.getRepository(AuditLog);
  });

  afterAll(async () => {
    await ds.destroy();
  });

  beforeEach(async () => {
    await audits.clear();
    await keys.clear();
    authService = new AuthService(keys, new ApiKeyUsageTracker(keys), { get: () => undefined } as unknown as ModuleRef);
    auditService = new AuditService(audits);
    logWarnSpy = jest.spyOn(auditService, 'logWarn');
    controller = new HealthController(
      ds,
      ds,
      { isShuttingDown: () => false } as unknown as ShutdownService,
      authService,
      { get: () => undefined } as unknown as ConfigService,
      auditService,
    );
  });

  it('audits no credential probe when the key store fails to read, keeps the slot spent, and logs the failure once', async () => {
    (controller as unknown as { keyValidationLimiter: SlidingWindowLimiter }).keyValidationLimiter =
      new SlidingWindowLimiter(3, 60_000);
    const logger = (controller as unknown as { logger: { error: (message: string, trace?: string) => void } }).logger;
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { rawKey } = await authService.createApiKey({ name: 'health monitor', role: ApiKeyRole.VIEWER });
    const findOne = jest
      .spyOn(keys, 'findOne')
      .mockRejectedValue(new QueryFailedError('SELECT', [], new Error('SQLITE_IOERR: disk I/O error')));

    for (let probe = 0; probe < 5; probe++) {
      const res = await controller.check(reqWith(rawKey));
      expect(res.status).toBe('ok');
      expect(res).not.toHaveProperty('version');
    }
    await flushAuditWrites();

    // The budget bounds the lookups that reach the failing store: the fourth and fifth never get there.
    expect(findOne).toHaveBeenCalledTimes(3);
    expect(logWarnSpy).not.toHaveBeenCalled();
    const rows = await audits.find({ where: { action: AuditAction.API_KEY_AUTH_FAILED } });
    expect(rows).toHaveLength(0);
    // Operators hear of it, once rather than once per probe.
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('still audits and charges the limiter budget on 401 and 403 credential refusals', async () => {
    (controller as unknown as { keyValidationLimiter: SlidingWindowLimiter }).keyValidationLimiter =
      new SlidingWindowLimiter(2, 60_000);
    const validateSpy = jest
      .spyOn(authService, 'validateApiKey')
      .mockRejectedValueOnce(new UnauthorizedException('Invalid API key'))
      .mockRejectedValueOnce(new ForbiddenException('IP address not allowed'))
      .mockResolvedValue({ id: 'k1', name: 'valid' } as ApiKey);

    await controller.check(reqWith('bad-key'));
    await controller.check(reqWith('ip-denied-key'));
    const blocked = await controller.check(reqWith('good-key'));
    await flushAuditWrites();

    expect(blocked).not.toHaveProperty('version');
    expect(validateSpy).toHaveBeenCalledTimes(2);
    const rows = await audits.find({ where: { action: AuditAction.API_KEY_AUTH_FAILED } });
    expect(rows).toHaveLength(2);
  });

  it.each([false, true])(
    'keeps newer failed presentations charged after a delayed valid presentation (pruned: %s)',
    async pruned => {
      let now = 0;
      let finishValid!: (key: unknown) => void;
      const pendingValid = new Promise(resolve => {
        finishValid = resolve;
      });
      const validateSpy = jest
        .spyOn(authService, 'validateApiKey')
        .mockImplementation((raw: string) =>
          raw === 'good-key'
            ? (pendingValid as Promise<ApiKey>)
            : Promise.reject(new UnauthorizedException('Invalid API key')),
        );
      (controller as unknown as { keyValidationLimiter: SlidingWindowLimiter }).keyValidationLimiter =
        new SlidingWindowLimiter(2, 1000, () => now);

      const validCheck = controller.check(reqWith('good-key'));
      now = pruned ? 1001 : 500;
      await controller.check(reqWith('bad-1'));

      now = pruned ? 1002 : 600;
      finishValid({ id: 'k1', name: 'valid' });
      const validResult = await validCheck;
      expect(validResult.version).toBeDefined();

      now = pruned ? 1003 : 1001;
      await controller.check(reqWith('bad-2'));
      await controller.check(reqWith('bad-3'));
      await flushAuditWrites();

      expect(validateSpy).toHaveBeenCalledTimes(3);
    },
  );
});
