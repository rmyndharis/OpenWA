import { DataSource, Repository } from 'typeorm';
import { BaileysAuthState } from './baileys-auth-state.entity';
import { BaileysAuthStateService } from './baileys-auth-state.service';

describe('BaileysAuthStateService', () => {
  let ds: DataSource;
  let repo: Repository<BaileysAuthState>;
  let service: BaileysAuthStateService;

  beforeEach(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [BaileysAuthState],
      synchronize: true,
    });
    await ds.initialize();
    repo = ds.getRepository(BaileysAuthState);
    service = new BaileysAuthStateService(repo);
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('round-trips values by (keyType, keyId) and reports only the ids that exist', async () => {
    await service.write('alpha', [
      { keyType: 'pre-key', keyId: '1', value: '{"a":1}' },
      { keyType: 'pre-key', keyId: '2', value: '{"a":2}' },
      { keyType: 'session', keyId: '1', value: '{"s":true}' },
    ]);

    const read = await service.read('alpha', 'pre-key', ['1', '2', 'missing']);

    expect(read).toEqual({ '1': '{"a":1}', '2': '{"a":2}' });
    // Same keyId under a different keyType is a different row — the composite key is the identity.
    expect(await service.read('alpha', 'session', ['1'])).toEqual({ '1': '{"s":true}' });
  });

  it('upserts on rewrite instead of failing the composite key', async () => {
    await service.write('alpha', [{ keyType: 'creds', keyId: 'creds', value: '{"v":1}' }]);
    await service.write('alpha', [{ keyType: 'creds', keyId: 'creds', value: '{"v":2}' }]);

    expect(await service.read('alpha', 'creds', ['creds'])).toEqual({ creds: '{"v":2}' });
    expect(await repo.count()).toBe(1);
  });

  it('treats a null value as a delete, in the same batch as upserts', async () => {
    await service.write('alpha', [
      { keyType: 'pre-key', keyId: '1', value: '{"a":1}' },
      { keyType: 'pre-key', keyId: '2', value: '{"a":2}' },
    ]);

    await service.write('alpha', [
      { keyType: 'pre-key', keyId: '1', value: null },
      { keyType: 'pre-key', keyId: '3', value: '{"a":3}' },
    ]);

    expect(await service.read('alpha', 'pre-key', ['1', '2', '3'])).toEqual({ '2': '{"a":2}', '3': '{"a":3}' });
  });

  it('scopes everything by session — a clear() removes one session and leaves its neighbors alone', async () => {
    await service.write('alpha', [{ keyType: 'creds', keyId: 'creds', value: '{}' }]);
    await service.write('beta', [{ keyType: 'creds', keyId: 'creds', value: '{}' }]);

    expect(await service.hasCreds('alpha')).toBe(true);
    await service.clear('alpha');

    expect(await service.hasCreds('alpha')).toBe(false);
    expect(await service.hasCreds('beta')).toBe(true);
  });

  it('answers empty for an empty id list without touching the database', async () => {
    expect(await service.read('alpha', 'pre-key', [])).toEqual({});
  });
});
