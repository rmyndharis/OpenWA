import { KeyedMutationQueue } from './keyed-mutation-queue';

/**
 * Lets queued chains drain. Cycles through the macrotask queue as well as microtasks, so work
 * deferred with setImmediate settles too.
 */
const drain = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
};

describe('KeyedMutationQueue', () => {
  it('runs queued work', async () => {
    const queue = new KeyedMutationQueue();
    const work = jest.fn().mockResolvedValue(undefined);

    queue.enqueue('k', work);
    await drain();

    expect(work).toHaveBeenCalledTimes(1);
  });

  it('serializes work for the same key in arrival order', async () => {
    const queue = new KeyedMutationQueue();
    const order: string[] = [];
    const slow = () =>
      new Promise<void>(resolve => {
        setImmediate(() => {
          order.push('first');
          resolve();
        });
      });

    queue.enqueue('k', slow);
    queue.enqueue('k', () => {
      order.push('second');
      return Promise.resolve();
    });
    await drain();

    // Without chaining, the synchronous second would land before the deferred first.
    expect(order).toEqual(['first', 'second']);
  });

  it('does not serialize across different keys', async () => {
    const queue = new KeyedMutationQueue();
    let releaseA: () => void = () => {};
    const blocked = new Promise<void>(resolve => {
      releaseA = resolve;
    });
    const bDone = jest.fn().mockResolvedValue(undefined);

    queue.enqueue('a', () => blocked);
    queue.enqueue('b', bDone);
    await drain();

    // 'b' must not wait on the still-pending 'a'.
    expect(bDone).toHaveBeenCalledTimes(1);
    releaseA();
    await drain();
  });

  it('isolates a failure so later work on the same key still runs', async () => {
    const queue = new KeyedMutationQueue();
    const after = jest.fn().mockResolvedValue(undefined);

    queue.enqueue('k', () => Promise.reject(new Error('boom')));
    queue.enqueue('k', after);
    await drain();

    expect(after).toHaveBeenCalledTimes(1);
  });

  it('reports an unexpected failure to the handler with its key', async () => {
    const onUnexpectedError = jest.fn();
    const queue = new KeyedMutationQueue(onUnexpectedError);
    const err = new Error('boom');

    queue.enqueue('k', () => Promise.reject(err));
    await drain();

    expect(onUnexpectedError).toHaveBeenCalledWith('k', err);
  });

  it('never leaks a rejected fire-and-forget promise', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    const queue = new KeyedMutationQueue();

    queue.enqueue('k', () => Promise.reject(new Error('boom')));
    await drain();

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('reclaims the chain once it drains, so memory does not grow per entity touched', async () => {
    const queue = new KeyedMutationQueue();

    queue.enqueue('k', () => Promise.resolve());
    expect(queue.size).toBe(1);
    await drain();

    expect(queue.size).toBe(0);
  });

  it('reclaims a chain that ended in failure', async () => {
    const queue = new KeyedMutationQueue();

    queue.enqueue('k', () => Promise.reject(new Error('boom')));
    await drain();

    expect(queue.size).toBe(0);
  });

  it('keeps the chain while later work is still pending', async () => {
    const queue = new KeyedMutationQueue();
    let release: () => void = () => {};
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });

    queue.enqueue('k', () => Promise.resolve());
    queue.enqueue('k', () => blocked);
    await drain();

    // The first chain settled but must not evict the entry the second one replaced it with.
    expect(queue.size).toBe(1);
    release();
    await drain();
    expect(queue.size).toBe(0);
  });
});
