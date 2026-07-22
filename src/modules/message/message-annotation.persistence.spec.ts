import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { MessageAnnotation } from './entities/message-annotation.entity';
import { AddMessageAnnotations1782600000000 } from '../../database/migrations/1782600000000-AddMessageAnnotations';

/**
 * MessageAnnotationService's own spec mocks the repository, so it cannot catch a disagreement between
 * the entity and the migration that creates its table. This drives a real better-sqlite3 DataSource
 * through the migration and the entity to keep that contract honest — notably that `createdAt` stays a
 * bare @CreateDateColumn (a dateColumnType()/DateTransformer pairing writes NULL into a NOT NULL column
 * on SQLite and breaks every annotation write).
 */
describe('MessageAnnotation entity vs migration (real sqlite)', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [MessageAnnotation],
      migrations: [AddMessageAnnotations1782600000000],
      synchronize: false,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('round-trips through the migrated schema and dedupes on the composite key', async () => {
    const repo = dataSource.getRepository(MessageAnnotation);
    const expires = new Date('2027-01-02T03:04:05.000Z');
    const key = { sessionId: 's1', messageId: 'm1', provider: 'p1', kind: 'transcript' as const };

    await repo.upsert(
      {
        ...key,
        status: 'complete',
        language: 'en',
        text: 'hello world',
        mediaFingerprint: null,
        processorVersion: '1.0.0',
        externalProcessing: false,
        metadata: { confidence: 0.9, engine: 'x' },
        expiresAt: expires,
      },
      { conflictPaths: ['sessionId', 'messageId', 'provider', 'kind'] },
    );

    const first = await repo.findOneByOrFail(key);
    expect(first.createdAt instanceof Date && !Number.isNaN(first.createdAt.getTime())).toBe(true);
    expect(first.expiresAt?.getTime()).toBe(expires.getTime());
    expect(first.metadata).toEqual({ confidence: 0.9, engine: 'x' });
    expect(first.externalProcessing).toBe(false);
    expect(first.text).toBe('hello world');

    await repo.upsert(
      {
        ...key,
        status: 'failed',
        language: null,
        text: null,
        mediaFingerprint: null,
        processorVersion: '1.0.1',
        externalProcessing: true,
        metadata: null,
        expiresAt: null,
      },
      { conflictPaths: ['sessionId', 'messageId', 'provider', 'kind'] },
    );

    const all = await repo.find();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('failed');
    expect(all[0].externalProcessing).toBe(true);
    expect(all[0].expiresAt).toBeNull();
    expect(all[0].metadata).toBeNull();
  });
});
