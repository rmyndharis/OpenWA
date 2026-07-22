import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { AddMessageAnnotations1782600000000 } from '../1782600000000-AddMessageAnnotations';

describe('AddMessageAnnotations migration', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
    await dataSource.initialize();
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('creates an idempotent, session-scoped typed annotation store and removes it on down', async () => {
    const runner = dataSource.createQueryRunner();
    const migration = new AddMessageAnnotations1782600000000();

    await migration.up(runner);
    await expect(migration.up(runner)).resolves.toBeUndefined();
    const annotations = await runner.getTable('message_annotations');
    expect(annotations?.primaryColumns.map(column => column.name)).toEqual([
      'sessionId',
      'messageId',
      'provider',
      'kind',
    ]);
    expect(annotations?.columns.map(column => column.name)).toEqual(
      expect.arrayContaining([
        'status',
        'language',
        'text',
        'mediaFingerprint',
        'processorVersion',
        'externalProcessing',
        'metadata',
        'createdAt',
        'expiresAt',
      ]),
    );

    await runner.query(
      `INSERT INTO message_annotations (sessionId, messageId, provider, kind, status, processorVersion, externalProcessing) ` +
        `VALUES ('s1', 'm1', 'provider', 'transcript', 'pending', '1.0.0', 0)`,
    );
    await expect(
      runner.query(
        `INSERT INTO message_annotations (sessionId, messageId, provider, kind, status, processorVersion, externalProcessing) ` +
          `VALUES ('s1', 'm1', 'provider', 'transcript', 'complete', '1.0.0', 0)`,
      ),
    ).rejects.toThrow();

    await migration.down(runner);
    expect(await runner.hasTable('message_annotations')).toBe(false);
    await runner.release();
  });
});
