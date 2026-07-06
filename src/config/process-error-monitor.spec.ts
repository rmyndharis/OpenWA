import { registerUncaughtExceptionMonitor } from './process-error-monitor';

const EVENT = 'uncaughtExceptionMonitor';

describe('registerUncaughtExceptionMonitor', () => {
  const added: Array<(...args: unknown[]) => void> = [];

  const register = (logger: { error: (m: string, d?: string) => void }): ((e: unknown, o: string) => void) => {
    const before = process.listeners(EVENT);
    registerUncaughtExceptionMonitor(logger);
    const fresh = process.listeners(EVENT).filter(l => !before.includes(l)) as Array<(...a: unknown[]) => void>;
    added.push(...fresh);
    return fresh[fresh.length - 1];
  };

  afterEach(() => {
    added.splice(0).forEach(l => process.removeListener(EVENT, l));
  });

  it('registers exactly one uncaughtExceptionMonitor listener', () => {
    const before = process.listenerCount(EVENT);
    register({ error: () => {} });
    expect(process.listenerCount(EVENT)).toBe(before + 1);
  });

  it('routes the fatal error through the structured logger (stack included, origin named)', () => {
    const calls: Array<[string, string | undefined]> = [];
    const handler = register({ error: (m, d) => calls.push([m, d]) });
    handler(new Error('boom'), 'uncaughtException');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatch(/Uncaught exception \(uncaughtException\)/);
    expect(calls[0][1]).toContain('boom'); // err.stack
  });

  it('never throws even if the logger throws — the original fatal must not be masked', () => {
    const handler = register({
      error: () => {
        throw new Error('logger is down');
      },
    });
    expect(() => handler(new Error('original fatal'), 'uncaughtException')).not.toThrow();
  });

  it('stringifies a non-Error thrown value without throwing', () => {
    const calls: Array<[string, string | undefined]> = [];
    const handler = register({ error: (m, d) => calls.push([m, d]) });
    expect(() => handler('a bare string', 'uncaughtException')).not.toThrow();
    expect(calls[0][1]).toContain('a bare string');
  });
});
