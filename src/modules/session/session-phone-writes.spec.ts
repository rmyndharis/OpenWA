import { PhoneWrites } from './session-phone-writes';

const ID = 'session-1';

/** A write the case answers when it chooses to: `answer()` resolves it, `answer(true)` rejects it. */
function held(): { write: () => Promise<string>; started: () => boolean; answer: (fail?: boolean) => void } {
  let begun = false;
  let answer!: (fail?: boolean) => void;
  const promise = new Promise<string>((resolve, reject) => {
    answer = fail => (fail ? reject(new Error('database down')) : resolve('written'));
  });
  return {
    write: () => {
      begun = true;
      return promise;
    },
    started: () => begun,
    answer,
  };
}

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('PhoneWrites.run', () => {
  afterEach(() => jest.useRealTimers());

  it('issues a write at once when none is pending, and returns its result', async () => {
    const writes = new PhoneWrites();
    const one = held();

    const result = writes.run(ID, one.write);
    expect(one.started()).toBe(true); // before run returned
    expect(writes.hasPending(ID)).toBe(true);
    one.answer();
    await expect(result).resolves.toBe('written');
    await tick();
    expect(writes.hasPending(ID)).toBe(false);
  });

  it('issues a write only once the writes before it have been answered, in the order they were issued', async () => {
    const writes = new PhoneWrites();
    const first = held();
    const second = held();
    const third = held();

    const results = [writes.run(ID, first.write), writes.run(ID, second.write), writes.run(ID, third.write)];
    await tick();
    expect([first.started(), second.started(), third.started()]).toEqual([true, false, false]);

    first.answer();
    await tick();
    expect([second.started(), third.started()]).toEqual([true, false]);
    second.answer();
    await tick();
    expect(third.started()).toBe(true);
    third.answer();
    await expect(Promise.all(results)).resolves.toEqual(['written', 'written', 'written']);
  });

  it('issues the next write after one that failed, and hands the failure to its caller', async () => {
    const writes = new PhoneWrites();
    const first = held();
    const second = held();

    const failed = writes.run(ID, first.write);
    const next = writes.run(ID, second.write);
    first.answer(true);
    await expect(failed).rejects.toThrow('database down');
    await tick();
    expect(second.started()).toBe(true);
    second.answer();
    await expect(next).resolves.toBe('written');
  });

  it('does not let a write that is never answered hold the next one for more than five seconds', async () => {
    jest.useFakeTimers();
    const writes = new PhoneWrites();
    const stuck = held();
    const next = held();

    void writes.run(ID, stuck.write);
    void writes.run(ID, next.write);
    await jest.advanceTimersByTimeAsync(4_999);
    expect(next.started()).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(next.started()).toBe(true);
    // Its own five seconds count from here: a read waits for it, and gives up on it only after that.
    expect(writes.hasPending(ID)).toBe(true);
    await jest.advanceTimersByTimeAsync(4_999);
    expect(writes.hasPending(ID)).toBe(true);
    await jest.advanceTimersByTimeAsync(1);
    expect(writes.hasPending(ID)).toBe(false);
  });

  it('keeps sessions apart', () => {
    const writes = new PhoneWrites();
    const one = held();
    const other = held();

    void writes.run('session-a', one.write);
    void writes.run('session-b', other.write);
    expect(other.started()).toBe(true);
    expect(writes.hasPending('session-c')).toBe(false);
  });

  it('forgets a deleted session', () => {
    const writes = new PhoneWrites();
    void writes.run(ID, held().write);
    writes.forget(ID);
    expect(writes.hasPending(ID)).toBe(false);
    expect(writes.mark(ID)).toBe(0);
  });

  it('lets a synchronous failure to issue reach the caller and leaves nothing pending', () => {
    const writes = new PhoneWrites();
    expect(() =>
      writes.run(ID, () => {
        throw new Error('no connection');
      }),
    ).toThrow('no connection');
    expect(writes.hasPending(ID)).toBe(false);
    expect(writes.mark(ID)).toBe(0);
  });
});

