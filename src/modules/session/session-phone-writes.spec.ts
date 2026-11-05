import { PhoneWrites } from './session-phone-writes';

const ID = 'session-1';

/** A write the case answers when it chooses to: `settle()` resolves it, `settle(true)` rejects it. */
const write = (): { promise: Promise<unknown>; settle: (fail?: boolean) => void } => {
  let settle!: (fail?: boolean) => void;
  const promise = new Promise<unknown>((resolve, reject) => {
    settle = fail => (fail ? reject(new Error('database down')) : resolve(undefined));
  });
  return { promise, settle };
};

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('PhoneWrites', () => {
  afterEach(() => jest.useRealTimers());

  it('holds a session pending until every write tracked for it has been answered, one failing included', async () => {
    const writes = new PhoneWrites();
    const first = write();
    const second = write();
    writes.track(ID, first.promise);
    writes.track(ID, second.promise);
    expect(writes.hasPending(ID)).toBe(true);

    second.settle(true);
    await tick();
    expect(writes.hasPending(ID)).toBe(true); // the first is still waiting
    first.settle();
    await tick();
    expect(writes.hasPending(ID)).toBe(false);
    expect(writes.hasPending('another-session')).toBe(false);
  });

  it('forgets a deleted session', () => {
    const writes = new PhoneWrites();
    writes.track(ID, write().promise);
    writes.forget(ID);
    expect(writes.hasPending(ID)).toBe(false);
    expect(writes.mark(ID)).toBe(0);
  });

  it('reads at once, once, when no write is pending or issued meanwhile', async () => {
    const writes = new PhoneWrites();
    const read = jest.fn(() => Promise.resolve('row'));
    await expect(writes.readSettled(ID, read)).resolves.toBe('row');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('starts a read only once the pending writes have been answered', async () => {
    const writes = new PhoneWrites();
    const pending = write();
    writes.track(ID, pending.promise);
    const read = jest.fn(() => Promise.resolve('row'));

    const result = writes.readSettled(ID, read);
    await tick();
    expect(read).not.toHaveBeenCalled();
    pending.settle();
    await expect(result).resolves.toBe('row');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('repeats a read when a write was issued while it ran, and returns the later one', async () => {
    const writes = new PhoneWrites();
    const read = jest
      .fn<Promise<string>, []>()
      .mockImplementationOnce(() => {
        writes.track(ID, Promise.resolve()); // a READY row written during the read
        return Promise.resolve('before the write');
      })
      .mockImplementation(() => Promise.resolve('after the write'));

    await expect(writes.readSettled(ID, read)).resolves.toBe('after the write');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('rejects when writes keep being issued while the reads run', async () => {
    const writes = new PhoneWrites();
    const read = jest.fn(() => {
      writes.track(ID, Promise.resolve());
      return Promise.resolve('row');
    });

    await expect(writes.readSettled(ID, read)).rejects.toThrow('written again while its row was read');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('rejects when a write is not answered in time, and starts no read', async () => {
    jest.useFakeTimers();
    const writes = new PhoneWrites();
    writes.track(ID, write().promise);
    const read = jest.fn(() => Promise.resolve('row'));

    const result = writes.readSettled(ID, read);
    const rejected = expect(result).rejects.toThrow('were not answered in 5000 ms');
    await jest.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(read).not.toHaveBeenCalled();
  });
});
