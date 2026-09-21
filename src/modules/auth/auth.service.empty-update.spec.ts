import 'reflect-metadata';
import { DataSource, Repository } from 'typeorm';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';
import { AuthService } from './auth.service';
import { ApiKeyUsageTracker } from './api-key-usage-tracker.service';
import type { UpdateApiKeyDto } from './dto/api-key.dto';

/**
 * Pins the empty-body semantics of update() against a REAL better-sqlite3 DataSource. Every
 * UpdateApiKeyDto field is optional, so `{}` is a legal request that must stay the historical
 * 200 no-op (the row returned unchanged). The unguarded path expresses this as a targeted UPDATE
 * whose set list is empty — TypeORM's entity-targeted update then stamps only `updatedAt`
 * (its empty-values branch appends the update-date column rather than throwing), which is easy
 * to break silently in a future rewrite of the statement builder, so it gets a dedicated spec.
 */
describe('AuthService update with an empty DTO', () => {
  let ds: DataSource;
  let repo: Repository<ApiKey>;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [ApiKey],
      synchronize: true,
    });
    await ds.initialize();
    repo = ds.getRepository(ApiKey);
  });

  afterAll(async () => {
    await ds.destroy();
  });

  it('is a 200-style no-op: resolves with the row, no columns change', async () => {
    const saved = await repo.save(
      repo.create({
        name: 'probe',
        keyPrefix: 'kp',
        keyHash: 'h',
        role: ApiKeyRole.ADMIN,
        isActive: true,
        allowedIps: null,
        allowedSessions: null,
        allowedChats: null,
        expiresAt: null,
        usageCount: 0,
      }),
    );

    const tracker = { record: jest.fn(), forget: jest.fn() } as unknown as ApiKeyUsageTracker;
    const service = new AuthService(repo, tracker, {} as never);
    const before = await repo.findOneByOrFail({ id: saved.id });

    const emptyDto = {} as UpdateApiKeyDto;
    await expect(service.update(saved.id, emptyDto)).resolves.toMatchObject({ id: saved.id, name: 'probe' });

    const after = await repo.findOneByOrFail({ id: saved.id });
    expect(after.role).toBe(before.role);
    expect(after.isActive).toBe(before.isActive);
    expect(after.name).toBe(before.name);
  });
});
