import { captureSessionWrites, closeSessionWrites } from './session-write-scope';

function pause() {
  let resume!: () => void;
  const promise = new Promise<void>(resolve => {
    resume = resolve;
  });
  return { promise, resume };
}

describe('Session write lifetimes', () => {
  it('notifies retirement synchronously after closing write admission', () => {
    const source = {};
    const lifetime = captureSessionWrites(source, 'session');
    const notified = jest.fn(() => {
      expect(() => lifetime.assertCurrent()).toThrow('no longer available');
    });
    lifetime.onRetire(notified);

    const deletion = closeSessionWrites(source, 'session');

    expect(notified).toHaveBeenCalledTimes(1);
    deletion.release();
    lifetime.close();
  });

  it('immediately notifies a subscription registered after its generation retired', () => {
    const source = {};
    const lifetime = captureSessionWrites(source, 'session');
    const deletion = closeSessionWrites(source, 'session');
    deletion.release();
    const notified = jest.fn();

    lifetime.onRetire(notified);

    expect(notified).toHaveBeenCalledTimes(1);
    lifetime.close();
  });

  it('removes subscriptions when disposed or their scope closes', () => {
    const source = {};
    const disposed = captureSessionWrites(source, 'session');
    const closed = captureSessionWrites(source, 'session');
    const notified = jest.fn();
    const dispose = disposed.onRetire(notified);
    closed.onRetire(notified);
    dispose();
    dispose();
    closed.close();

    const deletion = closeSessionWrites(source, 'session');

    expect(notified).not.toHaveBeenCalled();
    deletion.release();
    disposed.close();
  });

  it('continues retirement after a subscriber throws and never notifies it again', () => {
    const source = {};
    const lifetime = captureSessionWrites(source, 'session');
    const throwing = jest.fn(() => {
      throw new Error('cleanup failed');
    });
    const notified = jest.fn();
    lifetime.onRetire(throwing);
    lifetime.onRetire(notified);

    const deletion = closeSessionWrites(source, 'session');
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(notified).toHaveBeenCalledTimes(1);
    deletion.release();
    const nextDeletion = closeSessionWrites(source, 'session');
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(notified).toHaveBeenCalledTimes(1);
    nextDeletion.release();
    lifetime.close();
  });

  it('keeps pending database work visible to a retried deletion', async () => {
    const source = {};
    const pending = pause();
    const lifetime = captureSessionWrites(source, 'session');
    const write = lifetime.write(() => pending.promise);
    const firstDelete = closeSessionWrites(source, 'session');
    firstDelete.release();
    const retry = closeSessionWrites(source, 'session');
    let drained = false;
    const drainedWrite = retry.drain().then(() => {
      drained = true;
    });
    await new Promise<void>(setImmediate);
    expect(drained).toBe(false);
    pending.resume();
    await Promise.all([write, drainedWrite]);
    retry.release();
    lifetime.close();
  });

  it('opens fresh admission after a failed deletion without reviving an older lifetime', async () => {
    const source = {};
    const old = captureSessionWrites(source, 'session');
    const deletion = closeSessionWrites(source, 'session');
    await deletion.drain();
    deletion.release();
    const current = captureSessionWrites(source, 'session');
    await expect(old.write(() => Promise.resolve('old'))).rejects.toThrow('no longer available');
    await expect(current.write(() => Promise.resolve('current'))).resolves.toBe('current');
    current.close();
    old.close();
  });

  it('does not reopen admission until overlapping deletions both release', async () => {
    const source = {};
    const first = closeSessionWrites(source, 'session');
    const second = closeSessionWrites(source, 'session');
    first.release();
    const blocked = captureSessionWrites(source, 'session');
    await expect(blocked.write(() => Promise.resolve('blocked'))).rejects.toThrow('no longer available');
    second.release();
    const current = captureSessionWrites(source, 'session');
    await expect(current.write(() => Promise.resolve('current'))).resolves.toBe('current');
    // Admission reopens for new scopes only: the one captured while the deletions overlapped stays refused.
    await expect(blocked.write(() => Promise.resolve('blocked'))).rejects.toThrow('no longer available');
    blocked.close();
    current.close();
  });

  it('isolates data sources and session ids', async () => {
    const source = {};
    const deletion = closeSessionWrites(source, 'session');
    const otherSession = captureSessionWrites(source, 'other');
    const otherSource = captureSessionWrites({}, 'session');
    await expect(otherSession.write(() => Promise.resolve(1))).resolves.toBe(1);
    await expect(otherSource.write(() => Promise.resolve(2))).resolves.toBe(2);
    deletion.release();
    otherSession.close();
    otherSource.close();
  });

  it('keeps a scope usable after its writes settle', async () => {
    const source = {};
    const lifetime = captureSessionWrites(source, 'session');
    await expect(lifetime.write(() => Promise.resolve(1))).resolves.toBe(1);
    expect(() => lifetime.assertCurrent()).not.toThrow();
    await expect(lifetime.write(() => Promise.resolve(2))).resolves.toBe(2);
    lifetime.close();
  });

  it('refuses a closed scope while another scope keeps the session alive', async () => {
    const source = {};
    const closed = captureSessionWrites(source, 'session');
    const sibling = captureSessionWrites(source, 'session');
    closed.close();
    expect(() => closed.assertCurrent()).toThrow('no longer available');
    await expect(closed.write(() => Promise.resolve(1))).rejects.toThrow('no longer available');
    const notified = jest.fn();
    closed.onRetire(notified);
    expect(notified).toHaveBeenCalledTimes(1);
    await expect(sibling.write(() => Promise.resolve(2))).resolves.toBe(2);
    sibling.close();
  });

  it('counts a repeated close once, so another open scope keeps its session', async () => {
    const source = {};
    const first = captureSessionWrites(source, 'session');
    const second = captureSessionWrites(source, 'session');
    first.close();
    first.close();
    await expect(second.write(() => Promise.resolve('still open'))).resolves.toBe('still open');
    second.close();
  });

  it('counts a repeated release once, so an overlapping deletion keeps admission closed', async () => {
    const source = {};
    const first = closeSessionWrites(source, 'session');
    const second = closeSessionWrites(source, 'session');
    first.release();
    first.release();
    const blocked = captureSessionWrites(source, 'session');
    await expect(blocked.write(() => Promise.resolve('blocked'))).rejects.toThrow('no longer available');
    second.release();
    const current = captureSessionWrites(source, 'session');
    await expect(current.write(() => Promise.resolve('current'))).resolves.toBe('current');
    blocked.close();
    current.close();
  });

  it('keeps a write that outlives its closed scope visible to a deletion', async () => {
    const source = {};
    const slow = pause();
    const lifetime = captureSessionWrites(source, 'session');
    // The caller leaves as soon as the first write rejects and closes its scope while the second runs on.
    const both = Promise.all([
      lifetime.write(() => Promise.reject(new Error('first failed'))),
      lifetime.write(() => slow.promise),
    ]);
    await expect(both).rejects.toThrow('first failed');
    lifetime.close();
    const deletion = closeSessionWrites(source, 'session');
    let drained = false;
    const drainedWrites = deletion.drain().then(() => {
      drained = true;
    });
    await new Promise<void>(setImmediate);
    expect(drained).toBe(false);
    slow.resume();
    await drainedWrites;
    deletion.release();
  });

  it('drains past a failed write without rejecting', async () => {
    const source = {};
    const lifetime = captureSessionWrites(source, 'session');
    const failed = lifetime.write(() => Promise.reject(new Error('db down'))).catch((error: unknown) => error);
    const deletion = closeSessionWrites(source, 'session');
    await expect(deletion.drain()).resolves.toBeUndefined();
    await expect(failed).resolves.toEqual(new Error('db down'));
    deletion.release();
    lifetime.close();
  });

  // A leftover idle entry holds memory and nothing else a well-behaved caller can see, so the cleanup is observed on
  // the Map the entry is removed from.
  describe('idle entry cleanup', () => {
    let removals: jest.SpyInstance;
    beforeEach(() => {
      removals = jest.spyOn(Map.prototype, 'delete');
    });
    afterEach(() => {
      removals.mockRestore();
    });
    const dropped = (sessionId: string): boolean => removals.mock.calls.some(([key]) => key === sessionId);

    it('drops the entry once its last scope closes', () => {
      const source = {};
      const first = captureSessionWrites(source, 'idle-scopes');
      const second = captureSessionWrites(source, 'idle-scopes');
      first.close();
      expect(dropped('idle-scopes')).toBe(false);
      second.close();
      expect(dropped('idle-scopes')).toBe(true);
    });

    it('drops the entry once its last deletion releases', () => {
      const source = {};
      const first = closeSessionWrites(source, 'idle-deletions');
      const second = closeSessionWrites(source, 'idle-deletions');
      first.release();
      expect(dropped('idle-deletions')).toBe(false);
      second.release();
      expect(dropped('idle-deletions')).toBe(true);
    });

    it.each([
      ['resolves', () => Promise.resolve('done')],
      ['rejects', () => Promise.reject(new Error('db down'))],
    ])('keeps the entry while a write of a closed scope runs and drops it once the write %s', async (_name, settle) => {
      const source = {};
      const gate = pause();
      const lifetime = captureSessionWrites(source, 'idle-writes');
      const write = lifetime.write(() => gate.promise.then(settle)).catch(() => undefined);
      lifetime.close();
      expect(dropped('idle-writes')).toBe(false);
      gate.resume();
      await write;
      expect(dropped('idle-writes')).toBe(true);
    });
  });
});
