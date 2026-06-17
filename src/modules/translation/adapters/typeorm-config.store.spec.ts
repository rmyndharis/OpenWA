// src/modules/translation/adapters/typeorm-config.store.spec.ts
import { Repository } from 'typeorm';
import { TypeOrmConfigStore } from './typeorm-config.store';
import { TranslationGroup } from '../entities/translation-group.entity';
import { GroupState } from '../core/ports';

describe('TypeOrmConfigStore', () => {
  function makeRepo(row: TranslationGroup | null): jest.Mocked<Partial<Repository<TranslationGroup>>> {
    return {
      findOne: jest.fn().mockResolvedValue(row),
      create: jest.fn().mockImplementation((data: Partial<TranslationGroup>) => ({ ...data }) as TranslationGroup),
      save: jest.fn().mockImplementation((e: unknown) => Promise.resolve(e)),
    };
  }

  function makeStore(repo: jest.Mocked<Partial<Repository<TranslationGroup>>>): TypeOrmConfigStore {
    return new TypeOrmConfigStore(repo as unknown as Repository<TranslationGroup>);
  }

  it('returns a default inactive state for an unknown group', async () => {
    const store = makeStore(makeRepo(null));
    const state = await store.load('s', 'g@g.us');
    expect(state).toMatchObject({ sessionId: 's', chatId: 'g@g.us', active: false, announced: false });
    expect(state.participants).toEqual({});
  });

  it('maps a stored row to GroupState (announced = announcedAt !== null)', async () => {
    const row = Object.assign(new TranslationGroup(), {
      sessionId: 's',
      chatId: 'g@g.us',
      active: true,
      participants: { '111@c.us': { lang: 'en', source: 'pinned', enabled: true, samples: 1, updatedAt: 'x' } },
      delegatedControllers: ['222@c.us'],
      announcedAt: new Date(),
    });
    const store = makeStore(makeRepo(row));
    const state = await store.load('s', 'g@g.us');
    expect(state.active).toBe(true);
    expect(state.announced).toBe(true);
    expect(state.delegatedControllers).toEqual(['222@c.us']);
  });

  it('save() upserts via the repository', async () => {
    const repo = makeRepo(null);
    const store = makeStore(repo);
    const state: GroupState = {
      sessionId: 's',
      chatId: 'g@g.us',
      active: true,
      participants: {},
      delegatedControllers: [],
      announced: true,
    };
    await store.save(state);
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's', chatId: 'g@g.us', active: true }));
  });
});
