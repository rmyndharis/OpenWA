import { BadRequestException } from '@nestjs/common';
import { SessionEngineLifecycle } from './session-engine-lifecycle.service';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { Session, SessionStatus } from './entities/session.entity';

const ID = '99999999-9999-4999-8999-999999999999';

function fixture() {
  const stored = {
    id: ID,
    name: 'no-engine',
    phone: '628111',
    config: {},
    status: SessionStatus.READY,
    desiredState: null,
    nodeId: null,
  } as unknown as Session;
  const repository = {
    findOne: jest.fn(() => Promise.resolve({ ...stored })),
    exists: jest.fn(() => Promise.resolve(true)),
    update: jest.fn((_where: unknown, patch: Partial<Session>) => {
      Object.assign(stored, patch);
      return Promise.resolve({ affected: 1 });
    }),
  };
  const lifecycle = new SessionEngineLifecycle(
    repository as never,
    { options: { type: 'better-sqlite3' } } as never,
    { create: jest.fn(), purgeSessionData: jest.fn() } as never,
    new EngineRegistry(),
    { clear: jest.fn() } as never,
    {} as never,
    { attachTo: <T>(value: T): T => value, clear: jest.fn(), set: jest.fn(), get: jest.fn() } as never,
    { attachTo: <T>(value: T): T => value, clear: jest.fn(), clearIfDisprovedByReady: jest.fn() } as never,
    { clear: jest.fn(), getOwnIntent: jest.fn() } as never,
    {
      emitSessionStatus: jest.fn(),
      emitSessionDisconnected: jest.fn(),
      emitSessionAuthenticated: jest.fn(),
      emitQRCode: jest.fn(),
    } as never,
    { dispatch: jest.fn().mockResolvedValue(undefined) } as never,
    { execute: jest.fn().mockResolvedValue({ continue: true }) } as never,
    { clearSession: jest.fn() } as never,
    undefined,
    { isShuttingDown: () => false } as never,
    { logWarn: jest.fn().mockResolvedValue(undefined), logInfo: jest.fn().mockResolvedValue(undefined) } as never,
  );
  return { lifecycle, repository };
}

// SessionResponseDto.engineLoaded says what a lifecycle route does while the node holds no engine for the session:
// start acts, stop still answers and records the stop, logout and force-kill are refused.
describe('the lifecycle verbs of a session with no engine in memory', () => {
  it('stop answers with the row, disconnected, and runs the hook that records the stop', async () => {
    const { lifecycle, repository } = fixture();
    const afterRead = jest.fn().mockResolvedValue(undefined);

    const session = await lifecycle.stop(ID, { afterRead });

    expect(afterRead).toHaveBeenCalledTimes(1);
    expect(session.status).toBe(SessionStatus.DISCONNECTED);
    expect(repository.update).toHaveBeenCalledWith(expect.anything(), { status: SessionStatus.DISCONNECTED });
    await lifecycle.shutdown();
  });

  it.each(['logout', 'forceKill'] as const)('%s is refused with 400 and leaves the row as it was', async verb => {
    const { lifecycle, repository } = fixture();

    await expect(lifecycle[verb](ID)).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.update).not.toHaveBeenCalled();
    await lifecycle.shutdown();
  });
});
