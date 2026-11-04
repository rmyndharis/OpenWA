import 'reflect-metadata';
import { DataSource, Repository } from 'typeorm';
import { TemplateService } from './template.service';
import { Template } from './entities/template.entity';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { UpdateTemplateDto } from './dto';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('concurrent template edits', () => {
  let database: DataSource;
  let repository: Repository<Template>;
  let service: TemplateService;
  let id: string;

  beforeEach(async () => {
    database = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Template],
      synchronize: true,
      logging: false,
    });
    await database.initialize();
    const sessions = database.getRepository(Session);
    await sessions.save(
      sessions.create({ id: 'session-a', name: 'session-a', status: SessionStatus.READY, config: {} }),
      { transaction: false },
    );
    repository = database.getRepository(Template);
    service = new TemplateService(repository, sessions);
    id = (await service.create('session-a', { name: 'greeting', body: 'old-body', footer: 'old-footer' })).id;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (database?.isInitialized) await database.destroy();
  });

  const stallRead = () => {
    const entered = deferred();
    const release = deferred();
    const real = repository.findOne.bind(repository);
    jest.spyOn(repository, 'findOne').mockImplementationOnce(async options => {
      const row = await real(options);
      entered.resolve();
      await release.promise;
      return row;
    });
    return { entered: entered.promise, release: release.resolve };
  };

  it.each<[UpdateTemplateDto, UpdateTemplateDto, Partial<Template>]>([
    [{ body: 'new-body' }, { footer: 'new-footer' }, { body: 'new-body', footer: 'new-footer' }],
    [{ name: 'renamed' }, { body: 'new-body' }, { name: 'renamed', body: 'new-body' }],
    [{}, { body: 'new-body' }, { name: 'greeting', body: 'new-body' }],
  ])('preserves independently supplied fields: %j / %j', async (slowPatch, fastPatch, expected) => {
    const gate = stallRead();
    const slow = service.update('session-a', id, slowPatch);
    try {
      await gate.entered;
      await service.update('session-a', id, fastPatch);
    } finally {
      gate.release();
    }
    await slow;
    expect(await repository.findOneByOrFail({ id })).toMatchObject(expected);
  });

  it('returns404 rather than reinserting a template deleted during the edit', async () => {
    const gate = stallRead();
    const slow = service.update('session-a', id, { body: 'late-body' });
    const outcome = slow.then(
      () => undefined,
      error => error as { status: number },
    );
    try {
      await gate.entered;
      await service.delete('session-a', id);
    } finally {
      gate.release();
    }
    expect(await outcome).toMatchObject({ status: 404 });
    expect(await repository.countBy({ id })).toBe(0);
  });
});
