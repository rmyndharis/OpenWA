import { DataSource } from 'typeorm';
import { SessionService } from './session.service';
import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { SessionErrorStore } from './session-error-store.service';
import { SessionOwnershipService } from './session-ownership.service';
import { SessionRestrictionStore } from './session-restriction-store.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';

const GONE = '99999999-9999-4999-8999-999999999999';
const KEPT = '11111111-1111-4111-8111-111111111111';

const anyFn = (): unknown =>
  new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : jest.fn().mockResolvedValue(undefined)) });

/** The real SessionService, lifecycle and engine controls, with real error and restriction stores. */
function build(ownership?: SessionOwnershipService) {
  const errors = new SessionErrorStore();
  const restrictions = new SessionRestrictionStore();
  const presence = { clear: jest.fn(), getOwnIntent: jest.fn(), setOwnIntent: jest.fn() };
  const registry = new EngineRegistry();
  const lifecycle = new SessionEngineLifecycle(
    {} as never,
    {} as never,
    {} as never,
    registry,
    { clear: jest.fn(), start: jest.fn(), stop: jest.fn() } as never,
    {} as never,
    errors,
    restrictions,
    presence as never,
    anyFn() as never,
    anyFn() as never,
    anyFn() as never,
    anyFn() as never,
  );
  const service = new SessionService(
    {} as never,
    {} as never,
    {} as never,
    registry,
    {} as never,
    errors,
    restrictions,
    {} as never,
    {} as never,
    lifecycle,
    {} as never,
    undefined,
    ownership,
  );
  return { service, errors, restrictions, presence };
}

// An infra import replaces the sessions table without a delete, so the sessions it drops never pass through the
// delete's own cleanup. What this process keeps for them (a restriction that has no expiry above all, which the
// restricted-sessions gauge counts) must go once the import has committed.
describe('what a session whose row is gone leaves in memory', () => {
  it('forgetSession() drops the restriction and the error entry of that session only', () => {
    const { service, errors, restrictions, presence } = build();
    for (const id of [GONE, KEPT]) {
      restrictions.set(id, { kind: 'tos_block', code: 'TOS_BLOCK' });
      errors.set(id, 'Account blocked');
    }

    service.forgetSession(GONE);

    expect(restrictions.get(GONE)).toBeUndefined();
    expect(errors.get(GONE)).toBeUndefined();
    expect(presence.clear).toHaveBeenCalledWith(GONE);
    expect(restrictions.size()).toBe(1);
    expect(restrictions.get(KEPT)).toEqual({ kind: 'tos_block', code: 'TOS_BLOCK' });
    expect(errors.get(KEPT)).toBe('Account blocked');
  });

  it('forgetSession() drops the claim this node held, so the next heartbeat reports no loss', async () => {
    const dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session],
      synchronize: true,
    });
    await dataSource.initialize();
    try {
      const sessions = dataSource.getRepository(Session);
      const row = await sessions.save(
        sessions.create({ name: 'removed', status: SessionStatus.DISCONNECTED, config: {} }),
      );
      const cfg = { get: (k: string) => ({ 'session.nodeId': 'node-a', 'session.leaseTtlMs': 60_000 })[k] } as never;
      const ownership = new SessionOwnershipService(sessions, cfg);
      const lost = jest.fn();
      ownership.onLeaseLoss(lost);
      expect(await ownership.claim(row.id)).toBe(true);
      // The import's replace removes the row.
      await sessions.delete(row.id);

      build(ownership).service.forgetSession(row.id);
      await ownership.renew();

      expect(lost).not.toHaveBeenCalled();
    } finally {
      await dataSource.destroy();
    }
  });
});
