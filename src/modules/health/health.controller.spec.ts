import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { HealthController } from './health.controller';
import { ShutdownService } from '../../common/services/shutdown.service';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { SessionService } from '../session/session.service';

describe('HealthController', () => {
  let controller: HealthController;
  const mainQuery = jest.fn();
  const dataQuery = jest.fn();
  const isShuttingDown = jest.fn();
  const validateApiKey = jest.fn();
  const logWarn = jest.fn().mockResolvedValue(null);
  // /health/sessions delegates capacity math to the session capability service.
  const nodeSessionsHealth = jest.fn();

  const reqWith = (headers: Record<string, string> = {}): Request =>
    ({ headers, socket: { remoteAddress: '127.0.0.1' } }) as unknown as Request;

  beforeEach(async () => {
    mainQuery.mockResolvedValue([{ '1': 1 }]);
    dataQuery.mockResolvedValue([{ '1': 1 }]);
    isShuttingDown.mockReturnValue(false);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: getDataSourceToken('main'), useValue: { query: mainQuery } },
        { provide: getDataSourceToken('data'), useValue: { query: dataQuery } },
        { provide: ShutdownService, useValue: { isShuttingDown } },
        { provide: AuthService, useValue: { validateApiKey } },
        { provide: AuditService, useValue: { logWarn } },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: SessionService, useValue: { nodeSessionsHealth } },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  afterEach(() => {
    mainQuery.mockReset();
    dataQuery.mockReset();
    isShuttingDown.mockReset();
    validateApiKey.mockReset();
    logWarn.mockClear(); // keep the resolved value, drop cross-test call history
  });

  describe('check', () => {
    it('returns ok with a timestamp (static)', async () => {
      const result = await controller.check(reqWith());
      expect(result.status).toBe('ok');
      expect(result.timestamp).toBeDefined();
    });

    it('omits the version for an unauthenticated caller and never touches the key store', async () => {
      const result = await controller.check(reqWith());
      expect(result).not.toHaveProperty('version');
      expect(validateApiKey).not.toHaveBeenCalled();
    });

    it('omits the version when the presented key is invalid (the check itself still answers ok)', async () => {
      validateApiKey.mockRejectedValue(new UnauthorizedException('Invalid API key'));

      const result = await controller.check(reqWith({ 'x-api-key': 'wrong' }));

      expect(result.status).toBe('ok');
      expect(result).not.toHaveProperty('version');
    });

    it('reports the running version to a valid API key (X-API-Key header)', async () => {
      validateApiKey.mockResolvedValue({ id: 'k1' });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { version } = require('../../../package.json') as { version: string };

      const result = await controller.check(reqWith({ 'x-api-key': 'good-key' }));

      expect(result.version).toBe(version);
      expect(validateApiKey).toHaveBeenCalledWith('good-key', '127.0.0.1');
    });

    it('accepts a Bearer token the same way the guard does', async () => {
      validateApiKey.mockResolvedValue({ id: 'k1' });

      const result = await controller.check(reqWith({ authorization: 'Bearer good-key' }));

      expect(result.version).toBeDefined();
      expect(validateApiKey).toHaveBeenCalledWith('good-key', '127.0.0.1');
    });
  });

  describe('key-probe auditing', () => {
    it('audits a presented-but-invalid key like every other key-validation surface', async () => {
      validateApiKey.mockRejectedValue(new UnauthorizedException('Invalid API key'));

      const result = await controller.check(reqWith({ 'x-api-key': 'owa_k1_probe' }));

      expect(result.status).toBe('ok'); // the probe itself never fails
      expect(result).not.toHaveProperty('version');
      expect(logWarn).toHaveBeenCalledWith(AuditAction.API_KEY_AUTH_FAILED, {
        ipAddress: '127.0.0.1',
        method: undefined,
        path: undefined,
        errorMessage: 'Invalid API key',
      });
    });

    it('does not audit an absent key (uptime probes stay free of audit noise)', async () => {
      await controller.check(reqWith());

      expect(logWarn).not.toHaveBeenCalled();
    });

    it('does not audit a valid key', async () => {
      validateApiKey.mockResolvedValue({ id: 'k1' });

      await controller.check(reqWith({ 'x-api-key': 'owa_k1_valid' }));

      expect(logWarn).not.toHaveBeenCalled();
    });

    it('bounds the audit writes per source IP so a probe flood cannot fill the audit log', async () => {
      validateApiKey.mockRejectedValue(new UnauthorizedException('Invalid API key'));

      for (let i = 0; i < 15; i++) {
        await controller.check(reqWith({ 'x-api-key': `owa_k1_probe_${i}` }));
      }

      expect(logWarn).toHaveBeenCalledTimes(10);
    });
  });

  describe('liveness', () => {
    it('returns ok (static — does not probe dependencies)', () => {
      expect(controller.liveness().status).toBe('ok');
    });
  });

  describe('readiness', () => {
    it('returns ok when both databases respond', async () => {
      const result = await controller.readiness();
      expect(result.status).toBe('ok');
      expect(result.details.mainDatabase.status).toBe('up');
      expect(result.details.dataDatabase.status).toBe('up');
      expect(mainQuery).toHaveBeenCalledWith('SELECT 1');
      expect(dataQuery).toHaveBeenCalledWith('SELECT 1');
    });

    it('throws 503 when the data database is down', async () => {
      dataQuery.mockRejectedValue(new Error('connection refused'));
      await expect(controller.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('throws 503 when the main (auth/audit) database is down', async () => {
      mainQuery.mockRejectedValue(new Error('disk I/O error'));
      await expect(controller.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('throws 503 while draining, without even probing the DBs', async () => {
      isShuttingDown.mockReturnValue(true);
      await expect(controller.readiness()).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mainQuery).not.toHaveBeenCalled();
      expect(dataQuery).not.toHaveBeenCalled();
    });
  });

  describe('sessionsHealth', () => {
    it('reports the capability service snapshot with the draining flag layered on', async () => {
      nodeSessionsHealth.mockResolvedValue({
        nodeId: 'test-node',
        engines: 4,
        sessions: { assigned: 7, ready: 3, connecting: 2, actionRequired: 0, disconnected: 0, failed: 2 },
      });

      const result = await controller.sessionsHealth();

      expect(result.status).toBe('ok');
      expect(result.nodeId).toBe('test-node');
      expect(result.draining).toBe(false);
      expect(result.engines).toBe(4);
      expect(result.sessions).toEqual({
        assigned: 7,
        ready: 3,
        connecting: 2,
        actionRequired: 0,
        disconnected: 0,
        failed: 2,
      });
    });

    it('stays a 200 while draining and says so — capacity reporting must survive the drain window', async () => {
      isShuttingDown.mockReturnValue(true);
      nodeSessionsHealth.mockResolvedValue({ nodeId: 'test-node', engines: 0, sessions: { assigned: 0 } });

      const result = await controller.sessionsHealth();

      expect(result.draining).toBe(true);
      expect(result.engines).toBe(0);
      expect(result.sessions.assigned).toBe(0);
    });
  });
});
