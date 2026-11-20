import { SessionService } from './session.service';
import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { SessionErrorStore } from './session-error-store.service';
import { SessionRestrictionStore } from './session-restriction-store.service';
import { EngineRegistry } from '../../engine/engine-registry.service';

const GONE = '99999999-9999-4999-8999-999999999999';
const KEPT = '11111111-1111-4111-8111-111111111111';

const anyFn = (): unknown =>
  new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : jest.fn().mockResolvedValue(undefined)) });

// An infra import replaces the sessions table without a delete, so the sessions it drops never pass through the
// delete's own cleanup. What this process keeps for them (a restriction that has no expiry above all, which the
// restricted-sessions gauge counts) must go once the import has committed.
describe('what a session whose row is gone leaves in memory', () => {
  it('forgetSession() drops the restriction and the error entry of that session only', () => {
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
    );
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
});
