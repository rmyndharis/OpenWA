import { DataSource } from 'typeorm';
import { MAX_SESSION_CONFIG_BYTES } from './dto/recognised-session-config.validator';
import { Session } from './entities/session.entity';
import { SessionService } from './session.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { TABLE_IMPORTERS } from '../infra/table-importers';

/**
 * The bound applies to a config that is created. A row that already holds more (stored before the bound existed, or
 * restored from a backup) must keep loading and keep taking PATCH /config: the PATCH can add only the three
 * recognised scalar keys, and refusing it would leave the row's recognised keys unchangeable with no way to shrink
 * the blob through the API.
 */
describe('a session row whose config is over the create bound', () => {
  let ds: DataSource;
  let service: SessionService;
  const note = 'x'.repeat(4 * MAX_SESSION_CONFIG_BYTES);

  beforeAll(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [Session], synchronize: true });
    await ds.initialize();
    const attach = { attachTo: (s: Session) => s } as never;
    const unused = {} as never;
    service = new SessionService(
      ds.getRepository(Session),
      unused, // messages
      ds,
      new EngineRegistry(),
      unused, // watchdog
      attach, // session errors
      attach, // session restrictions
      unused, // presence
      unused, // hooks
      unused, // engine lifecycle
      unused, // lid mappings
    );
  });

  afterAll(async () => {
    await ds.destroy();
  });

  it('still loads through findOne and findAll', async () => {
    const { id } = await ds.getRepository(Session).save({ name: 'oversized-read', config: { note } });

    await expect(service.findOne(id)).resolves.toMatchObject({ id, config: { note } });
    await expect(service.findAll()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
  });

  it('still takes PATCH /config and keeps the keys it did not mention', async () => {
    const { id } = await ds.getRepository(Session).save({ name: 'oversized-patch', config: { note } });

    await expect(service.updateConfig(id, { autoRejectCalls: true })).resolves.toMatchObject({ autoRejectCalls: true });

    const stored = await ds.getRepository(Session).findOneByOrFail({ id });
    expect(stored.config).toEqual({ note, autoRejectCalls: true });
  });

  it('is kept by the session importer', () => {
    const sessions = TABLE_IMPORTERS.find(importer => importer.key === 'sessions');
    const skip = sessions?.skip as ((row: unknown) => string | null) | undefined;

    expect(skip?.({ id: 'sales-bot', name: 'sales', config: JSON.stringify({ note }) }) ?? null).toBeNull();
  });
});
