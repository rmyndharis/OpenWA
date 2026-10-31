import { HookManager } from '../hooks';
import { PluginCapabilityContext } from './plugin-capability-context';
import { PluginHostServices } from './plugin-host-services';
import { PluginStorageService } from './plugin-storage.service';
import { PluginInstance, PluginManifest, PluginStatus, PluginType } from './plugin.interfaces';
import { createLogger, LogFormat, LoggerService, LogLevel } from '../../common/services/logger.service';

describe('the logger a plugin gets', () => {
  const manifest: PluginManifest = {
    id: 'p1',
    name: 'P1',
    version: '1.0.0',
    type: PluginType.EXTENSION,
    main: 'index.js',
  };

  const setup = (sink?: ReturnType<typeof createLogger>) => {
    const host = { error: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    const context = new PluginCapabilityContext(
      sink ?? (host as unknown as ReturnType<typeof createLogger>),
      {} as PluginHostServices,
      new HookManager(),
      { createPluginStorage: () => ({}) } as unknown as PluginStorageService,
    );
    const plugin = {
      manifest,
      status: PluginStatus.ENABLED,
      config: {},
      sessionConfig: {},
    } as unknown as PluginInstance;
    return { host, logger: context.createPluginContext(plugin).logger };
  };

  it('passes no trace when an error line has no error, so the line does not carry the text "undefined"', () => {
    const { host, logger } = setup();

    logger.error('upload failed');
    logger.error('upload failed', undefined, { sessionId: 's1' });

    expect(host.error).toHaveBeenNthCalledWith(1, '[p1] upload failed', undefined, {}, { pluginId: 'p1' });
    expect(host.error).toHaveBeenNthCalledWith(
      2,
      '[p1] upload failed',
      undefined,
      { sessionId: 's1' },
      { pluginId: 'p1' },
    );
  });

  // The parameter is a record, but plugin code is not type checked: a string or an array given as the meta must not be
  // spread into one field per character or per index.
  describe('a meta that is not a record', () => {
    // The fields a host logger call writes: the meta (the second argument, or the third of error()) and the host's own
    // fields, which follow it.
    const metaOf = (spy: jest.Mock, argument: 1 | 2): unknown => {
      const [meta, own] = (spy.mock.calls as unknown[][])[0].slice(argument);
      return { ...(meta as object), ...(own as object) };
    };
    const asRecord = (meta: unknown): Record<string, unknown> => meta as Record<string, unknown>;

    it.each([
      ['a string', 'abc'],
      ['an array', [1, { token: 't' }]],
      ['a number', 404],
    ])('writes %s as one field', (_name, meta) => {
      const { host, logger } = setup();

      logger.log('m', asRecord(meta));
      logger.debug('m', asRecord(meta));
      logger.warn('m', asRecord(meta));
      logger.error('m', undefined, asRecord(meta));

      for (const written of [metaOf(host.log, 1), metaOf(host.debug, 1), metaOf(host.warn, 1), metaOf(host.error, 2)]) {
        expect(written).toEqual({ meta, pluginId: 'p1' });
      }
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
    ])('writes %s as no fields besides the plugin id', (_name, meta) => {
      const { host, logger } = setup();

      logger.warn('m', asRecord(meta));

      expect(host.warn).toHaveBeenCalledWith('[p1] m', {}, { pluginId: 'p1' });
      expect(Object.keys(metaOf(host.warn, 1) as object)).toEqual(['pluginId']);
    });

    it('writes a string as one field of the line the logger prints', () => {
      LoggerService.setLogFormat(LogFormat.JSON);
      const warn = jest.spyOn(console, 'warn').mockImplementation();
      try {
        const { logger } = setup(createLogger('Plugins'));

        logger.warn('failed', 'abc' as unknown as Record<string, unknown>);

        const line = JSON.parse((warn.mock.calls as string[][])[0][0]) as Record<string, unknown>;
        expect(line).toMatchObject({ message: '[p1] failed', meta: 'abc', pluginId: 'p1' });
        expect(line).not.toHaveProperty('0');
      } finally {
        warn.mockRestore();
        LoggerService.setLogFormat(null);
      }
    });

    // Only a plain record is spread into the fields of the line; every other object is one value.
    it.each([
      ['a String wrapper', (): unknown => new String('hello')],
      ['a Uint8Array', (): unknown => new Uint8Array([1, 2, 3])],
      ['a Map', (): unknown => new Map([[1, 2]])],
      ['a Date', (): unknown => new Date(0)],
      ['an Error', (): unknown => new Error('boom')],
      ['an instance of a class', (): unknown => new (class Model {})()],
    ])('writes %s as one field', (_name, make) => {
      const { host, logger } = setup();
      const meta = make();

      logger.warn('m', asRecord(meta));

      expect(host.warn).toHaveBeenCalledWith('[p1] m', { meta }, { pluginId: 'p1' });
      expect(Object.keys(metaOf(host.warn, 1) as object)).toEqual(['meta', 'pluginId']);
    });

    it.each([
      ['an object literal', (): unknown => ({ sessionId: 's1' })],
      [
        'an object without a prototype',
        (): unknown => Object.assign(Object.create(null) as object, { sessionId: 's1' }),
      ],
      ['a record made in another realm', (): unknown => structuredClone({ sessionId: 's1' })],
    ])('keeps %s as the fields of the line', (_name, make) => {
      const { host, logger } = setup();

      logger.warn('m', asRecord(make()));

      expect(metaOf(host.warn, 1)).toEqual({ sessionId: 's1', pluginId: 'p1' });
    });

    it('keeps the fields of a record as they are', () => {
      const { host, logger } = setup();

      logger.warn('m', { sessionId: 's1', nested: { a: 1 } });

      expect(host.warn).toHaveBeenCalledWith('[p1] m', { sessionId: 's1', nested: { a: 1 } }, { pluginId: 'p1' });
    });
  });

  // The plugin id is the host's field, not part of the plugin's meta: a meta the logger cuts or cannot read keeps it.
  describe('a meta the logger cannot write whole', () => {
    const wide = (): object => {
      const meta: Record<string, number> = {};
      for (let key = 0; key <= 2_000_000; key++) meta[`k${key}`] = 1;
      return meta;
    };
    const throwing = (): object => ({
      a: {
        get b(): never {
          throw new Error('getter');
        },
      },
    });

    it.each([
      ['a value below it throws when read', throwing, 'metadata', '[Unreadable]'],
      ['it has more keys than one line may copy', wide, 'metadata', '[Truncated]'],
      [
        'a key name passes the characters one line may write',
        () => ({ a: 'x'.repeat(2 ** 26 - 5), bbbbbbbbbb: 1 }),
        'metadata',
        '[Truncated]',
      ],
      [
        'its strings take every character one line may write',
        () => ({ big: 'x'.repeat(2 ** 26) }),
        'big',
        '[Truncated]',
      ],
    ])('keeps the plugin id when %s', (_name, make, field, marker) => {
      LoggerService.setLogFormat(LogFormat.JSON);
      const warn = jest.spyOn(console, 'warn').mockImplementation();
      const error = jest.spyOn(console, 'error').mockImplementation();
      try {
        const { logger } = setup(createLogger('Plugins'));

        logger.warn('failed', make() as Record<string, unknown>);
        logger.error('failed', new Error('boom'), make() as Record<string, unknown>);

        for (const spy of [warn, error]) {
          const line = JSON.parse((spy.mock.calls as string[][])[0][0]) as Record<string, unknown>;
          expect(line).toMatchObject({ message: '[p1] failed', [field]: marker, pluginId: 'p1' });
        }
        expect(JSON.parse((error.mock.calls as string[][])[0][0])).toMatchObject({ trace: 'boom' });
      } finally {
        warn.mockRestore();
        error.mockRestore();
        LoggerService.setLogFormat(null);
      }
    });

    it('writes the host plugin id where a pluginId of the meta stood, never the meta one', () => {
      LoggerService.setLogFormat(LogFormat.JSON);
      const warn = jest.spyOn(console, 'warn').mockImplementation();
      try {
        const { logger } = setup(createLogger('Plugins'));

        logger.warn('m', { pluginId: 'other', a: 1 });

        expect((warn.mock.calls as string[][])[0][0]).toContain('"message":"[p1] m","pluginId":"p1","a":1}');
      } finally {
        warn.mockRestore();
        LoggerService.setLogFormat(null);
      }
    });
  });

  // Plugin code is not type checked and can pass anything: no argument may make the call throw into the plugin, and
  // every line keeps the plugin id.
  describe('an argument that throws when it is read', () => {
    const trap = (): never => {
      throw new Error('trap');
    };
    const revoked = (target: object): object => {
      const { proxy, revoke } = Proxy.revocable(target, {});
      revoke();
      return proxy;
    };
    // The lines of the nine calls below, in the order they were made, whatever console method each went to.
    const written = (make: () => unknown): Record<string, unknown>[] => {
      LoggerService.setLogFormat(LogFormat.JSON);
      LoggerService.setLogLevel(LogLevel.DEBUG);
      const lines: Record<string, unknown>[] = [];
      const spies = [jest.spyOn(console, 'log'), jest.spyOn(console, 'warn'), jest.spyOn(console, 'error')];
      for (const spy of spies)
        spy.mockImplementation((line: string) => lines.push(JSON.parse(line) as Record<string, unknown>));
      try {
        const { logger } = setup(createLogger('Plugins'));
        const meta = (): Record<string, unknown> => make() as Record<string, unknown>;
        logger.log(make() as string);
        logger.debug(make() as string);
        logger.warn(make() as string);
        logger.error(make() as string);
        logger.error('m', make());
        logger.log('m', meta());
        logger.debug('m', meta());
        logger.warn('m', meta());
        logger.error('m', undefined, meta());
        return lines;
      } finally {
        for (const spy of spies) spy.mockRestore();
        LoggerService.setLogFormat(null);
        LoggerService.setLogLevel(LogLevel.INFO);
      }
    };

    it.each([
      ['a Proxy whose getPrototypeOf trap throws', (): unknown => new Proxy({ a: 1 }, { getPrototypeOf: trap })],
      ['a Proxy whose get trap throws', (): unknown => new Proxy({ a: 1 }, { get: trap })],
      ['a Proxy whose ownKeys trap throws', (): unknown => new Proxy({ a: 1 }, { ownKeys: trap })],
      ['a revoked Proxy', (): unknown => revoked({ a: 1 })],
      ['a revoked Proxy of an array', (): unknown => revoked([1])],
      ['an object whose toString throws', (): unknown => ({ toString: trap, valueOf: trap })],
      ['an object without a prototype', (): unknown => Object.create(null) as object],
      ['a Symbol', (): unknown => Symbol('s')],
      [
        'an Error whose message getter throws',
        (): unknown => Object.defineProperty(new Error('x'), 'message', { get: trap }),
      ],
      [
        'an Error behind a Proxy whose getPrototypeOf trap throws',
        (): unknown => new Proxy(new Error('x'), { getPrototypeOf: trap }),
      ],
    ])('writes every line with the plugin id when the message, error or meta is %s', (_name, make) => {
      const all = written(make);

      expect(all).toHaveLength(9);
      for (const line of all) expect(line).toMatchObject({ pluginId: 'p1' });
    });

    it('writes what it can read: the text String gives, the marker for the rest, a Proxy meta by its own properties', () => {
      expect(written(() => Symbol('s'))[0]).toMatchObject({ message: '[p1] Symbol(s)' });
      expect(written(() => Object.create(null) as object)[0]).toMatchObject({ message: '[p1] [Unprintable]' });
      const message = Object.defineProperty(new Error('x'), 'message', { get: trap });
      expect(written(() => message)[4]).toMatchObject({ message: '[p1] m', trace: '[Unprintable]' });
      expect(written(() => new Proxy({ a: 1 }, { getPrototypeOf: trap }))[5]).toMatchObject({ a: 1, pluginId: 'p1' });
      expect(written(() => revoked({ a: 1 }))[5]).toMatchObject({ metadata: '[Unreadable]', pluginId: 'p1' });
    });
  });

  it('passes the message of an Error, and the text of anything else, as the trace', () => {
    const { host, logger } = setup();

    logger.error('upload failed', new Error('boom'));
    logger.error('upload failed', 'plain text');
    logger.error('upload failed', 404);
    logger.error('upload failed', null);

    expect(host.error.mock.calls.map((call: unknown[]) => call[1])).toEqual(['boom', 'plain text', '404', 'null']);
  });
});
