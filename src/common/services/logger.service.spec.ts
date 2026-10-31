import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { LoggerService, LogLevel, LogFormat, createLogger, redactSecrets } from './logger.service';
import { runWithRequestId } from './request-context';

interface LogEntry {
  timestamp: string;
  level: string;
  context: string;
  message: string;
  sessionId?: string;
  action?: string;
  trace?: string;
}

// Helper to safely extract log output from mock calls
function getLogOutput(spy: jest.SpyInstance): LogEntry {
  const calls = spy.mock.calls as string[][];
  return JSON.parse(calls[0][0]) as LogEntry;
}

// Helper to read the raw (unparsed) string a spy was called with.
function getRawOutput(spy: jest.SpyInstance): string {
  const calls = spy.mock.calls as string[][];
  return calls[0][0];
}

describe('LoggerService', () => {
  let logger: LoggerService;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    logger = new LoggerService();
    logger.setContext('TestContext');
    // Pin JSON so structured-output assertions are deterministic regardless of TTY/LOG_FORMAT.
    LoggerService.setLogFormat(LogFormat.JSON);
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    LoggerService.setLogFormat(null);
    LoggerService.setLogLevel(LogLevel.INFO);
  });

  describe('log', () => {
    it('should log info messages with context', () => {
      logger.log('Test message');

      expect(consoleSpy).toHaveBeenCalled();
      const output = getLogOutput(consoleSpy);
      expect(output.level).toBe('info');
      expect(output.message).toBe('Test message');
      expect(output.context).toBe('TestContext');
      expect(output.timestamp).toBeDefined();
    });

    it('should log with additional metadata', () => {
      logger.log('Test message', { sessionId: '123', action: 'test' });

      const output = getLogOutput(consoleSpy);
      expect(output.sessionId).toBe('123');
      expect(output.action).toBe('test');
    });
  });

  describe('secret redaction', () => {
    it('redacts the values of secret-named keys in the metadata', () => {
      logger.log('auth', { password: 'hunter2', apiKey: 'abc123', userId: 'u1' });

      const output = getLogOutput(consoleSpy) as unknown as Record<string, unknown>;
      expect(output.password).toBe('[REDACTED]');
      expect(output.apiKey).toBe('[REDACTED]');
      expect(output.userId).toBe('u1');
    });

    it.each([
      'passwd',
      'secret',
      'token',
      'accessToken',
      'authorization',
      'credentials',
      'apiPepper',
      'privateKey',
      'private-key',
      'api-key',
      'api_key',
    ])('redacts the value under the key %s', key => {
      logger.log('auth', { [key]: 'value-1', visible: 'v' });

      const output = getLogOutput(consoleSpy) as unknown as Record<string, unknown>;
      expect(output[key]).toBe('[REDACTED]');
      expect(output.visible).toBe('v');
    });

    it('redacts secret-named keys inside arrays of objects', () => {
      logger.log('cfg', {
        instances: [
          { name: 'a', secret: 's1' },
          { name: 'b', token: 't1' },
        ],
      });

      const output = getLogOutput(consoleSpy) as unknown as { instances: Array<Record<string, string>> };
      expect(output.instances).toEqual([
        { name: 'a', secret: '[REDACTED]' },
        { name: 'b', token: '[REDACTED]' },
      ]);
    });

    it('redacts secret-named keys nested inside the metadata', () => {
      logger.log('cfg', { config: { redisPassword: 'p', host: 'h' } });

      const output = getLogOutput(consoleSpy) as unknown as { config: { redisPassword: string; host: string } };
      expect(output.config.redisPassword).toBe('[REDACTED]');
      expect(output.config.host).toBe('h');
    });

    it('redacts a secret-named key however deep it sits', () => {
      let deep: Record<string, unknown> = { password: 'value-deep', visible: 'v' };
      for (let i = 0; i < 12; i++) deep = { level: deep };
      logger.log('cfg', { config: deep });

      const line = getRawOutput(consoleSpy);
      expect(line).not.toContain('value-deep');
      expect(line).toContain('"password":"[REDACTED]","visible":"v"');
    });

    it('never writes what lies beyond the bounded amount of deep metadata it copies', () => {
      let chain: Record<string, unknown> = { password: 'value-far' };
      for (let i = 0; i < 1500; i++) chain = { next: chain };
      logger.log('cfg', { chain, sessionId: 's1' });

      const output = getLogOutput(consoleSpy) as unknown as Record<string, unknown>;
      expect(getRawOutput(consoleSpy)).not.toContain('value-far');
      expect(getRawOutput(consoleSpy)).toContain('"[Truncated]"');
      expect(output.sessionId).toBe('s1');
    });

    // The first five levels were always copied whole, however wide, and still are, up to what one copy may take.
    it('writes a wide structure in full at the levels metadata normally has', () => {
      logger.log('cfg', { items: Array.from({ length: 1500 }, (_, id) => ({ id, tags: [id] })) });

      const { items } = getLogOutput(consoleSpy) as unknown as { items: unknown[] };
      expect(items).toHaveLength(1500);
      expect(items[0]).toEqual({ id: 0, tags: [0] });
      expect(items[1499]).toEqual({ id: 1499, tags: [1499] });
    });

    it('writes the second of two arrays of a million entries as [Truncated] and keeps the rest of the line', () => {
      const zeros = (): number[] => new Array<number>(1_000_000).fill(0);
      logger.log('cfg', { sessionId: 's1', first: zeros(), second: zeros(), after: { id: 1 }, last: 'l' });

      const output = getLogOutput(consoleSpy) as unknown as Record<string, unknown>;
      expect(output.first).toHaveLength(1_000_000);
      expect(String(output.second).slice(0, 11)).toBe('[Truncated]');
      expect({ ...output, first: 0 }).toMatchObject({ message: 'cfg', sessionId: 's1', after: { id: 1 }, last: 'l' });
    });

    it('truncates the rows of a wide array below the last whole level once the budget is spent', () => {
      logger.log('cfg', { a: { b: { c: { items: Array.from({ length: 1500 }, (_, id) => ({ id })) } } } });

      const { items } = (getLogOutput(consoleSpy) as unknown as { a: { b: { c: { items: unknown[] } } } }).a.b.c;
      expect(items).toHaveLength(1500);
      expect(items[0]).toEqual({ id: 0 });
      expect(items[1499]).toBe('[Truncated]');
    });

    // Where the first five levels end and the node budget runs out, as they reach the line.
    describe('the boundaries of the whole levels and of the node budget', () => {
      const bare = (length: number): object[] => Array.from({ length }, () => ({}));
      const wide = (keys: number): Record<string, number> =>
        Object.fromEntries(Array.from({ length: keys }, (_, key) => [`k${key}`, key]));
      const at = (line: unknown, ...path: string[]): unknown =>
        path.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], line);
      const line = (metadata: unknown): unknown => {
        consoleSpy.mockClear();
        logger.log('cfg', metadata as never);
        return getLogOutput(consoleSpy);
      };

      it('copies exactly 1000 objects below the fifth level and writes the next as [Truncated]', () => {
        const rows = at(line({ a: { b: { c: { rows: bare(1001) } } } }), 'a', 'b', 'c', 'rows') as unknown[];

        expect(rows.slice(0, 1000)).toEqual(bare(1000));
        expect(rows[1000]).toBe('[Truncated]');
      });

      it('copies an object of the fifth level whole, whatever its number of keys', () => {
        const copy = at(line({ a: { b: { c: { wide: wide(1500) } } } }), 'a', 'b', 'c', 'wide') as object;

        expect(Object.keys(copy)).toHaveLength(1500);
      });

      it('copies an object of the sixth level that fits in what is left of the budget, and not a wider one', () => {
        const fits = at(line({ a: { b: { c: { d: { wide: wide(999) } } } } }), 'a', 'b', 'c', 'd', 'wide') as object;
        const wider = at(line({ a: { b: { c: { d: { wide: wide(1000) } } } } }), 'a', 'b', 'c', 'd', 'wide');

        expect(Object.keys(fits)).toHaveLength(999);
        expect(wider).toBe('[Truncated]');
      });
    });
  });

  // Plugin ctx.logger spreads its caller's metadata in verbatim, so the metadata is whatever the plugin holds.
  describe('metadata the logger cannot take as is', () => {
    const entityWithCycle = (): Record<string, unknown> => {
      const entity: Record<string, unknown> = { id: 1 };
      entity.self = entity;
      return entity;
    };
    const parsed = (): Record<string, unknown> => getLogOutput(consoleSpy) as unknown as Record<string, unknown>;

    it('writes a circular reference as [Circular] and keeps the rest of the line', () => {
      logger.log('saved', { sessionId: 's1', entity: entityWithCycle() });

      expect(parsed()).toMatchObject({ message: 'saved', sessionId: 's1', entity: { id: 1, self: '[Circular]' } });
    });

    it('does not mistake a repeated, non-circular reference for a cycle', () => {
      const shared = { id: 1 };
      logger.log('saved', { a: shared, list: [shared, shared] });

      expect(parsed()).toMatchObject({ a: { id: 1 }, list: [{ id: 1 }, { id: 1 }] });
    });

    it('writes a BigInt as its decimal text', () => {
      logger.log('saved', { total: 10n, nested: { ids: [1n, 2n] } });

      expect(parsed()).toMatchObject({ total: '10', nested: { ids: ['1', '2'] } });
    });

    it('writes ordinary nested metadata exactly as given, apart from its secrets', () => {
      const metadata = {
        sessionId: 's1',
        counts: [1, 2, 3],
        none: null,
        flag: false,
        nested: { a: { b: { c: 'x' } } },
      };
      logger.log('saved', { ...metadata, nested: { ...metadata.nested, token: 't' } });

      const { timestamp, ...line } = parsed();
      expect(timestamp).toEqual(expect.any(String));
      expect(JSON.stringify(line)).toBe(
        JSON.stringify({
          level: 'info',
          context: 'TestContext',
          message: 'saved',
          ...metadata,
          nested: { ...metadata.nested, token: '[REDACTED]' },
        }),
      );
    });

    const throwingGetter = () => ({
      get boom(): string {
        throw new Error('getter');
      },
    });
    const throwingProxy = () => ({
      unreadable: new Proxy(
        {},
        {
          ownKeys: (): never => {
            throw new Error('ownKeys');
          },
        },
      ),
    });
    const throwingToJson = () => ({
      entity: {
        id: 1,
        toJSON: (): never => {
          throw new Error('toJSON');
        },
      },
    });

    it.each([
      ['a getter that throws', throwingGetter],
      ['a proxy whose traps throw', throwingProxy],
    ])('keeps the line, without its metadata, for %s', (_name, metadata) => {
      expect(() => logger.log('saved', metadata())).not.toThrow();

      expect(parsed()).toMatchObject({ message: 'saved', metadata: '[Unreadable]' });
    });

    it('writes a property named __proto__ as a field, redacted, without touching any prototype', () => {
      logger.log(
        'saved',
        JSON.parse('{"__proto__":{"a":1,"password":"value-proto"},"b":2}') as Record<string, unknown>,
      );

      const line = getRawOutput(consoleSpy);
      expect(line).toContain('"__proto__":{"a":1,"password":"[REDACTED]"}');
      expect(line).not.toContain('value-proto');
      expect(({} as Record<string, unknown>).a).toBeUndefined();
    });

    it('never calls a toJSON on the metadata, so it cannot write what the redaction removed', () => {
      logger.log('saved', { entity: { id: 1, toJSON: () => ({ password: 'value-json' }) } });

      expect(getRawOutput(consoleSpy)).not.toContain('value-json');
      expect(parsed().entity).toEqual({ id: 1 });
    });

    // A function is not data: the copy leaves it out, as JSON.stringify leaves it out of an object and writes null
    // for it in an array, so nothing a function has or returns reaches the line.
    describe('a function in the metadata, the message or the trace', () => {
      const credentials = (): Record<string, string> => ({ password: 'value-fn', other: 'value-fn-other' });
      class WithStaticToJson {
        static toJSON(): Record<string, string> {
          return credentials();
        }
      }
      const functions: Array<[string, () => unknown]> = [
        ['a function with a toJSON of its own', () => Object.assign(() => 1, { toJSON: credentials })],
        ['a class with a static toJSON', () => WithStaticToJson],
        ['a function with properties of its own', () => Object.assign(() => 1, { password: 'value-fn', id: 7 })],
      ];
      const nested = (leaf: unknown, levels: number): unknown => {
        let value = leaf;
        for (let i = 0; i < levels; i++) value = { level: value };
        return value;
      };

      it.each(functions)('is left out of the copy at every depth: %s', (_name, make) => {
        const fn = make();

        expect(JSON.stringify(redactSecrets({ handler: fn, id: 1 }))).toBe('{"id":1}');
        expect(JSON.stringify(redactSecrets([fn, 1]))).toBe('[null,1]');
        for (const depth of [0, 1, 4, 5, 6, 8]) {
          expect(JSON.stringify(redactSecrets(nested(fn, depth))) ?? '').not.toContain('value-fn');
        }
        expect(redactSecrets(fn)).toBeUndefined();
      });

      describe.each([LogFormat.JSON, LogFormat.PRETTY])('in %s output', format => {
        beforeEach(() => {
          LoggerService.setLogFormat(format);
        });

        it.each(functions)('writes nothing of %s given as metadata', (_name, make) => {
          logger.log('saved', { handler: make(), list: [make()], deep: nested(make(), 6) });

          expect(getRawOutput(consoleSpy)).toContain('saved');
          expect(getRawOutput(consoleSpy)).not.toContain('value-fn');
        });

        it.each(functions)('writes %s given as the message or as the trace as [Unprintable]', (_name, make) => {
          const errorSpy = jest.spyOn(console, 'error');

          logger.log(make());
          logger.error('failed', make());

          for (const line of [getRawOutput(consoleSpy), getRawOutput(errorSpy)]) {
            expect(line).toContain('[Unprintable]');
            expect(line).not.toContain('value-fn');
          }
        });
      });
    });

    describe.each([LogFormat.JSON, LogFormat.PRETTY])('in %s output', format => {
      beforeEach(() => {
        LoggerService.setLogFormat(format);
      });

      it.each([
        ['a circular reference', () => ({ entity: entityWithCycle() })],
        ['a BigInt', () => ({ total: 10n })],
        ['a getter that throws', throwingGetter],
        ['a proxy whose traps throw', throwingProxy],
        ['a toJSON that throws', throwingToJson],
      ])('does not throw on %s in the metadata', (_name, metadata) => {
        expect(() => logger.log('saved', metadata())).not.toThrow();

        expect(getRawOutput(consoleSpy)).toContain('saved');
      });
    });
  });

  // Array.prototype.map visits every index of an array, holes included, so a sparse array costs its length
  // however little it holds: the largest one takes tens of seconds to walk.
  describe('a sparse array of the largest length', () => {
    const sparse = (): unknown[] => {
      const list: unknown[] = [];
      list.length = 2 ** 32 - 1;
      return list;
    };
    const parsed = (): Record<string, unknown> => getLogOutput(consoleSpy) as unknown as Record<string, unknown>;

    it('is written as [Truncated] at once in the first levels, with the rest of the line kept', () => {
      const started = Date.now();
      logger.log('saved', { sessionId: 's1', list: sparse() });

      expect(Date.now() - started).toBeLessThan(1000);
      expect(parsed()).toMatchObject({ message: 'saved', sessionId: 's1', list: '[Truncated]' });
    });

    it('is written as [Truncated] at once below the fifth level, with the rest of the line kept', () => {
      const started = Date.now();
      logger.log('saved', { sessionId: 's1', a: { b: { c: { d: { e: { list: sparse() } } } } } });

      expect(Date.now() - started).toBeLessThan(1000);
      expect(parsed()).toMatchObject({
        message: 'saved',
        sessionId: 's1',
        a: { b: { c: { d: { e: { list: '[Truncated]' } } } } },
      });
    });
  });

  // Object.entries lists one entry per byte of a Buffer, so copying one that way costs seconds per few megabytes.
  describe('a Buffer of 5 million bytes', () => {
    const parsed = (): Record<string, unknown> => getLogOutput(consoleSpy) as unknown as Record<string, unknown>;
    const written = { type: 'Buffer', length: 5_000_000 };

    it('is written as its type and length at once in the first levels, with the rest of the line kept', () => {
      const file = Buffer.alloc(5_000_000);

      const started = Date.now();
      logger.log('saved', { sessionId: 's1', file });

      expect(Date.now() - started).toBeLessThan(1000);
      expect(parsed()).toMatchObject({ message: 'saved', sessionId: 's1', file: written });
    });

    it('is written as its type and length at once below the fifth level, with the rest of the line kept', () => {
      const file = Buffer.alloc(5_000_000);

      const started = Date.now();
      logger.log('saved', { sessionId: 's1', a: { b: { c: { d: { e: { file } } } } } });

      expect(Date.now() - started).toBeLessThan(1000);
      expect(parsed()).toMatchObject({ sessionId: 's1', a: { b: { c: { d: { e: { file: written } } } } } });
    });
  });

  describe('an array given as the metadata itself', () => {
    const parsed = (): Record<string, unknown> => getLogOutput(consoleSpy) as unknown as Record<string, unknown>;

    it('is written as one [Truncated] field when it is longer than the limit', () => {
      logger.log('saved', new Array<number>(1_000_001).fill(0) as never);

      expect(parsed()).toMatchObject({ message: 'saved', metadata: '[Truncated]' });
      expect(parsed()).not.toHaveProperty('0');
    });

    it('keeps one field per entry when it is within the limit, as before', () => {
      logger.log('saved', [10, 20] as never);

      expect(parsed()).toMatchObject({ message: 'saved', 0: 10, 1: 20 });
      expect(parsed()).not.toHaveProperty('metadata');
    });
  });

  describe('an array subclass', () => {
    class Rows extends Array<unknown> {
      toJSON(): string[] {
        return ['replaced'];
      }
    }

    it('is written as the plain array it holds, in the metadata and as the message', () => {
      logger.log('saved', { rows: Rows.from([1, { token: 't' }]) });
      logger.log(Rows.from([1, 2]));

      const calls = consoleSpy.mock.calls as string[][];
      expect(JSON.parse(calls[0][0])).toMatchObject({ rows: [1, { token: '[REDACTED]' }] });
      expect(JSON.parse(calls[1][0])).toMatchObject({ message: '[1,2]' });
    });
  });

  // Nest passes the framework's own message and trace through, so the two slots hold whatever it was handed.
  describe('a message or trace that cannot be read', () => {
    const revokedProxy = (): object => {
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      return proxy;
    };
    const throwingPrototype = (): object =>
      new Proxy(
        {},
        {
          getPrototypeOf: (): never => {
            throw new Error('getPrototypeOf');
          },
        },
      );
    const throwingMessage = (): Error =>
      Object.defineProperty(new Error('boom'), 'message', {
        get: (): never => {
          throw new Error('message getter');
        },
      });

    describe.each([LogFormat.JSON, LogFormat.PRETTY])('in %s output', format => {
      beforeEach(() => {
        LoggerService.setLogFormat(format);
      });

      it.each([
        ['a revoked proxy', revokedProxy],
        ['a proxy whose prototype read throws', throwingPrototype],
        ['an Error whose message getter throws', throwingMessage],
      ])('writes %s passed as the message as [Unprintable]', (_name, unreadable) => {
        const errorSpy = jest.spyOn(console, 'error');

        expect(() => logger.log(unreadable())).not.toThrow();
        expect(() => logger.error(unreadable())).not.toThrow();

        expect(getRawOutput(consoleSpy)).toContain('[Unprintable]');
        expect(getRawOutput(errorSpy)).toContain('[Unprintable]');
      });

      it.each([
        ['a revoked proxy', revokedProxy],
        ['a proxy whose prototype read throws', throwingPrototype],
      ])('writes %s passed as the trace as [Unprintable] and keeps the message', (_name, unreadable) => {
        const errorSpy = jest.spyOn(console, 'error');

        expect(() => logger.error('saved-message', unreadable())).not.toThrow();

        expect(getRawOutput(errorSpy)).toContain('saved-message');
        expect(getRawOutput(errorSpy)).toContain('[Unprintable]');
      });

      it('keeps the message when an Error whose message getter throws is passed as the trace', () => {
        const errorSpy = jest.spyOn(console, 'error');

        expect(() => logger.error('saved-message', throwingMessage())).not.toThrow();

        expect(getRawOutput(errorSpy)).toContain('saved-message');
      });

      it('keeps a readable trace when the message cannot be read', () => {
        const errorSpy = jest.spyOn(console, 'error');

        logger.error(revokedProxy(), 'saved-trace');

        expect(getRawOutput(errorSpy)).toContain('[Unprintable]');
        expect(getRawOutput(errorSpy)).toContain('saved-trace');
      });

      // The redaction never saw what such a value prints for itself, so it is not printed.
      describe('an object or function that has a text of its own but cannot be copied', () => {
        const ownText = (): object => ({
          get boom(): string {
            throw new Error('getter');
          },
          toString: () => 'password=value-text',
        });
        const functionWithText = (): (() => string) =>
          function leaky() {
            return 'password=value-text';
          };

        it.each([
          ['an object', ownText],
          ['a function', functionWithText],
        ])('writes %s passed as the message or as the trace as [Unprintable]', (_name, make) => {
          const errorSpy = jest.spyOn(console, 'error');

          logger.error(make());
          logger.error('saved-message', make());

          const lines = (errorSpy.mock.calls as string[][]).map(call => call[0]);
          expect(lines).toHaveLength(2);
          for (const line of lines) {
            expect(line).toContain('[Unprintable]');
            expect(line).not.toContain('value-text');
          }
        });
      });

      it.each([
        [42, '42'],
        [true, 'true'],
        [Symbol('s'), 'Symbol(s)'],
        [undefined, 'undefined'],
      ])('still writes the primitive %p as its own text', (value, text) => {
        logger.log(value);

        expect(getRawOutput(consoleSpy)).toContain(text);
      });

      describe('an Error passed as the trace whose stack is not text', () => {
        const withStack = (stack: unknown): Error => Object.assign(new Error('boom'), { stack });
        const cyclic = (): Record<string, unknown> => {
          const value: Record<string, unknown> = { id: 1 };
          value.self = value;
          return value;
        };

        it.each([
          ['an object', () => withStack({ password: 'value-stack', frame: 'f1' }), '"password":"[REDACTED]"'],
          ['a list of call sites', () => withStack([{ token: 'value-stack' }]), '"token":"[REDACTED]"'],
          ['a cyclic object', () => withStack(cyclic()), '[Circular]'],
          ['a BigInt', () => withStack(98765432109876543210n), '98765432109876543210'],
          [
            'nothing, with an object as the message',
            () => Object.assign(new Error('x'), { stack: undefined, message: { password: 'value-stack' } }),
            '"password":"[REDACTED]"',
          ],
        ])('writes %s as redacted text and keeps the message', (_name, make, written) => {
          const errorSpy = jest.spyOn(console, 'error');

          expect(() => logger.error('saved-message', make())).not.toThrow();

          const line = getRawOutput(errorSpy);
          expect(line).toContain('saved-message');
          expect(line).not.toContain('value-stack');
          expect(line.replace(/\\"/g, '"')).toContain(written);
        });
      });
    });
  });

  describe('error', () => {
    it('should log error messages to console.error', () => {
      const errorSpy = jest.spyOn(console, 'error');
      logger.error('Error message', 'stack trace');

      expect(errorSpy).toHaveBeenCalled();
      const output = getLogOutput(errorSpy);
      expect(output.level).toBe('error');
      expect(output.message).toBe('Error message');
      expect(output.trace).toBe('stack trace');
    });
  });

  // Plugin ctx.logger meta reaches the logger verbatim, so caller metadata must not be able to rewrite
  // the fields a reader trusts to say who logged what, at which level.
  describe('structural fields', () => {
    it('keeps level, context, message, timestamp, trace and requestId out of reach of caller metadata', () => {
      logger.log('[plugin-a] hi', {
        level: 'error',
        context: 'AuthService',
        message: 'API key rotated',
        timestamp: '1970-01-01T00:00:00.000Z',
        trace: 'forged stack',
        requestId: 'forged',
        pluginId: 'plugin-a',
      });

      const output = getLogOutput(consoleSpy) as unknown as Record<string, unknown>;
      expect(output.level).toBe('info');
      expect(output.context).toBe('TestContext');
      expect(output.message).toBe('[plugin-a] hi');
      expect(output.timestamp).not.toBe('1970-01-01T00:00:00.000Z');
      expect(output).not.toHaveProperty('trace');
      expect(output).not.toHaveProperty('requestId');
      expect(output.pluginId).toBe('plugin-a');
    });

    it("still takes error()'s trace and string context from its own parameters", () => {
      const errorSpy = jest.spyOn(console, 'error');
      logger.error('boom', 'real stack', 'OtherContext');

      const output = getLogOutput(errorSpy);
      expect(output.context).toBe('OtherContext');
      expect(output.trace).toBe('real stack');
    });

    it("keeps error()'s own trace over one smuggled in its metadata", () => {
      const errorSpy = jest.spyOn(console, 'error');
      logger.error('boom', 'real stack', { trace: 'forged stack', sessionId: 's1' });

      const output = getLogOutput(errorSpy);
      expect(output.trace).toBe('real stack');
      expect(output.context).toBe('TestContext');
      expect(output.sessionId).toBe('s1');
    });

    it("writes the caller's own fields after the metadata, redacted and below the structural fields", () => {
      logger.log('m', { a: 1, pluginId: 'meta' }, { pluginId: 'own', token: 't', level: 'error' });

      expect(getRawOutput(consoleSpy)).toContain('"message":"m","a":1,"pluginId":"own","token":"[REDACTED]"}');
      expect(getLogOutput(consoleSpy).level).toBe('info');
    });
  });

  describe('warn', () => {
    it('should log warning messages to console.warn', () => {
      const warnSpy = jest.spyOn(console, 'warn');
      logger.warn('Warning message');

      expect(warnSpy).toHaveBeenCalled();
      const output = getLogOutput(warnSpy);
      expect(output.level).toBe('warn');
      expect(output.message).toBe('Warning message');
    });
  });

  describe('log levels', () => {
    it('should not log debug when level is INFO', () => {
      LoggerService.setLogLevel(LogLevel.INFO);
      logger.debug('Debug message');

      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it('should log debug when level is DEBUG', () => {
      LoggerService.setLogLevel(LogLevel.DEBUG);
      logger.debug('Debug message');

      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe('pretty format', () => {
    beforeEach(() => {
      LoggerService.setLogFormat(LogFormat.PRETTY);
    });

    it('should render a NestJS-style human-readable line instead of JSON', () => {
      logger.log('Test message');

      const output = getRawOutput(consoleSpy);
      // Not JSON.
      expect(() => {
        JSON.parse(output);
      }).toThrow();
      // NestJS-style prefix, level label, context and message all present.
      expect(output).toContain('[OpenWA]');
      expect(output).toContain('LOG');
      expect(output).toContain('[TestContext]');
      expect(output).toContain('Test message');
    });

    it('should append metadata as key=value pairs', () => {
      logger.log('Test message', { sessionId: '123', action: 'test' });

      const output = getRawOutput(consoleSpy);
      expect(output).toContain('sessionId=123');
      expect(output).toContain('action=test');
    });

    it('should append the stack trace on a new line for errors', () => {
      const errorSpy = jest.spyOn(console, 'error');
      logger.error('Error message', 'stack trace line');

      const output = getRawOutput(errorSpy);
      expect(output).toContain('Error message');
      expect(output).toContain('stack trace line');
      expect(output).toMatch(/\n.*stack trace line/);
    });
  });

  describe('non-string input (the call shapes Nest uses)', () => {
    it('renders an Error passed as the message with its stack as the trace', () => {
      const errorSpy = jest.spyOn(console, 'error');
      logger.error(new Error('boom'));

      const output = getLogOutput(errorSpy);
      expect(output.message).toBe('boom');
      expect(output.trace).toContain('Error: boom');
      expect(output.trace).toMatch(/\n\s+at /);
    });

    it('turns an Error or other value passed as the trace into a string', () => {
      const errorSpy = jest.spyOn(console, 'error');
      logger.error('failed', new Error('inner'));
      logger.error('failed', 42);

      const calls = errorSpy.mock.calls as string[][];
      expect((JSON.parse(calls[0][0]) as LogEntry).trace).toContain('Error: inner');
      expect((JSON.parse(calls[1][0]) as LogEntry).trace).toBe('42');
    });

    it('redacts an object passed as the trace, in json and pretty output', () => {
      const errorSpy = jest.spyOn(console, 'error');
      const redacted = '{"a":1,"password":"[REDACTED]","n":{"token":"[REDACTED]"}}';
      const trace = { a: 1, password: 'value-trace', n: { token: 'value-token' } };

      logger.error('failed', trace);
      expect(getLogOutput(errorSpy).trace).toBe(redacted);

      errorSpy.mockClear();
      LoggerService.setLogFormat(LogFormat.PRETTY);
      logger.error('failed', trace);
      expect(getRawOutput(errorSpy)).toContain(redacted);
      expect(getRawOutput(errorSpy)).not.toContain('value-');
    });

    it('serializes an object message with secret-named keys redacted', () => {
      logger.log({ a: 1, password: 'p' });

      expect(getLogOutput(consoleSpy).message).toBe('{"a":1,"password":"[REDACTED]"}');
    });

    it('does not throw on a circular object message', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      expect(() => logger.log(circular)).not.toThrow();
      expect(typeof getLogOutput(consoleSpy).message).toBe('string');
    });

    it('writes a circular object message with the cycle marked', () => {
      const circular: Record<string, unknown> = { id: 1 };
      circular.self = circular;

      logger.log(circular);

      expect(getLogOutput(consoleSpy).message).toBe('{"id":1,"self":"[Circular]"}');
    });

    it('does not throw on a circular message that has no prototype', () => {
      const bare = Object.create(null) as Record<string, unknown>;
      bare.self = bare;

      expect(() => logger.log(bare)).not.toThrow();
      expect(getLogOutput(consoleSpy).message).toBe('{"self":"[Circular]"}');
    });

    it('writes a BigInt message as its decimal text', () => {
      logger.log(10n);

      expect(getLogOutput(consoleSpy).message).toBe('10');
    });

    it('does not throw on a message that cannot be read at all', () => {
      const unreadable = new Proxy(
        {},
        {
          ownKeys: (): never => {
            throw new Error('ownKeys');
          },
          get: (): never => {
            throw new Error('get');
          },
        },
      );

      expect(() => logger.log(unreadable)).not.toThrow();
      expect(getLogOutput(consoleSpy).message).toBe('[Unprintable]');
    });

    it('writes fatal() at error level', () => {
      const errorSpy = jest.spyOn(console, 'error');
      logger.fatal('down');

      const output = getLogOutput(errorSpy);
      expect(output.level).toBe('error');
      expect(output.message).toBe('down');
    });
  });

  describe('as the Nest framework logger', () => {
    beforeEach(() => {
      Logger.overrideLogger(createLogger('Nest'));
    });
    afterEach(() => {
      Logger.overrideLogger(new ConsoleLogger());
    });

    it("keeps the exception handler's message, stack, context and request id", () => {
      const errorSpy = jest.spyOn(console, 'error');
      runWithRequestId('req-1', () => new Logger('ExceptionsHandler').error(new Error('boom')));

      const output = getLogOutput(errorSpy) as LogEntry & { requestId?: string };
      expect(output.context).toBe('ExceptionsHandler');
      expect(output.message).toBe('boom');
      expect(output.trace).toContain('Error: boom');
      expect(output.requestId).toBe('req-1');
    });

    it('applies LOG_LEVEL to framework lines', () => {
      new Logger('X').debug('d');
      expect(consoleSpy).not.toHaveBeenCalled();

      new Logger('X').log('m');
      expect(getLogOutput(consoleSpy).context).toBe('X');
    });

    // Nest appends the context name of its Logger after the arguments it was given.
    it('writes no field for the context name Nest appends after the metadata', () => {
      const errorSpy = jest.spyOn(console, 'error');

      new Logger('X').log('m', { a: 1 });
      new Logger('X').error('m', 'stack', { a: 1 });

      expect(Object.keys(getLogOutput(consoleSpy))).toEqual(['timestamp', 'level', 'context', 'message', 'a']);
      expect(Object.keys(getLogOutput(errorSpy))).toEqual(['timestamp', 'level', 'context', 'message', 'a', 'trace']);
    });
  });

  // Without the option Nest keeps its ConsoleLogger, which ignores LOG_LEVEL and LOG_FORMAT.
  it('is installed as the framework logger by main.ts', () => {
    const mainSrc = readFileSync(join(__dirname, '..', '..', 'main.ts'), 'utf8');
    expect(mainSrc).toMatch(/await NestFactory\.create\(AppModule, \{[^}]*\blogger: createLogger\('Nest'\)/);
  });

  describe('createLogger', () => {
    it('should create logger with context', () => {
      const testLogger = createLogger('MyContext');
      testLogger.log('Test');

      const output = getLogOutput(consoleSpy);
      expect(output.context).toBe('MyContext');
    });
  });
});

// The Baileys wire logger reuses this copy with its own key policy and marker, so the options are pinned directly.
describe('redactSecrets', () => {
  it('replaces the value under a secret-named key with [REDACTED] unless told otherwise', () => {
    expect(redactSecrets({ accessToken: 't', visible: 'v' })).toEqual({ accessToken: '[REDACTED]', visible: 'v' });
  });

  it('takes the credential keys and the marker from its options', () => {
    const options = { isSecretKey: (key: string) => key === 'password', marker: '[masked]' };

    expect(redactSecrets({ accessToken: 't', password: 'p' }, options)).toEqual({
      accessToken: 't',
      password: '[masked]',
    });
  });

  // What these values hold is not in their own enumerable properties, so a copy of those alone would write {} or one
  // entry per byte. Each is written in a readable form instead, at every depth.
  describe('a value that keeps its data outside its own properties', () => {
    const deep = (value: unknown): unknown => ({ a: { b: { c: { d: { e: { f: { value } } } } } } });
    const deepValue = (copy: unknown): unknown =>
      (copy as { a: { b: { c: { d: { e: { f: { value: unknown } } } } } } }).a.b.c.d.e.f.value;
    const shallowAndDeep = (value: unknown): unknown[] => [
      (redactSecrets({ value }) as { value: unknown }).value,
      deepValue(redactSecrets(deep(value))),
    ];

    it('copies an Error with its name, message and stack before its own props, which go through the same checks', () => {
      const error = Object.assign(new Error('boom'), { token: 't', attempts: 5n });

      for (const copy of shallowAndDeep(error) as Record<string, unknown>[]) {
        expect(Object.keys(copy)).toEqual(['name', 'message', 'stack', 'token', 'attempts']);
        expect(copy).toMatchObject({ name: 'Error', message: 'boom', token: '[REDACTED]', attempts: '5' });
        expect(copy.stack).toContain('Error: boom');
      }
    });

    it('charges the message and stack of an Error to the characters one copy may write', () => {
      const error = new Error('x'.repeat(2 ** 26));

      expect(redactSecrets({ error, after: 'kept?' })).toEqual({
        error: { name: 'Error', message: '[Truncated]', stack: '[Truncated]' },
        after: '[Truncated]',
      });
    });

    it('writes a Date as its ISO text through the built-in method, and an invalid one as Invalid Date', () => {
      const forged = Object.assign(new Date(0), { toISOString: () => 'forged' });

      expect(shallowAndDeep(new Date(0))).toEqual(['1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z']);
      expect(shallowAndDeep(new Date(Number.NaN))).toEqual(['Invalid Date', 'Invalid Date']);
      expect(shallowAndDeep(forged)).toEqual(['1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z']);
    });

    it('writes a boxed string, number or boolean as its value, read through the built-in method', () => {
      const forged = Object.assign(new String('ab'), { valueOf: () => 'forged', toString: () => 'forged' });

      expect(shallowAndDeep(new String('ab'))).toEqual(['ab', 'ab']);
      expect(shallowAndDeep(new Number(5))).toEqual([5, 5]);
      expect(shallowAndDeep(new Boolean(false))).toEqual([false, false]);
      expect(shallowAndDeep(forged)).toEqual(['ab', 'ab']);
      expect(JSON.stringify(redactSecrets({ nan: new Number(Number.NaN) }))).toBe('{"nan":null}');
    });

    it('copies a boxed BigInt, a Proxy of a boxed string and a value with only its prototype by their own properties', () => {
      const prototypeOnly = [String, Number, Boolean].map(Kind => Object.create(Kind.prototype) as object);
      const otherBrand = Object.setPrototypeOf(new Number(1), String.prototype) as object;

      expect(redactSecrets([Object(1n), new Proxy(new String('ab'), {}), ...prototypeOnly, otherBrand])).toEqual([
        {},
        { 0: 'a', 1: 'b' },
        {},
        {},
        {},
        {},
      ]);
    });

    it('writes a Buffer or a typed array as its type and the elements it has, never its bytes', () => {
      const claiming = Object.defineProperty(new Uint8Array(5_000_001), 'length', { value: 0 });

      expect(shallowAndDeep(Buffer.from('ab'))).toEqual([
        { type: 'Buffer', length: 2 },
        { type: 'Buffer', length: 2 },
      ]);
      expect(shallowAndDeep(new Float64Array(3))[1]).toEqual({ type: 'Float64Array', length: 3 });
      expect(shallowAndDeep(claiming)).toEqual([
        { type: 'Uint8Array', length: 5_000_001 },
        { type: 'Uint8Array', length: 5_000_001 },
      ]);
      expect(shallowAndDeep(new DataView(new ArrayBuffer(8)))).toEqual([{}, {}]);
    });

    it('writes a Map as the array of its pairs, the value of a credential key replaced, and a Set as its values', () => {
      const map = new Map<unknown, unknown>([
        ['password', 'value-map'],
        [1, { token: 't', id: 1 }],
        [{ id: 2 }, 'v'],
      ]);

      for (const copy of shallowAndDeep(map)) {
        expect(copy).toEqual([
          ['password', '[REDACTED]'],
          [1, { token: '[REDACTED]', id: 1 }],
          [{ id: 2 }, 'v'],
        ]);
      }
      expect(shallowAndDeep(new Set([1, 'a', { password: 'p' }]))[1]).toEqual([1, 'a', { password: '[REDACTED]' }]);
      expect(redactSecrets(map, { isSecretKey: key => key === 'id', marker: 'M' })).toEqual([
        ['password', 'value-map'],
        [1, { token: 't', id: 'M' }],
        [{ id: 'M' }, 'v'],
      ]);
    });

    it('writes a Map or a Set that holds itself with [Circular], and one held twice in full each time', () => {
      const map = new Map<string, unknown>();
      map.set('self', map);
      const set = new Set([1]);

      expect(redactSecrets({ map, twice: [set, set] })).toEqual({ map: [['self', '[Circular]']], twice: [[1], [1]] });
    });

    it('reads a Map through the built-in size and entries, not what a subclass defines', () => {
      class Lying<K, V> extends Map<K, V> {
        override get size(): number {
          return 0;
        }
        override forEach(): void {}
      }
      const many = new Lying(Array.from({ length: 1_000_001 }, (_, key) => [key, 1]));

      expect(redactSecrets(new Lying([[1, 2]]))).toEqual([[1, 2]]);
      const read = jest.spyOn(Map.prototype, 'forEach');
      try {
        expect(redactSecrets({ many })).toEqual({ many: '[Truncated]' });
        expect(read).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
    });

    it('tests only a key that is a string against the credential names, and copies any other key', () => {
      const unprintable = {
        toString(): never {
          throw new Error('toString');
        },
        id: 1,
      };

      expect(JSON.stringify(redactSecrets(new Map<unknown, unknown>([[unprintable, 'v']])))).toBe('[[{"id":1},"v"]]');
    });

    // A boxed string key is written as its text, so the value under one that names a credential is replaced too.
    it('tests a boxed string key by its text, read through the built-in method', () => {
      const forged = Object.assign(new String('id'), { valueOf: () => 'password', toString: () => 'password' });
      const map = new Map<unknown, unknown>([
        [new String('password'), 'value-boxed'],
        [forged, 'kept'],
        [new Proxy(new String('token'), {}), 'proxied'],
      ]);

      expect(JSON.stringify(redactSecrets(map))).toBe(
        '[["password","[REDACTED]"],["id","kept"],[{"0":"t","1":"o","2":"k","3":"e","4":"n"},"proxied"]]',
      );
    });

    // A Proxy is copied by its own properties, whatever its traps answer; a value made from one of these prototypes
    // alone lacks the data the built-in methods read.
    it('copies a Proxy, or a value that only has one of these prototypes, by its own properties', () => {
      const prototypeTrap = new Proxy(
        { a: 1 },
        {
          getPrototypeOf: (): never => {
            throw new Error('getPrototypeOf');
          },
        },
      );
      const fakes = [Map, Set, Date].map(Kind => Object.assign(Object.create(Kind.prototype) as object, { id: 1 }));

      expect(
        redactSecrets({ prototypeTrap, map: new Proxy(new Map([[1, 2]]), {}), error: new Proxy(new Error('x'), {}) }),
      ).toEqual({ prototypeTrap: { a: 1 }, map: {}, error: {} });
      expect(redactSecrets(fakes)).toEqual([{ id: 1 }, { id: 1 }, { id: 1 }]);
    });

    it('writes a Map or a Set with more entries than are left as [Truncated] before reading one', () => {
      const entries = (size: number): Map<number, number> =>
        new Map(Array.from({ length: size }, (_, key) => [key, 1]));
      const fourth = (list: unknown): unknown => ({ a: { b: { c: { d: { list } } } } });
      const big = entries(1_000_001);
      const read = jest.spyOn(Map.prototype, 'forEach');
      try {
        expect(redactSecrets({ big })).toEqual({ big: '[Truncated]' });
        expect(redactSecrets(fourth(entries(1000)))).toEqual(fourth('[Truncated]'));
        expect(read).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
      // Below the fifth level each pair array is one more node, and needs room for its two entries in what is left:
      // the Map of 999 that fits takes 999 more nodes, so its last two pairs are written as [Truncated].
      const pairs = Array.from({ length: 997 }, (_, key) => [key, 1]);
      expect(redactSecrets(fourth(entries(999)))).toEqual(fourth([...pairs, '[Truncated]', '[Truncated]']));
      expect(redactSecrets(fourth(new Set(Array.from({ length: 999 }, (_, key) => key))))).toEqual(
        fourth(Array.from({ length: 999 }, (_, key) => key)),
      );
      expect(redactSecrets(fourth(new Set(Array.from({ length: 1000 }, (_, key) => key))))).toEqual(
        fourth('[Truncated]'),
      );
    });

    it.each([LogFormat.JSON, LogFormat.PRETTY])('is written readably in %s output', format => {
      const log = jest.spyOn(console, 'log').mockImplementation();
      LoggerService.setLogFormat(format);
      try {
        createLogger('Test').log('m', {
          at: new Date(0),
          bytes: Buffer.from('ab'),
          map: new Map([[1, 2]]),
          set: new Set([1]),
          error: new Error('boom'),
          boxed: new String('ab'),
        });

        const line = (log.mock.calls as string[][])[0][0];
        const fields =
          format === LogFormat.JSON
            ? [
                '"at":"1970-01-01T00:00:00.000Z"',
                '"bytes":{"type":"Buffer","length":2}',
                '"map":[[1,2]]',
                '"set":[1]',
                '"boxed":"ab"',
              ]
            : [
                'at=1970-01-01T00:00:00.000Z',
                'bytes={"type":"Buffer","length":2}',
                'map=[[1,2]]',
                'set=[1]',
                'boxed=ab',
              ];
        for (const field of fields) expect(line).toContain(field);
        expect(line).toContain('"name":"Error","message":"boom","stack":"Error: boom');
      } finally {
        log.mockRestore();
        LoggerService.setLogFormat(null);
      }
    });
  });

  // JSON.parse makes a property named __proto__ an ordinary own property; the copy must define it as one too.
  describe('a property named __proto__', () => {
    const parsed = (): unknown => JSON.parse('{"__proto__":{"a":1,"password":"value-proto"},"b":2}');

    it('is kept as a field of the copy, with the credentials under it redacted', () => {
      const copy = redactSecrets(parsed()) as Record<string, unknown>;

      expect(Object.keys(copy)).toEqual(['__proto__', 'b']);
      expect(JSON.stringify(copy)).toBe('{"__proto__":{"a":1,"password":"[REDACTED]"},"b":2}');
      expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
      expect(copy.a).toBeUndefined();
    });

    it('is kept at every depth, in an array, and replaced when it names a credential', () => {
      const deep = JSON.stringify(redactSecrets({ a: { b: { c: { d: { e: [parsed()] } } } } }));

      expect(deep).toContain('"__proto__":{"a":1,"password":"[REDACTED]"}');
      expect(deep).not.toContain('value-proto');
      expect(redactSecrets(parsed(), { isSecretKey: key => key === '__proto__', marker: 'M' })).toEqual(
        expect.objectContaining({ b: 2 }),
      );
      expect(JSON.stringify(redactSecrets(parsed(), { isSecretKey: key => key === '__proto__', marker: 'M' }))).toBe(
        '{"__proto__":"M","b":2}',
      );
    });
  });

  it('copies an array as a plain array, whatever class it is an instance of', () => {
    class Rows extends Array<unknown> {}

    const copy = redactSecrets({ rows: Rows.from([1, { token: 't' }]) }) as { rows: unknown[] };

    expect(Object.getPrototypeOf(copy.rows)).toBe(Array.prototype);
    expect(copy.rows).toEqual([1, { token: '[REDACTED]' }]);
  });

  describe('an array longer than one call may walk', () => {
    const zeros = (length: number): number[] => new Array<number>(length).fill(0);

    it('copies a million entries in the first levels and writes a longer array as [Truncated]', () => {
      const whole = redactSecrets({ list: zeros(1_000_000) }) as { list: unknown[] };

      expect(whole.list).toHaveLength(1_000_000);
      expect(redactSecrets({ list: zeros(1_000_001) })).toEqual({ list: '[Truncated]' });
    });

    it('copies a deep array that fits in what is left of the node budget and writes a longer one as [Truncated]', () => {
      // The array sits just below the fifth level: it costs 1 of the 1000 nodes, which leaves 999 entries.
      const deep = (list: unknown): unknown => ({ a: { b: { c: { d: { list } } } } });

      expect(redactSecrets(deep(zeros(999)))).toEqual(deep(zeros(999)));
      expect(redactSecrets(deep(zeros(1000)))).toEqual(deep('[Truncated]'));
    });

    // A sparse array costs its length however little it holds, so the copy visits the entries that exist and not the holes.
    it('copies a sparse array without reading its holes, and writes them as null', () => {
      const sparse: unknown[] = [];
      sparse.length = 1000;
      sparse[2] = { id: 1 };
      sparse[500] = { id: 2, token: 't' };
      const indexReads: string[] = [];
      const watched = new Proxy(sparse, {
        get: (target, key, receiver): unknown => {
          if (typeof key === 'string' && /^\d+$/.test(key)) indexReads.push(key);
          return Reflect.get(target, key, receiver);
        },
      });

      const copy = redactSecrets({ list: watched }) as { list: unknown[] };

      expect(indexReads).toEqual(['2', '500']);
      expect(copy.list).toHaveLength(1000);
      expect(Object.keys(copy.list)).toEqual(['2', '500']);
      expect(JSON.stringify(copy.list).startsWith('[null,null,{"id":1},null,null,')).toBe(true);
      expect(copy.list[500]).toEqual({ id: 2, token: '[REDACTED]' });
    });

    // The caps are applied to the length an array or a typed array has, not to the length an object claims.
    it('reads the length of an array once, for the cap and for the copy', () => {
      let reads = 0;
      const answering = new Proxy([], {
        get: (target, key, receiver): unknown =>
          key === 'length' ? (++reads === 1 ? 0 : 3) : Reflect.get(target, key, receiver),
      });

      expect(redactSecrets({ list: answering })).toEqual({ list: [] });
      expect(reads).toBe(1);
    });

    // The length is taken as a count the way Array.prototype.map takes it: a value that is not a number, a negative or
    // fractional one is cut to a whole number from zero, never handed on as it is.
    describe('an array that reports a length that is not a count', () => {
      const reporting = (length: unknown, items: unknown[] = []): unknown[] =>
        new Proxy(items, {
          get: (target, key, receiver): unknown => (key === 'length' ? length : Reflect.get(target, key, receiver)),
        });
      const secret = { password: 'value-length', toJSON: () => ({ password: 'value-length' }) };

      it.each([
        ['an object with a secret-named key', secret],
        ['an object with nothing', {}],
        ['an array', ['value-length']],
        ['a string that is not a number', 'value-length'],
        ['undefined', undefined],
        ['NaN', NaN],
        ['a negative number', -1],
        ['a negative infinity', -Infinity],
      ])('copies the array as empty when the length is %s, and keeps what is beside it', (_name, length) => {
        const copy = redactSecrets({ list: reporting(length), keep: 1 }) as { list: unknown[]; keep: number };

        expect(JSON.stringify(copy)).toBe('{"list":[],"keep":1}');
        expect(JSON.stringify(copy)).not.toContain('value-length');
      });

      it.each([
        ['a fractional number', 1.5, 1],
        ['a number as text', '2', 2],
      ])('cuts %s to a whole count', (_name, length, count) => {
        const copy = redactSecrets({ list: reporting(length, [10, 20, 30]) }) as { list: unknown[] };

        expect(copy.list).toEqual([10, 20, 30].slice(0, count));
      });

      it('writes an infinite length as [Truncated]', () => {
        expect(redactSecrets({ list: reporting(Infinity) })).toEqual({ list: '[Truncated]' });
      });

      it('keeps the line of a record whose array reports such a length', () => {
        const metadata = { list: reporting(-1), keep: 1 };
        const logger = new LoggerService();
        const log = jest.spyOn(console, 'log').mockImplementation();
        LoggerService.setLogFormat(LogFormat.JSON);
        try {
          logger.log('saved', metadata);

          expect(JSON.parse((log.mock.calls as string[][])[0][0])).toMatchObject({ list: [], keep: 1 });
        } finally {
          log.mockRestore();
          LoggerService.setLogFormat(null);
        }
      });
    });

    describe('a typed array that claims another length than it has', () => {
      class Claiming extends Uint8Array {
        get length(): number {
          return 0;
        }
      }
      const redefined = (): Uint8Array => Object.defineProperty(new Uint8Array(1_000_001), 'length', { value: 0 });

      it.each([
        ['an own length property', redefined],
        ['a length getter', (): Uint8Array => new Claiming(1_000_001)],
      ])('is written with the elements it has, with %s', (_name, make) => {
        expect(redactSecrets({ file: make() })).toEqual({ file: { type: 'Uint8Array', length: 1_000_001 } });
        expect(redactSecrets(make())).toEqual({ type: 'Uint8Array', length: 1_000_001 });
      });

      it('counts the elements of a typed array, not its bytes', () => {
        expect(redactSecrets({ list: new Float64Array(150_000) })).toEqual({
          list: { type: 'Float64Array', length: 150_000 },
        });
      });

      it('copies a DataView, which has no elements, as an empty object', () => {
        expect(redactSecrets({ view: new DataView(new ArrayBuffer(8)) })).toEqual({ view: {} });
      });
    });

    // An object lists one entry per key; a typed array is written as its type and length, whatever its length.
    describe('a typed array or a wide object', () => {
      const deep = (list: unknown): unknown => ({ a: { b: { c: { d: { list } } } } });
      const keysOf = (copy: unknown): number =>
        Object.keys((copy as { a: { b: { c: { d: { list: object } } } } }).a.b.c.d.list).length;
      const wide = (keys: number): Record<string, number> =>
        Object.fromEntries(Array.from({ length: keys }, (_, key) => [`k${key}`, key]));

      it('writes a deep typed array as its type and length, also one longer than what is left of the node budget', () => {
        expect(redactSecrets(deep(new Uint8Array(999)))).toEqual(deep({ type: 'Uint8Array', length: 999 }));
        expect(redactSecrets(deep(new Uint8Array(1000)))).toEqual(deep({ type: 'Uint8Array', length: 1000 }));
        expect(redactSecrets(deep(Buffer.alloc(1000)))).toEqual(deep({ type: 'Buffer', length: 1000 }));
      });

      it('copies a deep object whose keys fit in what is left of the node budget and writes a wider one as [Truncated]', () => {
        expect(keysOf(redactSecrets(deep(wide(999))))).toBe(999);
        expect(redactSecrets(deep(wide(1000)))).toEqual(deep('[Truncated]'));
      });

      // An object is listed (Object.keys) before its key count can be compared with the budget, so a too wide one is
      // charged for its keys once it is truncated: a second reference to it is refused without listing it again.
      it('lists a too wide object once, however many references to it lie below the fifth level', () => {
        let listings = 0;
        const counted = new Proxy(wide(10_000), {
          ownKeys: target => {
            listings++;
            return Reflect.ownKeys(target);
          },
        });

        const copy = redactSecrets(deep(Array.from({ length: 900 }, () => counted))) as {
          a: { b: { c: { d: { list: unknown[] } } } };
        };

        expect(listings).toBe(1);
        expect(copy.a.b.c.d.list).toHaveLength(900);
        expect(new Set(copy.a.b.c.d.list)).toEqual(new Set(['[Truncated]']));
      });

      it('finishes a record of 900 references to one wide object in a bounded time', () => {
        const shared = wide(20_000);
        const started = Date.now();

        redactSecrets(deep(Array.from({ length: 900 }, () => shared)));

        expect(Date.now() - started).toBeLessThan(500);
      });

      it('spends the node budget on the keys of a too wide object, so what follows it is [Truncated]', () => {
        expect(redactSecrets(deep({ wide: wide(1500), small: { id: 1 } }))).toEqual(
          deep({ wide: '[Truncated]', small: '[Truncated]' }),
        );
        expect(redactSecrets(deep({ small: { id: 1 }, wide: wide(1500) }))).toEqual(
          deep({ small: { id: 1 }, wide: '[Truncated]' }),
        );
      });

      it('copies a wide object whole in the first five levels', () => {
        const copy = redactSecrets({ list: wide(5000) }) as { list: object };

        expect(Object.keys(copy.list)).toHaveLength(5000);
      });

      it('writes a small typed array in the first levels as its type and length', () => {
        expect(redactSecrets({ list: Buffer.from([1, 2, 3]) })).toEqual({ list: { type: 'Buffer', length: 3 } });
      });
    });
  });

  // One copy takes at most 2,000,000 entries: the keys of the objects and the length of the arrays it copies, a shared
  // one charged again at every use. What a caller built is written as it is; a graph that expands past that is cut.
  describe('the entries one copy may take', () => {
    const zeros = (length: number): number[] => new Array<number>(length).fill(0);
    const sparse = (length: number): unknown[] => {
      const list: unknown[] = [];
      list.length = length;
      return list;
    };
    const wide = (keys: number): Record<string, number> =>
      Object.fromEntries(Array.from({ length: keys }, (_, key) => [`k${key}`, key]));
    // What a failing comparison prints for a copy of a million entries.
    const shown = (value: unknown): unknown =>
      value !== null && typeof value === 'object'
        ? `${Array.isArray(value) ? 'list' : 'object'} of ${Object.keys(value).length}`
        : value;
    // The values the copy holds as they are written: a shared object counts at every use.
    const leaves = (node: unknown): number =>
      node !== null && typeof node === 'object'
        ? Object.values(node).reduce<number>((sum, child) => sum + leaves(child), 0)
        : 1;

    it('copies exactly 2,000,000 entries and writes the array that would take one more as [Truncated]', () => {
      // The top object has 2 keys, which come first.
      const whole = redactSecrets({ a: zeros(1_000_000), b: zeros(999_998) }) as { b: unknown[] };
      const over = redactSecrets({ a: zeros(1_000_000), b: zeros(999_999) }) as { a: unknown[]; b: unknown };

      expect(whole.b).toHaveLength(999_998);
      expect(over.a).toHaveLength(1_000_000);
      expect(shown(over.b)).toBe('[Truncated]');
    });

    // A Map is written as the array of its pairs: its list takes one entry a pair and each pair array two more.
    it('charges a Map three entries a pair and writes a pair that does not fit as [Truncated]', () => {
      const pairs = (count: number): number[][] => Array.from({ length: count }, (_, key) => [key, key]);
      const m = new Map(pairs(10) as [number, number][]);
      // The top object has 3 keys and `a` takes a million, so `b` leaves `entries` for the Map.
      const withRoom = (entries: number): unknown =>
        (redactSecrets({ a: sparse(1_000_000), b: sparse(999_997 - entries), m }) as { m: unknown }).m;

      expect(withRoom(30)).toEqual(pairs(10));
      expect(withRoom(29)).toEqual([...pairs(9), '[Truncated]']);
    });

    it('still copies an empty object and an empty array once the entries are spent, and not an object with a key', () => {
      const spent = redactSecrets({ a: zeros(1_000_000), b: zeros(999_995), c: {}, d: [], e: { id: 1 } }) as Record<
        string,
        unknown
      >;

      expect(spent.b).toHaveLength(999_995);
      expect([spent.c, spent.d, spent.e]).toEqual([{}, [], '[Truncated]']);
    });

    it('redacts a secret-named key beside what is cut, and never writes what is cut', () => {
      const copy = redactSecrets({
        a: zeros(1_000_000),
        b: zeros(999_990),
        token: 'value-token',
        c: { password: 'value-password' },
        d: { ...wide(20), password: 'value-far' },
      });

      expect(JSON.stringify({ ...(copy as object), a: 0, b: 0 })).toBe(
        '{"a":0,"b":0,"token":"[REDACTED]","c":{"password":"[REDACTED]"},"d":"[Truncated]"}',
      );
    });

    it('charges every use of a shared array', () => {
      const shared = zeros(600_000);
      const { list } = redactSecrets({ list: [shared, shared, shared, shared] }) as { list: unknown[] };

      expect(list.slice(0, 3).map(copy => (copy as unknown[]).length)).toEqual([600_000, 600_000, 600_000]);
      expect(shown(list[3])).toBe('[Truncated]');
    });

    it('charges the length of a sparse array, holes included, for each one', () => {
      const { list } = redactSecrets({
        list: [sparse(600_000), sparse(600_000), sparse(600_000), sparse(600_000)],
      }) as {
        list: unknown[];
      };

      expect(list.slice(0, 3).map(copy => (copy as unknown[]).length)).toEqual([600_000, 600_000, 600_000]);
      expect(shown(list[3])).toBe('[Truncated]');
    });

    it('writes every view of one buffer as its type and length, without listing its elements', () => {
      const buffer = new ArrayBuffer(600_000);
      const keys = jest.spyOn(Object, 'keys');
      try {
        const { views } = redactSecrets({
          list: zeros(1_000_000),
          views: [new Uint8Array(buffer), new Uint8Array(buffer), new Uint8Array(buffer)],
        }) as { views: unknown[] };

        expect(views).toEqual(Array.from({ length: 3 }, () => ({ type: 'Uint8Array', length: 600_000 })));
        expect(keys.mock.calls.filter(([node]) => node instanceof Uint8Array)).toHaveLength(0);
      } finally {
        keys.mockRestore();
      }
    });

    // An object is listed (Object.keys) before its key count can be compared with what is left, so one that does not
    // fit is charged once it is listed: the next reference to it, or any other object, is refused without listing it.
    it('lists a wide object only until it no longer fits, however many references to it follow', () => {
      const shared = wide(60_000);
      const keys = jest.spyOn(Object, 'keys');
      try {
        // The two arrays leave 99,997 entries, and the list takes 6 of them: one reference fits, the second does not.
        const { list } = redactSecrets({
          first: zeros(1_000_000),
          second: zeros(900_000),
          list: Array.from({ length: 6 }, () => shared),
        }) as { list: unknown[] };

        expect(keys.mock.calls.filter(([node]) => node === shared)).toHaveLength(2);
        expect(list.map(copy => (typeof copy === 'string' ? copy : Object.keys(copy as object).length))).toEqual([
          60_000,
          ...new Array<string>(5).fill('[Truncated]'),
        ]);
      } finally {
        keys.mockRestore();
      }
    });

    // Every level is within the first five, so the 1000 nodes of the deeper levels are not what stops it.
    it('cuts a graph of shared levels that expands past it, and keeps the part it copied', () => {
      let level: Record<string, unknown> = wide(40);
      for (let i = 1; i < 4; i++)
        level = Object.fromEntries(Array.from({ length: 40 }, (_, key) => [`k${key}`, level]));

      const copy = redactSecrets({ id: 'graph', graph: level }) as { id: string; graph: Record<string, unknown> };

      expect(copy.id).toBe('graph');
      expect(leaves(copy)).toBeGreaterThan(1_000_000);
      expect(leaves(copy)).toBeLessThanOrEqual(2_000_000);
      expect(JSON.stringify(copy.graph).includes('[Truncated]')).toBe(true);
    });
  });

  // One copy writes at most 2**26 characters of string values, BigInt text and key names, a shared one charged again at
  // every use. A string is not copied, so the entries above cannot see a long one referenced many times.
  describe('the characters one copy may write', () => {
    const LIMIT = 2 ** 26;
    const text = (length: number): string => 'x'.repeat(length);
    // What a failing comparison prints: the length of a long string or key name, never the text.
    const shown = (value: unknown): unknown => {
      if (typeof value === 'string') return value.length > 20 ? value.length : value;
      if (value === null || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [shown(key), shown(child)]));
    };

    // The key name counts with the value, so the key `a` leaves room for 2**26 - 1 characters.
    it('keeps a copy of exactly 2**26 characters and writes one character more as [Truncated]', () => {
      expect(shown(redactSecrets({ a: text(LIMIT - 1) }))).toEqual({ a: LIMIT - 1 });
      expect(shown(redactSecrets({ a: text(LIMIT) }))).toEqual({ a: '[Truncated]' });
    });

    it('charges every use of a shared string', () => {
      const shared = text(2 ** 24 - 1);
      const { list } = redactSecrets({ list: [shared, shared, shared, shared, shared] }) as { list: unknown[] };

      expect(list.map(shown)).toEqual([2 ** 24 - 1, 2 ** 24 - 1, 2 ** 24 - 1, 2 ** 24 - 1, '[Truncated]']);
    });

    it('charges the key names of an object at every use', () => {
      const shared = { [text(2 ** 24 - 1)]: 1 };
      const { list } = redactSecrets({ list: [shared, shared, shared, shared, shared] }) as { list: unknown[] };

      expect(list.map(shown)).toEqual([
        { [2 ** 24 - 1]: 1 },
        { [2 ** 24 - 1]: 1 },
        { [2 ** 24 - 1]: 1 },
        { [2 ** 24 - 1]: 1 },
        '[Truncated]',
      ]);
    });

    it('does not write an object whose key name does not fit, and cuts what follows it, not the object around it', () => {
      const copy = redactSecrets({ a: { [text(LIMIT + 1)]: 1 }, b: 'after', c: {}, d: [] });

      expect(shown(copy)).toEqual({ a: '[Truncated]', b: '[Truncated]', c: '[Truncated]', d: '[Truncated]' });
    });

    it('charges the text of a Date like a string, and writes one after a cut string as [Truncated]', () => {
      // The key names take 2 characters; the ISO text is 24 and the text of an invalid Date 12.
      const dated = (length: number, date: Date): unknown => shown(redactSecrets({ a: text(length), d: date }));

      expect(dated(LIMIT - 26, new Date(0))).toEqual({ a: LIMIT - 26, d: 24 });
      expect(dated(LIMIT - 25, new Date(0))).toEqual({ a: LIMIT - 25, d: '[Truncated]' });
      expect(dated(LIMIT - 14, new Date(Number.NaN))).toEqual({ a: LIMIT - 14, d: 'Invalid Date' });
      expect(dated(LIMIT - 13, new Date(Number.NaN))).toEqual({ a: LIMIT - 13, d: '[Truncated]' });
      expect(dated(LIMIT + 1, new Date(0))).toEqual({ a: '[Truncated]', d: '[Truncated]' });
    });

    it('charges the value of a boxed string like a string', () => {
      // The key names take 2 characters.
      expect(shown(redactSecrets({ a: text(LIMIT - 4), s: new String('ab') }))).toEqual({ a: LIMIT - 4, s: 'ab' });
      expect(shown(redactSecrets({ a: text(LIMIT - 3), s: new String('ab') }))).toEqual({
        a: LIMIT - 3,
        s: '[Truncated]',
      });
    });

    it('charges the text of a BigInt sixteen characters to the digit', () => {
      const big = 10n ** 999n;
      // The two key names take 2 characters, and `left` is what the BigInt finds when its turn comes.
      const withRoom = (left: number): unknown => shown(redactSecrets({ a: text(LIMIT - 2 - left), b: big }));

      expect(withRoom(16_000)).toEqual({ a: LIMIT - 2 - 16_000, b: 1000 });
      expect(withRoom(15_999)).toEqual({ a: LIMIT - 2 - 15_999, b: '[Truncated]' });
    });

    it('builds no more BigInt text once the characters are spent', () => {
      const big = 10n ** 999n;
      const toString = jest.spyOn(BigInt.prototype, 'toString');
      try {
        // Three uses of 1000 digits fit, 16,000 characters each; the fourth is built and found not to fit.
        const { list } = redactSecrets({
          a: text(LIMIT - 3 * 16_000 - 100),
          list: Array.from({ length: 10 }, () => big),
        }) as {
          list: unknown[];
        };

        expect(list.map(shown)).toEqual([1000, 1000, 1000, ...new Array<string>(7).fill('[Truncated]')]);
        expect(toString).toHaveBeenCalledTimes(4);
      } finally {
        toString.mockRestore();
      }
    });

    it('does not charge the value of a secret-named key, which is not written', () => {
      expect(shown(redactSecrets({ password: text(LIMIT), after: 'ok' }))).toEqual({
        password: '[REDACTED]',
        after: 'ok',
      });
    });

    it('still redacts a secret-named key beside a string that is cut, and does not charge its value', () => {
      const copy = redactSecrets({ big: text(LIMIT + 1), password: text(LIMIT) });

      expect(shown(copy)).toEqual({ big: '[Truncated]', password: '[REDACTED]' });
    });

    it('keeps the rest of a line whose second string is cut', () => {
      const logger = new LoggerService();
      const log = jest.spyOn(console, 'log').mockImplementation();
      LoggerService.setLogFormat(LogFormat.JSON);
      try {
        logger.log('saved', { sessionId: 's1', first: text(LIMIT / 2 + 1), second: text(LIMIT / 2), after: 3 });

        const line = JSON.parse((log.mock.calls as string[][])[0][0]) as Record<string, unknown>;
        expect(shown({ ...line, timestamp: 0 })).toEqual({
          timestamp: 0,
          level: 'info',
          context: 'Application',
          message: 'saved',
          sessionId: 's1',
          first: LIMIT / 2 + 1,
          second: '[Truncated]',
          after: 3,
        });
      } finally {
        log.mockRestore();
        LoggerService.setLogFormat(null);
      }
    });
  });

  describe('the bounds of the copy', () => {
    // `rows` ends up `above` objects below the top, so its entries sit one level lower: with 3 above they are in
    // the fifth level, the last one copied whole, and with 4 above they are in the sixth, the first one that costs.
    const rowsBelow = (above: number, rows: unknown): unknown => {
      let value = rows;
      for (let i = 0; i < above; i++) value = { level: value };
      return value;
    };
    const rowsIn = (copy: unknown, above: number): unknown[] => {
      let value = copy as Record<string, unknown>;
      for (let i = 0; i < above; i++) value = value.level as Record<string, unknown>;
      return value as unknown as unknown[];
    };
    const objects = (length: number): Array<{ id: number }> => Array.from({ length }, (_, id) => ({ id }));

    it('copies every entry of the fifth level whole, however many there are', () => {
      const rows = rowsIn(redactSecrets(rowsBelow(3, objects(1500))), 3);

      expect(rows).toHaveLength(1500);
      expect(rows[1499]).toEqual({ id: 1499 });
    });

    it('copies exactly 1000 objects of the sixth level and writes the rest as [Truncated]', () => {
      const rows = rowsIn(
        redactSecrets(
          rowsBelow(
            4,
            Array.from({ length: 1500 }, () => ({})),
          ),
        ),
        4,
      );

      expect(rows).toHaveLength(1500);
      expect(rows[999]).toEqual({});
      expect(rows[1000]).toBe('[Truncated]');
      expect(rows.filter(row => row === '[Truncated]')).toHaveLength(500);
    });

    it('leaves the last of the 1000 nodes no room for an object that has a key', () => {
      const rows = rowsIn(redactSecrets(rowsBelow(4, objects(1500))), 4);

      expect(rows[998]).toEqual({ id: 998 });
      expect(rows[999]).toBe('[Truncated]');
      expect(rows.filter(row => row === '[Truncated]')).toHaveLength(501);
    });

    it('writes an object met again inside itself as [Circular], however many objects lie between', () => {
      const first: Record<string, unknown> = { id: 'first' };
      first.second = { id: 'second', first };

      expect(redactSecrets({ first })).toEqual({
        first: { id: 'first', second: { id: 'second', first: '[Circular]' } },
      });
    });

    it('writes an array met again inside itself as [Circular], however many arrays lie between', () => {
      const outer: unknown[] = [];
      outer.push([outer]);
      const own: unknown[] = [];
      own.push(own);

      expect(redactSecrets({ outer, own })).toEqual({ outer: [['[Circular]']], own: ['[Circular]'] });
    });

    it('keeps an own toJSON that is not a function, and drops one that is', () => {
      expect(
        redactSecrets({ kept: { id: 1, toJSON: 'not a function' }, dropped: { id: 2, toJSON: () => 'x' } }),
      ).toEqual({
        kept: { id: 1, toJSON: 'not a function' },
        dropped: { id: 2 },
      });
    });
  });
});
