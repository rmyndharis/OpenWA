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

describe('HealthController', () => {
  let controller: HealthController;
  const mainQuery = jest.fn();
  const dataQuery = jest.fn();
  const isShuttingDown = jest.fn();
  const validateApiKey = jest.fn();
  const logWarn = jest.fn().mockResolvedValue(null);

  const reqWith = (headers: Record<string, string> = {}, ip = '127.0.0.1'): Request =>
    ({ headers, socket: { remoteAddress: ip } }) as unknown as Request;

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

    // The auth scheme is case-insensitive (RFC 7235), and the REST guard, Bull Board and MCP already
    // read it that way; an exact 'Bearer ' match here withheld the version from the same valid key.
    it.each(['bearer good-key', 'BEARER good-key'])('accepts the scheme in any case (%s)', async header => {
      validateApiKey.mockResolvedValue({ id: 'k1' });

      const result = await controller.check(reqWith({ authorization: header }));

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

  describe('key-probe audit bound for IPv6', () => {
    it('shares one audit budget across a /64 and records the full address', async () => {
      validateApiKey.mockRejectedValue(new UnauthorizedException('Invalid API key'));

      for (let i = 0; i < 15; i++) {
        await controller.check(reqWith({ 'x-api-key': 'owa_k1_probe' }, `2001:db8:1:2::${(i + 1).toString(16)}`));
      }
      expect(logWarn).toHaveBeenCalledTimes(10);
      expect(logWarn).toHaveBeenLastCalledWith(
        AuditAction.API_KEY_AUTH_FAILED,
        expect.objectContaining({ ipAddress: '2001:db8:1:2::a' }),
      );

      await controller.check(reqWith({ 'x-api-key': 'owa_k1_probe' }, '2001:db8:1:3::1'));
      expect(logWarn).toHaveBeenCalledTimes(11);
    });
  });

  describe('key-validation budget', () => {
    const presented = (ip?: string) => reqWith({ 'x-api-key': 'owa_k1_probe' }, ip);

    it('stops looking up keys for a client after 30 failed presentations a minute', async () => {
      validateApiKey.mockRejectedValue(new UnauthorizedException('Invalid API key'));

      for (let i = 0; i < 35; i++) {
        const result = await controller.check(presented());
        expect(result.status).toBe('ok');
        expect(result).not.toHaveProperty('version');
      }

      expect(validateApiKey).toHaveBeenCalledTimes(30);
    });

    it('keeps a separate budget per client, shared across one IPv6 /64', async () => {
      validateApiKey.mockRejectedValue(new UnauthorizedException('Invalid API key'));
      for (let i = 0; i < 35; i++) await controller.check(presented());
      await controller.check(presented('192.0.2.9'));
      expect(validateApiKey).toHaveBeenCalledTimes(31);

      validateApiKey.mockClear();
      for (let i = 0; i < 35; i++) await controller.check(presented(`2001:db8:1:2::${(i + 1).toString(16)}`));
      expect(validateApiKey).toHaveBeenCalledTimes(30);
      await controller.check(presented('2001:db8:1:3::1'));
      expect(validateApiKey).toHaveBeenCalledTimes(31);
    });

    it('never spends the budget on a key that validates', async () => {
      validateApiKey.mockResolvedValue({ id: 'k1' });

      for (let i = 0; i < 40; i++) {
        expect((await controller.check(presented())).version).toBeDefined();
      }

      expect(validateApiKey).toHaveBeenCalledTimes(40);
    });

    it('does not charge keyless probes', async () => {
      for (let i = 0; i < 40; i++) await controller.check(reqWith());
      validateApiKey.mockRejectedValue(new UnauthorizedException('Invalid API key'));

      await controller.check(presented());

      expect(validateApiKey).toHaveBeenCalledTimes(1);
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
});
