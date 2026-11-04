import { Repository } from 'typeorm';
import { Session, SessionStatus } from './entities/session.entity';
import { SessionStatusBroadcaster } from './session-status-broadcaster';

/**
 * Direct coverage for the session-status fan-out: persist first, then mirror to WS and webhooks,
 * de-duped per status value (some engines signal one transition via BOTH onStateChanged and a
 * dedicated callback). Until now pinned only through the session-service suite's white-box pokes on
 * the lifecycle's lastDispatchedStatus alias.
 */
describe('SessionStatusBroadcaster', () => {
  const make = () => {
    const update = jest.fn().mockResolvedValue({ affected: 1 });
    const repository = { update } as unknown as Repository<Session>;
    const emitSessionStatus = jest.fn();
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const broadcaster = new SessionStatusBroadcaster({
      sessionRepository: repository,
      eventsGateway: { emitSessionStatus } as never,
      webhookService: { dispatch } as never,
      logger: console as never,
    });
    return { broadcaster, update, emitSessionStatus, dispatch };
  };

  it('persists the status BEFORE mirroring it (the row is the source of truth)', async () => {
    const { broadcaster, update, emitSessionStatus } = make();
    await broadcaster.updateStatus('s1', SessionStatus.READY);
    expect(update).toHaveBeenCalledWith('s1', { status: SessionStatus.READY });
    expect(emitSessionStatus).toHaveBeenCalledWith('s1', SessionStatus.READY);
  });

  /**
   * The order is the point, and the assertions above cannot see it: both would still pass with the
   * mirror running first, or with the write started but never awaited. A client that reacts to the
   * `session.status` socket event by re-reading GET /sessions would then race the row and read the
   * PREVIOUS status. So this records what actually happened, and requires the write to have
   * SETTLED, not merely to have been called.
   */
  it('finishes the write before the mirror runs, not just starts it', async () => {
    const order: string[] = [];
    const update = jest.fn().mockImplementation(async () => {
      order.push('persist:start');
      await Promise.resolve();
      order.push('persist:settled');
      return { affected: 1 };
    });
    const emitSessionStatus = jest.fn().mockImplementation(() => order.push('ws'));
    const dispatch = jest.fn().mockImplementation(() => {
      order.push('webhook');
      return Promise.resolve();
    });
    const broadcaster = new SessionStatusBroadcaster({
      sessionRepository: { update } as unknown as Repository<Session>,
      eventsGateway: { emitSessionStatus } as never,
      webhookService: { dispatch } as never,
      logger: console as never,
    });

    await broadcaster.updateStatus('s1', SessionStatus.READY);

    expect(order).toEqual(['persist:start', 'persist:settled', 'ws', 'webhook']);
  });

  it('mirrors to WS and dispatches the session.status webhook on a transition', async () => {
    const { broadcaster, emitSessionStatus, dispatch } = make();
    await broadcaster.updateStatus('s1', SessionStatus.QR_READY);
    expect(emitSessionStatus).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('s1', 'session.status', {
      sessionId: 's1',
      status: SessionStatus.QR_READY,
    });
  });

  it('de-dups the SAME status signalled twice (onStateChanged + a dedicated callback)', async () => {
    const { broadcaster, emitSessionStatus, dispatch } = make();
    await broadcaster.updateStatus('s1', SessionStatus.READY);
    await broadcaster.updateStatus('s1', SessionStatus.READY);
    expect(emitSessionStatus).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('re-emits when the status actually CHANGES back and forth', async () => {
    const { broadcaster, emitSessionStatus } = make();
    await broadcaster.updateStatus('s1', SessionStatus.READY);
    await broadcaster.updateStatus('s1', SessionStatus.DISCONNECTED);
    await broadcaster.updateStatus('s1', SessionStatus.READY);
    expect(emitSessionStatus).toHaveBeenCalledTimes(3);
  });

  it('persists EVERY call even when the mirror is de-duped (the row is not the mirror)', async () => {
    const { broadcaster, update } = make();
    await broadcaster.updateStatus('s1', SessionStatus.READY);
    await broadcaster.updateStatus('s1', SessionStatus.READY);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('clear() drops the de-dup entry so the same status re-emits after a delete-cycle', async () => {
    const { broadcaster, emitSessionStatus } = make();
    await broadcaster.updateStatus('s1', SessionStatus.READY);
    broadcaster.clear('s1');
    await broadcaster.updateStatus('s1', SessionStatus.READY);
    expect(emitSessionStatus).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('checks announcement permission after the write settles: %s', async allowed => {
    const { broadcaster, update, emitSessionStatus, dispatch } = make();
    let resolve!: () => void;
    update.mockImplementationOnce(() => new Promise<void>(yes => (resolve = yes)));
    let current = true;
    const canAnnounce = jest.fn(() => current);
    broadcaster.lastDispatchedStatus.set('s1', SessionStatus.DISCONNECTED);

    const pending = broadcaster.updateStatus('s1', SessionStatus.INITIALIZING, canAnnounce);
    expect(canAnnounce).not.toHaveBeenCalled();
    current = allowed;
    resolve();
    await pending;

    expect(update).toHaveBeenCalledWith('s1', { status: SessionStatus.INITIALIZING });
    expect(canAnnounce).toHaveBeenCalledTimes(1);
    expect(emitSessionStatus).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(dispatch).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(broadcaster.lastDispatchedStatus.get('s1')).toBe(
      allowed ? SessionStatus.INITIALIZING : SessionStatus.DISCONNECTED,
    );
  });

  it('propagates a failed write without checking or announcing its status', async () => {
    const { broadcaster, update, emitSessionStatus, dispatch } = make();
    const failure = new Error('write failed');
    update.mockRejectedValueOnce(failure);
    const canAnnounce = jest.fn(() => true);

    await expect(broadcaster.updateStatus('s1', SessionStatus.INITIALIZING, canAnnounce)).rejects.toBe(failure);

    expect(canAnnounce).not.toHaveBeenCalled();
    expect(emitSessionStatus).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
