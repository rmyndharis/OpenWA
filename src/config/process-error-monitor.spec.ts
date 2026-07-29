import { registerUncaughtExceptionMonitor, registerUnhandledRejectionHandler } from './process-error-monitor';

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

describe('registerUnhandledRejectionHandler', () => {
  const EVENT = 'unhandledRejection';
  const added: Array<(...args: unknown[]) => void> = [];

  type ErrorCall = [string, string | undefined];
  type WarnCall = [string, Record<string, unknown> | undefined];
  const register = (): { handler: (r: unknown) => void; errors: ErrorCall[]; warns: WarnCall[] } => {
    const errors: ErrorCall[] = [];
    const warns: WarnCall[] = [];
    const before = process.listeners(EVENT);
    registerUnhandledRejectionHandler({
      error: (m, d) => errors.push([m, d]),
      warn: (m, c) => warns.push([m, c]),
    });
    const fresh = process.listeners(EVENT).filter(l => !before.includes(l)) as Array<(...a: unknown[]) => void>;
    added.push(...fresh);
    return { handler: fresh[fresh.length - 1], errors, warns };
  };

  afterEach(() => {
    added.splice(0).forEach(l => process.removeListener(EVENT, l));
  });

  it('logs an ordinary rejection as an error carrying its stack', () => {
    const { handler, errors, warns } = register();
    handler(new Error('something genuinely broke'));
    expect(warns).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0][1]).toContain('something genuinely broke');
  });

  // #982: whatsapp-web.js re-runs inject() from an async 'framenavigated' listener it never awaits, so
  // when the lifecycle closes that browser the pending page evaluate rejects with nowhere to be caught.
  // It is expected and self-healing, and logging it as an error with a raw Puppeteer stack reads like a
  // crash. The actionable variant of this message (#708, a stale browser profile) is thrown from inside
  // initialize() and caught by the adapter, so it never reaches this handler.
  it('downgrades the Puppeteer page-context rejection to a warning that explains it', () => {
    const { handler, errors, warns } = register();
    handler(new Error('Execution context was destroyed'));
    expect(errors).toHaveLength(0);
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatch(/navigation or engine teardown/i);
    // Nothing is hidden, only the severity drops — and the stack goes in the CONTEXT object. Passed
    // positionally it would type-check and then replace the logger name for the whole line, which is
    // where a reader looks for the scope, not for a Puppeteer stack.
    expect(typeof warns[0][1]).toBe('object');
    expect(String(warns[0][1]?.reason)).toContain('Execution context was destroyed');
  });

  it('stringifies a non-Error rejection without throwing', () => {
    const { handler, errors } = register();
    expect(() => handler('a bare string')).not.toThrow();
    expect(errors[0][1]).toContain('a bare string');
  });
});
