import { startGuardedInterval } from './guarded-interval';

describe('startGuardedInterval', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('runs the task at once and then on every interval', async () => {
    const task = jest.fn().mockResolvedValue(undefined);
    const stop = startGuardedInterval(task, 1000, jest.fn());
    expect(task).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(3000);

    expect(task).toHaveBeenCalledTimes(4);
    stop();
  });

  it('skips a tick while the previous run is still going, and resumes once it ends', async () => {
    let finish!: () => void;
    const task = jest
      .fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => (finish = resolve)))
      .mockResolvedValue(undefined);
    const stop = startGuardedInterval(task, 1000, jest.fn());

    await jest.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledTimes(1);

    finish();
    await jest.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });

  it('hands a failed run to onError, keeps the schedule, and frees the next tick', async () => {
    const failure = new Error('bucket gone');
    const task = jest.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const onError = jest.fn();
    const stop = startGuardedInterval(task, 1000, onError);

    await jest.advanceTimersByTimeAsync(1000);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });

  it('treats a task that throws before returning a promise as a failed run', async () => {
    const failure = new Error('sync throw');
    const task = jest.fn(() => {
      throw failure;
    });
    const onError = jest.fn();
    const stop = startGuardedInterval(task, 1000, onError);

    await jest.advanceTimersByTimeAsync(1000);

    expect(onError).toHaveBeenCalledWith(failure);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });

  it('stops scheduling when stopped', async () => {
    const task = jest.fn().mockResolvedValue(undefined);
    const stop = startGuardedInterval(task, 1000, jest.fn());
    stop();

    await jest.advanceTimersByTimeAsync(5000);

    expect(task).toHaveBeenCalledTimes(1);
  });
});