describe('PhoneWrites.readSettled', () => {
  afterEach(() => jest.useRealTimers());

  it('reads at once, once, when no write is pending or issued meanwhile', async () => {
    const writes = new PhoneWrites();
    const read = jest.fn(() => Promise.resolve('row'));

    const result = writes.readSettled(ID, read);
    expect(read).toHaveBeenCalledTimes(1); // started before readSettled returned
    await expect(result).resolves.toBe('row');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('starts a read only once the pending writes have been answered', async () => {
    const writes = new PhoneWrites();
    const pending = held();
    void writes.run(ID, pending.write);
    const read = jest.fn(() => Promise.resolve('row'));

    const result = writes.readSettled(ID, read);
    await tick();
    expect(read).not.toHaveBeenCalled();
    pending.answer();
    await expect(result).resolves.toBe('row');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('repeats a read when a write was issued while it ran, and returns the later one', async () => {
    const writes = new PhoneWrites();
    const read = jest
      .fn<Promise<string>, []>()
      .mockImplementationOnce(() => {
        void writes.run(ID, () => Promise.resolve()); // a READY row written during the read
        return Promise.resolve('before the write');
      })
      .mockImplementation(() => Promise.resolve('after the write'));

    await expect(writes.readSettled(ID, read)).resolves.toBe('after the write');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('rejects when writes keep being issued while the reads run', async () => {
    const writes = new PhoneWrites();
    const read = jest.fn(() => {
      void writes.run(ID, () => Promise.resolve());
      return Promise.resolve('row');
    });

    await expect(writes.readSettled(ID, read)).rejects.toThrow('written again while its row was read');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('counts its five seconds over the whole wait, however many writes follow one another', async () => {
    jest.useFakeTimers();
    const writes = new PhoneWrites();
    let current = held();
    void writes.run(ID, current.write);
    const read = jest.fn(() => Promise.resolve('row'));

    const result = writes.readSettled(ID, read);
    const rejected = expect(result).rejects.toThrow('were not answered in 5000 ms');
    // A replacement that reports READY again before each earlier answer has been used: the tail never drains.
    for (let elapsed = 0; elapsed < 4_000; elapsed += 2_000) {
      await jest.advanceTimersByTimeAsync(2_000);
      const next = held();
      void writes.run(ID, next.write);
      current.answer();
      current = next;
    }
    await jest.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(read).not.toHaveBeenCalled();
  });

  it('is not undone by its deadline passing while a read runs', async () => {
    jest.useFakeTimers();
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const writes = new PhoneWrites();
      let finish!: (value: string) => void;
      const result = writes.readSettled(ID, () => new Promise<string>(resolve => (finish = resolve)));

      await jest.advanceTimersByTimeAsync(6_000);
      finish('row');
      await expect(result).resolves.toBe('row');
      await jest.advanceTimersByTimeAsync(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  // However a write is issued relative to the end of a wait, a read that is returned began with no write pending, and no write
  // was issued while it ran. The offsets move the write one microtask at a time across the moment the wait ends.
  it.each(Array.from({ length: 13 }, (_, offset) => offset))(
    'never returns a read that overlapped a write (write issued %s microtasks after the earlier one was answered)',
    async offset => {
      const writes = new PhoneWrites();
      const first = held();
      const second = held();
      void writes.run(ID, first.write);

      const starts: Array<{ pending: boolean; mark: number }> = [];
      let releaseFirstRead: (() => void) | undefined;
      let calls = 0;
      const result = writes.readSettled(ID, () => {
        calls++;
        starts.push({ pending: writes.hasPending(ID), mark: writes.mark(ID) });
        if (calls > 1) return Promise.resolve('later');
        return new Promise<string>(resolve => (releaseFirstRead = () => resolve('first')));
      });

      const issueSecond = (left: number): void => {
        if (left === 0) void writes.run(ID, second.write);
        else queueMicrotask(() => issueSecond(left - 1));
      };
      void first
        .write()
        .catch(() => undefined)
        .then(() => issueSecond(offset));
      first.answer();
      await tick();
      second.answer();
      await tick();
      releaseFirstRead?.();
      await result;

      const last = starts[starts.length - 1];
      expect(last.pending).toBe(false);
      expect(last.mark).toBe(writes.mark(ID));
    },
  );
});
