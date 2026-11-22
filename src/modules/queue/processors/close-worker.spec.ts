import type { WorkerHost } from '@nestjs/bullmq';
import { LoggerService } from '../../../common/services/logger.service';
import { closeWorkerIfStarted, MAX_WORKER_CLOSE_WAIT_MS } from './close-worker';

describe('closeWorkerIfStarted', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const hungHost = (): WorkerHost =>
    ({ worker: { name: 'q', close: () => new Promise<void>(() => undefined) } }) as unknown as WorkerHost;

  const settledAt = async (waitMs: number): Promise<number> => {
    let doneAt = -1;
    const started = Date.now();
    void closeWorkerIfStarted(hungHost(), waitMs).then(() => (doneAt = Date.now() - started));
    await jest.advanceTimersByTimeAsync(MAX_WORKER_CLOSE_WAIT_MS + 1);
    return doneAt;
  };

  it('releases the hook at the requested wait when it is shorter than the cap', async () => {
    expect(await settledAt(2_000)).toBe(2_000);
  });

  it('clamps a longer wait to MAX_WORKER_CLOSE_WAIT_MS', async () => {
    expect(await settledAt(MAX_WORKER_CLOSE_WAIT_MS * 3)).toBe(MAX_WORKER_CLOSE_WAIT_MS);
  });

  it('settles a later worker.close() once the wait is over, as BullModule awaits it again', async () => {
    const host = hungHost();
    const pending = closeWorkerIfStarted(host, 1_000);
    await jest.advanceTimersByTimeAsync(1_000);
    await pending;
    await expect(host.worker.close()).resolves.toBeUndefined();
  });

  // A destroy hook or later BullModule close that rejects makes Nest skip every hook after it,
  // including DataSource.destroy(). Patching worker.close after a rejection settles that later await too.
  it('lets the teardown go on when the close rejects, and settles the later BullModule close', async () => {
    const failure = new Error('connection lost');
    const close = jest.fn().mockRejectedValue(failure);
    const worker = { name: 'q', close };

    await expect(closeWorkerIfStarted({ worker } as unknown as WorkerHost, 1_000)).resolves.toBeUndefined();

    expect(worker.close).not.toBe(close);
    await expect(worker.close()).resolves.toBeUndefined();
  });

  it('catches synchronous throws from worker.close(), logs a warning, and patches worker.close to resolve', async () => {
    const failure = new Error('sync close failure');
    const close = jest.fn(() => {
      throw failure;
    });
    const worker = { name: 'q', close };
    const warn = jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(closeWorkerIfStarted({ worker } as unknown as WorkerHost, 1_000)).resolves.toBeUndefined();

      expect(worker.close).not.toBe(close);
      await expect(worker.close()).resolves.toBeUndefined();
      expect(jest.getTimerCount()).toBe(0);
      expect(warn).toHaveBeenCalledWith('Queue worker close failed; continuing shutdown', {
        queue: 'q',
        error: 'sync close failure',
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves no timer running once the worker has closed', async () => {
    const host = { worker: { name: 'q', close: () => Promise.resolve() } } as unknown as WorkerHost;

    await closeWorkerIfStarted(host, MAX_WORKER_CLOSE_WAIT_MS);

    expect(jest.getTimerCount()).toBe(0);
  });
});
