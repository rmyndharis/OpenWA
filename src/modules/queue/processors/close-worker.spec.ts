import type { WorkerHost } from '@nestjs/bullmq';
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
});
