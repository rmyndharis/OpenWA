import { DataSource, Repository } from 'typeorm';
import { AuditService } from './audit.service';
import { AuditLog, AuditAction, AuditSeverity } from './entities/audit-log.entity';
import type { ApiKey } from '../auth/entities/api-key.entity';
import { runWithRequestId, setRequestActor } from '../../common/services/request-context';

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

  it('log() clamps caller-supplied text to the column bounds before storing it', async () => {
    await service.log(AuditAction.API_KEY_AUTH_FAILED, {
      path: `/api/sessions/${'a'.repeat(16 * 1024)}`,
      userAgent: 'u'.repeat(2000),
      method: 'M'.repeat(50),
      errorMessage: 'e'.repeat(5000),
    });

    const row = (repo.create.mock.calls as unknown[][])[0][0] as Partial<AuditLog>;
    expect(row.path).toHaveLength(500);
    expect(row.path?.startsWith('/api/sessions/aaa')).toBe(true);
    expect(row.userAgent).toHaveLength(500);
    expect(row.method).toHaveLength(10);
    expect(row.errorMessage).toHaveLength(1000);
  });

  it('log() stores short text unchanged', async () => {
    await service.log(AuditAction.API_KEY_AUTH_FAILED, { path: '/api/sessions', method: 'GET', userAgent: 'curl/8' });
    const row = (repo.create.mock.calls as unknown[][])[0][0] as Partial<AuditLog>;
    expect(row).toEqual(
      expect.objectContaining({ path: '/api/sessions', method: 'GET', userAgent: 'curl/8', errorMessage: null }),
    );
  });

  // Most call sites fire from deep services that do not have the key in scope, so log() takes the key, the
  // client IP and the request id from the active request. Explicit context values still win (a worker that
  // stamps a system key, or an auth failure that only has an IP).
  describe('log() request context', () => {
    const storedRow = () => (repo.create.mock.calls as unknown[][])[0][0] as Partial<AuditLog>;

    it('stamps the key, client IP and request id of the active request', async () => {
      await runWithRequestId('req-1', async () => {
        setRequestActor({ apiKeyId: 'key-1', apiKeyName: 'dashboard', ipAddress: '203.0.113.7' });
        await service.log(AuditAction.SESSION_STARTED, { sessionId: 's1' });
      });

      expect(storedRow()).toEqual(
        expect.objectContaining({
          apiKeyId: 'key-1',
          apiKeyName: 'dashboard',
          ipAddress: '203.0.113.7',
          metadata: { requestId: 'req-1' },
        }),
      );
    });

    it('lets explicit context values win, and keeps caller metadata beside the request id', async () => {
      await runWithRequestId('req-2', async () => {
        setRequestActor({ apiKeyId: 'key-1', apiKeyName: 'dashboard', ipAddress: '203.0.113.7' });
        await service.log(AuditAction.SESSION_STARTED, {
          apiKey: { id: 'key-2', name: 'worker' } as ApiKey,
          ipAddress: '198.51.100.9',
          metadata: { reason: 'manual' },
        });
      });

      expect(storedRow()).toEqual(
        expect.objectContaining({
          apiKeyId: 'key-2',
          apiKeyName: 'worker',
          ipAddress: '198.51.100.9',
          metadata: { reason: 'manual', requestId: 'req-2' },
        }),
      );
    });

    it('stamps nothing outside a request: no actor columns and no metadata blob', async () => {
      await service.log(AuditAction.SESSION_STARTED, { sessionId: 's1' });

      expect(storedRow()).toEqual(
        expect.objectContaining({ apiKeyId: null, apiKeyName: null, ipAddress: null, metadata: null }),
      );
    });
  });

  it('logInfo/logWarn map to the right severity', async () => {
    await service.logInfo(AuditAction.API_KEY_USED);
    await service.logWarn(AuditAction.API_KEY_AUTH_FAILED);
    const severities = (repo.create.mock.calls as unknown[][]).map(c => (c[0] as { severity: AuditSeverity }).severity);
    expect(severities).toEqual([AuditSeverity.INFO, AuditSeverity.WARN]);
  });

  it('findAll applies provided filters with default take/skip', async () => {
    await service.findAll({ action: AuditAction.SESSION_STARTED, severity: AuditSeverity.INFO });
    expect(repo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { action: AuditAction.SESSION_STARTED, severity: AuditSeverity.INFO },
        order: { createdAt: 'DESC', id: 'DESC' },
        take: 50,
        skip: 0,
      }),
    );
  });

  it('findAll narrows to one acting key when apiKeyId is given', async () => {
    await service.findAll({ apiKeyId: 'key-1' });
    expect(repo.findAndCount).toHaveBeenCalledWith(expect.objectContaining({ where: { apiKeyId: 'key-1' } }));
  });

  it('findAll breaks createdAt ties by id, so offset pages over rows written in one second cannot overlap', async () => {
    await service.findAll({ limit: 200, offset: 200 });
    const arg = (repo.findAndCount.mock.calls as unknown[][])[0][0] as { order: Record<string, string> };
    expect(arg.order).toEqual({ createdAt: 'DESC', id: 'DESC' });
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

  it('findAll passes an in-range limit and offset through to the query', async () => {
    await service.findAll({ limit: 10, offset: 5 });
    const arg = (repo.findAndCount.mock.calls as unknown[][])[0][0] as { take: number; skip: number };
    expect(arg.take).toBe(10);
    expect(arg.skip).toBe(5);
  });

  it('findAll bounds an offset past the largest safe integer, however it was written', async () => {
    for (const offset of [2 ** 63, 1e21, Infinity]) {
      repo.findAndCount.mockClear();
      await service.findAll({ offset });
      const arg = (repo.findAndCount.mock.calls as unknown[][])[0][0] as { skip: number };
      expect(arg.skip).toBe(Number.MAX_SAFE_INTEGER);
    }
  });

  it('cleanup deletes rows older than the cutoff and returns the affected count', async () => {
    repo.delete.mockResolvedValue({ affected: 7 });
    const removed = await service.cleanup(30);

    expect(removed).toBe(7);
    const arg = (repo.delete.mock.calls as unknown[][])[0][0] as { createdAt: unknown };
    const cutoff = (arg.createdAt as { value: Date }).value; // LessThan(cutoff)
    // Calendar days in local time, as the service counts them: a fixed 30 * 24h span is an hour off
    // whenever the window crosses a DST change.
    const expected = new Date();
    expected.setDate(expected.getDate() - 30);
    expect(Math.abs(cutoff.getTime() - expected.getTime())).toBeLessThan(10_000);
  });

  it('cleanup returns 0 when the driver reports a null affected count', async () => {
    repo.delete.mockResolvedValue({ affected: null });
    expect(await service.cleanup(10)).toBe(0);
  });
});

// The unit tests above stop at the value handed to the repository. A driver refuses an OFFSET of 2^63 or
// more (SQLite: "datatype mismatch"), so paging is also run against a real in-memory database.
describe('AuditService.findAll paging on a real database', () => {
  let ds: DataSource;
  let service: AuditService;

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [AuditLog], synchronize: true });
    await ds.initialize();
    const repo = ds.getRepository(AuditLog);
    service = new AuditService(repo);
    for (const sessionId of ['s1', 's2', 's3']) {
      await repo.save(repo.create({ action: AuditAction.SESSION_CREATED, severity: AuditSeverity.INFO, sessionId }));
    }
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('answers an empty page with the true total for an offset past the table, however large', async () => {
    for (const offset of [2 ** 62, 2 ** 63, 1e21, Infinity]) {
      await expect(service.findAll({ offset })).resolves.toEqual({ data: [], total: 3 });
    }
  });

  it('still pages: an offset inside the table skips that many rows', async () => {
    const { data, total } = await service.findAll({ limit: 10, offset: 2 });
    expect(data).toHaveLength(1);
    expect(total).toBe(3);
  });
});
