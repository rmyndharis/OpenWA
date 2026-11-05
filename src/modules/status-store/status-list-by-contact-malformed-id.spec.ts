import { DataSource, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { StorageService } from '../../common/storage/storage.service';
import type { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import { resolveJidCandidates } from '../../engine/identity/jid-candidates';
import { StatusUpdate } from './entities/status-update.entity';
import { StatusStoreService } from './status-store.service';

const config = { get: (_key: string, def?: unknown) => def } as unknown as ConfigService;

/**
 * A contact's statuses are looked up by every form of that person's id, the expansion the message filters and
 * the chat fence share (resolveJidCandidates). An id that names no individual, such as one with two `@`
 * (refused as a chat id everywhere else since multi-`@` ids were closed), or the id of a group or a channel,
 * has no other form: it must match only itself, not be read as the phone number before its first `@`.
 */
describe('StatusStoreService.listByContact with an id that names no individual', () => {
  let ds: DataSource;
  let repository: Repository<StatusUpdate>;

  beforeAll(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [StatusUpdate], synchronize: true });
    await ds.initialize();
    repository = ds.getRepository(StatusUpdate);
  });

  beforeEach(async () => {
    await repository.clear();
  });

  afterAll(async () => {
    if (ds.isInitialized) await ds.destroy();
  });

  const lidStore = {
    findPhoneForLid: jest.fn().mockResolvedValue(null),
    findLidsForPhone: jest.fn().mockResolvedValue([]),
    resolveLid: jest.fn().mockReturnValue(null),
  } as unknown as LidMappingStoreService;

  const storeWithAStatusOfPhone = async (): Promise<StatusStoreService> => {
    const svc = new StatusStoreService(repository, {} as StorageService, config, lidStore);
    await svc.ingest('sess', { waStatusId: 's1', contactJid: '628111111111@c.us', type: 'text', postedAt: Date.now() });
    return svc;
  };

  it.each(['628111111111:0@g.us@c.us', '628111111111@c.us@g.us'])(
    'answers %p with nothing of 628111111111, as the shared id expansion does',
    async query => {
      const svc = await storeWithAStatusOfPhone();

      // The shared expansion keeps such an id to its literal form.
      await expect(resolveJidCandidates(query)).resolves.toEqual([query]);

      const out = await svc.listByContact('sess', query);
      expect(out.map(s => s.contact.id)).toEqual([]);
    },
  );

  it.each(['628111111111@g.us', '628111111111@newsletter', '628111111111@broadcast'])(
    'answers the id %p of another kind with nothing of the phone that spells the same digits',
    async query => {
      const svc = await storeWithAStatusOfPhone();

      const out = await svc.listByContact('sess', query);
      expect(out.map(s => s.contact.id)).toEqual([]);
    },
  );

  it.each(['628111111111@c.us', '628111111111@s.whatsapp.net', '628111111111:5@s.whatsapp.net', '628111111111'])(
    'still answers the phone as %p with its statuses',
    async query => {
      const svc = await storeWithAStatusOfPhone();

      const out = await svc.listByContact('sess', query);
      expect(out.map(s => s.contact.id)).toEqual(['628111111111@c.us']);
    },
  );
});
