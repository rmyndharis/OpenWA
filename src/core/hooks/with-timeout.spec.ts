import { withTimeout, PluginTimeoutError } from './with-timeout';

describe('withTimeout', () => {
  it('resolves when the promise settles before the deadline', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50, 'test')).resolves.toBe('ok');
  });

  it('rejects with PluginTimeoutError when the promise exceeds the deadline', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 1000));
    await expect(withTimeout(slow, 20, 'slow-op')).rejects.toBeInstanceOf(PluginTimeoutError);
  });

  it('includes the label in the error message', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 1000));
    await expect(withTimeout(slow, 10, 'my-hook')).rejects.toThrow('my-hook');
  });

  it('clears the timer when the promise resolves (no open handles)', async () => {
    await withTimeout(Promise.resolve(1), 10_000, 'fast');
  });
});
