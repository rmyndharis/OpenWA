import { withTimeout, PluginTimeoutError } from './with-timeout';

describe('withTimeout', () => {
  it('resolves when the promise settles before the deadline', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50, 'test')).resolves.toBe('ok');
  });

  it('rejects with PluginTimeoutError when the promise exceeds the deadline', async () => {
    const slow = new Promise(resolve => setTimeout(() => resolve('late'), 1000).unref?.());
    await expect(withTimeout(slow, 20, 'slow-op')).rejects.toBeInstanceOf(PluginTimeoutError);
  });

  it('includes the label in the error message', async () => {
    const slow = new Promise(resolve => setTimeout(resolve, 1000).unref?.());
    await expect(withTimeout(slow, 10, 'my-hook')).rejects.toThrow('my-hook');
  });

  it('clears the timer when the promise resolves (no open handles)', async () => {
    await withTimeout(Promise.resolve(1), 10_000, 'fast');
  });

  it('does not raise an unhandled rejection when the orphaned promise rejects after timeout', async () => {
    const slowReject = new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 30));
    await expect(withTimeout(slowReject, 10, 'op')).rejects.toBeInstanceOf(PluginTimeoutError);
    // Let the orphaned rejection fire; the catch above must absorb it.
    await new Promise(r => setTimeout(r, 50));
  });
});
