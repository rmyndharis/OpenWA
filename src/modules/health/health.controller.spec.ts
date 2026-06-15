import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ShutdownService } from '../../common/services/shutdown.service';

describe('HealthController', () => {
  let controller: HealthController;
  const mainQuery = jest.fn();
  const dataQuery = jest.fn();
  const isShuttingDown = jest.fn();

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
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  afterEach(() => {
    mainQuery.mockReset();
    dataQuery.mockReset();
    isShuttingDown.mockReset();
  });

  describe('check', () => {
    it('returns ok with a timestamp (static)', () => {
      const result = controller.check();
      expect(result.status).toBe('ok');
      expect(result.timestamp).toBeDefined();
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
