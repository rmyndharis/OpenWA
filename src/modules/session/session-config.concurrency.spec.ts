import { ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Session } from './entities/session.entity';
import { SessionService } from './session.service';
import { EngineRegistry } from '../../engine/engine-registry.service';

/**
 * PATCH /config merges into the stored blob. Two overlapping requests that each read the same blob
 * before either writes must not have the later write drop the earlier one's key. Run against a real
 * database, because the race lives between the read and the write.
 */
describe('SessionService.updateConfig under concurrent requests', () => {
  let ds: DataSource;
  let service: SessionService;

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

  it('keeps every key when two patches overlap', async () => {
    const { id } = await ds.getRepository(Session).save({ name: 'cfg-race', config: { operatorKey: 'keep' } });

    await Promise.all([
      service.updateConfig(id, { autoRejectCalls: true }),
      service.updateConfig(id, { maxReconnectAttempts: 5 }),
      service.updateConfig(id, { reconnectBaseDelay: 9000 }),
    ]);

    const stored = await ds.getRepository(Session).findOneByOrFail({ id });
    expect(stored.config).toEqual({
      operatorKey: 'keep',
      autoRejectCalls: true,
      maxReconnectAttempts: 5,
      reconnectBaseDelay: 9000,
    });
  });

  // The swap compares the stored text exactly, so a row not written by JSON.stringify must still update.
  it('updates a row whose stored text is not in the form this process writes', async () => {
    const { id } = await ds.getRepository(Session).save({ name: 'cfg-spaced', config: {} });
    await ds.query(`UPDATE sessions SET config = '{ "operatorKey" : "keep" }' WHERE id = ?`, [id]);

    await expect(service.updateConfig(id, { autoRejectCalls: true })).resolves.toMatchObject({ autoRejectCalls: true });

    const stored = await ds.getRepository(Session).findOneByOrFail({ id });
    expect(stored.config).toEqual({ operatorKey: 'keep', autoRejectCalls: true });
  });

  // A request that keeps losing the race must not loop for ever.
  it('gives up with 409 when the config keeps changing underneath it', async () => {
    const { id } = await ds.getRepository(Session).save({ name: 'cfg-contended', config: {} });
    const update = jest.spyOn(ds.getRepository(Session), 'update').mockResolvedValue({ affected: 0 } as never);
    try {
      await expect(service.updateConfig(id, { autoRejectCalls: true })).rejects.toBeInstanceOf(ConflictException);
      expect(update).toHaveBeenCalledTimes(5);
    } finally {
      update.mockRestore();
    }
  });

  it('answers 404 for a session that does not exist', async () => {
    await expect(
      service.updateConfig('00000000-0000-4000-8000-000000000000', { autoRejectCalls: true }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
