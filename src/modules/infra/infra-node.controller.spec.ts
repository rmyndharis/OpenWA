import { Test, TestingModule } from '@nestjs/testing';
import { InfraNodeController } from './infra-node.controller';
import { SessionService } from '../session/session.service';
import { ShutdownService } from '../../common/services/shutdown.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';

describe('InfraNodeController', () => {
  let controller: InfraNodeController;
  const drain = jest.fn();
  const markShuttingDown = jest.fn();
  const logInfo = jest.fn().mockResolvedValue(null);

  beforeEach(async () => {
    drain.mockResolvedValue({ stoppedEngines: 3, abandonedClaims: 3, leaseTtlMs: 60_000 });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InfraNodeController],
      providers: [
        { provide: SessionService, useValue: { drain } },
        { provide: ShutdownService, useValue: { markShuttingDown } },
        { provide: AuditService, useValue: { logInfo } },
      ],
    }).compile();

    controller = module.get(InfraNodeController);
  });

  afterEach(() => {
    drain.mockReset();
    markShuttingDown.mockReset();
    logInfo.mockClear();
  });

  it('flips readiness BEFORE tearing down engines, so the LB pulls the node during the teardown', async () => {
    const order: string[] = [];
    markShuttingDown.mockImplementation(() => order.push('readiness'));
    drain.mockImplementation(() => {
      order.push('drain');
      return Promise.resolve({ stoppedEngines: 0, abandonedClaims: 0, leaseTtlMs: 60_000 });
    });

    await controller.drain();

    expect(order).toEqual(['readiness', 'drain']);
  });

  it('reports the drain summary and audits it', async () => {
    const result = await controller.drain();

    expect(result.draining).toBe(true);
    expect(result.stoppedEngines).toBe(3);
    expect(result.abandonedClaims).toBe(3);
    expect(result.leaseTtlMs).toBe(60_000);
    const auditedMetadata: unknown = expect.objectContaining({ stoppedEngines: 3, abandonedClaims: 3 });
    expect(logInfo).toHaveBeenCalledWith(
      AuditAction.INFRA_NODE_DRAINED,
      expect.objectContaining({ metadata: auditedMetadata }),
    );
  });

  it('still drains when no audit service is wired (single-process specs)', async () => {
    const bareModule: TestingModule = await Test.createTestingModule({
      controllers: [InfraNodeController],
      providers: [
        { provide: SessionService, useValue: { drain } },
        { provide: ShutdownService, useValue: { markShuttingDown } },
      ],
    }).compile();

    const bare = bareModule.get(InfraNodeController);
    const result = await bare.drain();

    expect(result.draining).toBe(true);
  });
});
