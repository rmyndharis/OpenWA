import { Repository, Between } from 'typeorm';
import { AuditService } from './audit.service';
import { AuditLog, AuditAction, AuditSeverity } from './entities/audit-log.entity';

describe('AuditService', () => {
  let service: AuditService;
  let repo: { create: jest.Mock; save: jest.Mock; findAndCount: jest.Mock; delete: jest.Mock };

  beforeEach(() => {
    repo = {
      create: jest.fn((e: Partial<AuditLog>) => e),
      save: jest.fn((e: Partial<AuditLog>) => Promise.resolve({ id: 'a1', ...e })),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    service = new AuditService(repo as unknown as Repository<AuditLog>);
  });

  it('log() persists the action/severity and null-coalesces absent context fields', async () => {
    await service.log(AuditAction.SESSION_CREATED, { sessionId: 's1' }, AuditSeverity.WARN);

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.SESSION_CREATED,
        severity: AuditSeverity.WARN,
        sessionId: 's1',
        apiKeyId: null,
        ipAddress: null,
        statusCode: null,
      }),
    );
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('logInfo/logWarn/logError map to the right severity', async () => {
    await service.logInfo(AuditAction.API_KEY_USED);
    await service.logWarn(AuditAction.API_KEY_AUTH_FAILED);
    await service.logError(AuditAction.MESSAGE_FAILED);
    const severities = (repo.create.mock.calls as unknown[][]).map(c => (c[0] as { severity: AuditSeverity }).severity);
    expect(severities).toEqual([AuditSeverity.INFO, AuditSeverity.WARN, AuditSeverity.ERROR]);
  });

  it('findAll applies provided filters with default take/skip', async () => {
    await service.findAll({ action: AuditAction.SESSION_STARTED, severity: AuditSeverity.INFO });
    expect(repo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { action: AuditAction.SESSION_STARTED, severity: AuditSeverity.INFO },
        order: { createdAt: 'DESC' },
        take: 50,
        skip: 0,
      }),
    );
  });

  it('findAll clamps an oversized limit to the max page size (prevents whole-table loads)', async () => {
    await service.findAll({ limit: 99_999_999 });
    const arg = (repo.findAndCount.mock.calls as unknown[][])[0][0] as { take: number };
    expect(arg.take).toBe(200);
  });

  it('findAll clamps a negative offset to 0 (no negative skip reaches the query)', async () => {
    await service.findAll({ offset: -5 });
    const arg = (repo.findAndCount.mock.calls as unknown[][])[0][0] as { skip: number };
    expect(arg.skip).toBe(0);
  });

  it('findAll uses Between only when BOTH dates are present', async () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const end = new Date('2026-02-01T00:00:00Z');
    await service.findAll({ startDate: start, endDate: end, limit: 10, offset: 5 });
    const arg = (repo.findAndCount.mock.calls as unknown[][])[0][0] as {
      where: Record<string, unknown>;
      take: number;
      skip: number;
    };
    expect(arg.where.createdAt).toEqual(Between(start, end));
    expect(arg.take).toBe(10);
    expect(arg.skip).toBe(5);

    repo.findAndCount.mockClear();
    await service.findAll({ startDate: start }); // only one date → no Between
    const arg2 = (repo.findAndCount.mock.calls as unknown[][])[0][0] as { where: Record<string, unknown> };
    expect(arg2.where.createdAt).toBeUndefined();
  });

  it('cleanup deletes rows older than the cutoff and returns the affected count', async () => {
    repo.delete.mockResolvedValue({ affected: 7 });
    const removed = await service.cleanup(30);

    expect(removed).toBe(7);
    const arg = (repo.delete.mock.calls as unknown[][])[0][0] as { createdAt: unknown };
    const cutoff = (arg.createdAt as { value: Date }).value; // LessThan(cutoff)
    const expected = Date.now() - 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(10_000);
  });

  it('cleanup returns 0 when the driver reports a null affected count', async () => {
    repo.delete.mockResolvedValue({ affected: null });
    expect(await service.cleanup(10)).toBe(0);
  });
});
