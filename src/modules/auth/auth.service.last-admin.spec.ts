import 'reflect-metadata';
import { ConflictException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { AuthService } from './auth.service';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';

/**
 * The last-admin guard against a REAL better-sqlite3 DataSource, for the part the in-memory double
 * cannot show: how long the surviving admin lasts. A survivor that expires before the key being
 * removed only postpones the lockout, so it must not let the removal through.
 */
describe('AuthService last-admin guard and expiring admins', () => {
  let ds: DataSource;
  let repo: Repository<ApiKey>;
  let service: AuthService;
  const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000);

  beforeAll(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [ApiKey], synchronize: true });
    await ds.initialize();
    repo = ds.getRepository(ApiKey);
    const tracker = { record: jest.fn(), forget: jest.fn() } as unknown as ApiKeyUsageTracker;
    service = new AuthService(repo, tracker, { get: () => undefined } as never);
  });

  afterAll(async () => {
    await ds.destroy();
  });

  beforeEach(async () => {
    await repo.clear();
  });

  const admin = async (name: string, expiresAt: Date | null): Promise<string> =>
    (
      await repo.save(
        repo.create({ name, keyPrefix: name, keyHash: name, role: ApiKeyRole.ADMIN, isActive: true, expiresAt }),
      )
    ).id;

  it('refuses to remove or expire a non-expiring admin when the only other admin expires', async () => {
    const a = await admin('a', null);
    const b = await admin('b', inHours(1));

    await expect(service.revoke(a)).rejects.toThrow(ConflictException);
    await expect(service.delete(a)).rejects.toThrow(ConflictException);
    await expect(service.update(a, { expiresAt: inHours(2).toISOString() })).rejects.toThrow(ConflictException);
    expect(await repo.findOneByOrFail({ id: a })).toMatchObject({ isActive: true, expiresAt: null });

    await expect(service.revoke(b)).resolves.toMatchObject({ isActive: false });
  });

  // The body of an update may carry role: null, which the validation lets through and the patch ignores: it changes
  // no role, so on the only admin it is no demotion.
  it('lets the only admin be renamed or restricted by IP when the body also carries role: null', async () => {
    const sole = await admin('sole', null);

    await expect(service.update(sole, { name: 'renamed', role: null } as never)).resolves.toMatchObject({
      name: 'renamed',
      role: ApiKeyRole.ADMIN,
    });
    await expect(service.update(sole, { allowedIps: ['10.0.0.0/8'], role: null } as never)).resolves.toMatchObject({
      role: ApiKeyRole.ADMIN,
    });
    await expect(service.update(sole, { role: ApiKeyRole.OPERATOR })).rejects.toThrow(ConflictException);
    expect((await repo.findOneByOrFail({ id: sole })).role).toBe(ApiKeyRole.ADMIN);
  });

  it('lets an expiring admin go when another admin lasts at least as long', async () => {
    const old = await admin('old', inHours(1));
    await admin('rotated', inHours(24 * 30));
    await expect(service.revoke(old)).resolves.toMatchObject({ isActive: false });

    await repo.clear();
    const longer = await admin('longer', inHours(24 * 30));
    await admin('shorter', inHours(1));
    await expect(service.delete(longer)).rejects.toThrow(ConflictException);

    await repo.clear();
    const first = await admin('first', null);
    await admin('second', null);
    await expect(service.delete(first)).resolves.toBeUndefined();
  });

  it('lets an expiring admin have its expiry pushed later, but not a demotion alongside it', async () => {
    const a = await admin('a', inHours(1));
    const b = await admin('b', inHours(0.5));
    await expect(service.update(a, { expiresAt: inHours(5).toISOString() })).resolves.toBeDefined();
    await expect(service.update(a, { expiresAt: inHours(72).toISOString() })).resolves.toBeDefined();
    await expect(service.update(a, { expiresAt: inHours(3).toISOString() })).rejects.toThrow(ConflictException);
    await expect(service.update(b, { expiresAt: inHours(0.75).toISOString() })).resolves.toBeDefined();

    await repo.clear();
    const sole = await admin('sole', inHours(1));
    await expect(service.update(sole, { expiresAt: inHours(5).toISOString() })).resolves.toBeDefined();
    await expect(
      service.update(sole, { expiresAt: inHours(10).toISOString(), role: ApiKeyRole.OPERATOR }),
    ).rejects.toThrow(ConflictException);
    expect(await repo.findOneByOrFail({ id: sole })).toMatchObject({ role: ApiKeyRole.ADMIN });
  });
});
