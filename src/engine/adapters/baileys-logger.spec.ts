import { createBaileysLogger } from './baileys-logger';

// Everything the logger writes to stdout while `emit` runs.
const captureOutput = (emit: () => void): string => {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (chunk: string): boolean => {
    written.push(chunk);
    return true;
  };
  try {
    emit();
  } finally {
    (process.stdout as { write: unknown }).write = original;
  }
  return written.join('');
};

describe('createBaileysLogger redacts credentials the library hands it', () => {
  const captureLine = (write: (obj: unknown, msg?: string) => void, payload: unknown): Record<string, unknown> =>
    JSON.parse(captureOutput(() => write(payload))) as Record<string, unknown>;

  it('replaces a proxy password carried by a socks connect error', () => {
    const previous = process.env.BAILEYS_LOG_LEVEL;
    process.env.BAILEYS_LOG_LEVEL = 'debug';
    try {
      const logger = createBaileysLogger();
      const line = captureLine(logger.error, {
        err: { options: { proxy: { host: 'p', port: 1080, userId: 'u', password: 'hunter2' } } },
      });
      expect(JSON.stringify(line)).not.toContain('hunter2');
      expect(JSON.stringify(line)).toContain('[redacted]');
      expect(JSON.stringify(line)).toContain('"host":"p"');
    } finally {
      process.env.BAILEYS_LOG_LEVEL = previous;
    }
  });

  it("keeps an error's message and stack, nested or passed alone, and still redacts its props", () => {
    const previous = process.env.BAILEYS_LOG_LEVEL;
    process.env.BAILEYS_LOG_LEVEL = 'debug';
    try {
      const logger = createBaileysLogger();
      const err = Object.assign(new Error('Socks5 proxy rejected connection'), {
        options: { proxy: { host: 'p', password: 'hunter2' } },
      });
      for (const payload of [{ err }, err]) {
        const line = JSON.stringify(captureLine(logger.error, payload));
        expect(line).toContain('"message":"Socks5 proxy rejected connection"');
        expect(line).toContain('baileys-logger.spec.ts');
        expect(line).not.toContain('hunter2');
        expect(line).toContain('"host":"p"');
      }
    } finally {
      process.env.BAILEYS_LOG_LEVEL = previous;
    }
  });
});

// The library hands this logger whatever object a failure carried, so the record is not ours to shape.
describe('createBaileysLogger writes any record the library hands it', () => {
  let previousLevel: string | undefined;
  beforeEach(() => {
    previousLevel = process.env.BAILEYS_LOG_LEVEL;
    process.env.BAILEYS_LOG_LEVEL = 'debug';
  });
  afterEach(() => {
    if (previousLevel === undefined) delete process.env.BAILEYS_LOG_LEVEL;
    else process.env.BAILEYS_LOG_LEVEL = previousLevel;
  });

  const write = (record: unknown, msg?: string): Record<string, unknown> =>
    JSON.parse(captureOutput(() => createBaileysLogger().debug(record, msg))) as Record<string, unknown>;
  const nest = (levels: number, leaf: unknown): unknown => {
    let value = leaf;
    for (let i = 0; i < levels; i++) value = { level: value };
    return value;
  };
  const withCycle = (): Record<string, unknown> => {
    const socket: Record<string, unknown> = { id: 1 };
    socket.self = socket;
    return socket;
  };

  it.each(['password', 'secret', 'token', 'apikey', 'api_key', 'authorization', 'Authorization', 'API_KEY'])(
    'replaces the value under %s',
    key => {
      expect(write({ [key]: 'value-1', visible: 'v' }, 'x')).toMatchObject({ [key]: '[redacted]', visible: 'v' });
    },
  );

  it('writes an ordinary record exactly as given, apart from its credentials', () => {
    const record = {
      jid: '1@s.whatsapp.net',
      attempt: 2,
      tokenCount: 3, // names a credential word but is not one: only the exact names above are replaced
      list: [1, 'two', { three: 3 }],
      nested: { ok: true, none: null },
    };

    const { ts, ...line } = write({ ...record, token: 't' }, 'retrying');

    expect(ts).toEqual(expect.any(String));
    expect(JSON.stringify(line)).toBe(
      JSON.stringify({ level: 'debug', context: 'baileys-wire', ...record, token: '[redacted]', msg: 'retrying' }),
    );
  });

  it('writes a plain string as the message', () => {
    expect(write('connection opened')).toMatchObject({
      level: 'debug',
      context: 'baileys-wire',
      msg: 'connection opened',
    });
  });

  it('writes a wide record in full at the levels records normally have', () => {
    const { items } = write({ items: Array.from({ length: 1500 }, (_, id) => ({ id, tags: [id] })) }, 'x') as {
      items: unknown[];
    };

    expect(items).toHaveLength(1500);
    expect(items[1499]).toEqual({ id: 1499, tags: [1499] });
  });

  describe('the boundaries of the whole levels and of the node budget', () => {
    const bare = (length: number): object[] => Array.from({ length }, () => ({}));
    const wide = (keys: number): Record<string, number> =>
      Object.fromEntries(Array.from({ length: keys }, (_, key) => [`k${key}`, key]));
    const at = (line: unknown, ...path: string[]): unknown =>
      path.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], line);

    it('copies exactly 1000 objects below the fifth level and writes the next as [Truncated]', () => {
      const rows = at(write({ a: { b: { c: { rows: bare(1001) } } } }, 'x'), 'a', 'b', 'c', 'rows') as unknown[];

      expect(rows.slice(0, 1000)).toEqual(bare(1000));
      expect(rows[1000]).toBe('[Truncated]');
    });

    it('copies an object of the fifth level whole, whatever its number of keys', () => {
      const copy = at(write({ a: { b: { c: { wide: wide(1500) } } } }, 'x'), 'a', 'b', 'c', 'wide') as object;

      expect(Object.keys(copy)).toHaveLength(1500);
    });

    it('copies an object of the sixth level that fits in what is left of the budget, and not a wider one', () => {
      const fits = at(
        write({ a: { b: { c: { d: { wide: wide(999) } } } } }, 'x'),
        'a',
        'b',
        'c',
        'd',
        'wide',
      ) as object;
      const wider = at(write({ a: { b: { c: { d: { wide: wide(1000) } } } } }, 'x'), 'a', 'b', 'c', 'd', 'wide');

      expect(Object.keys(fits)).toHaveLength(999);
      expect(wider).toBe('[Truncated]');
    });

    it('writes 900 references to one wide object below the fifth level as [Truncated] in a bounded time', () => {
      const shared = wide(20_000);

      const started = Date.now();
      const rows = at(
        write({ a: { b: { c: { d: { rows: Array.from({ length: 900 }, () => shared) } } } } }, 'x'),
        'a',
        'b',
        'c',
        'd',
        'rows',
      ) as unknown[];

      expect(Date.now() - started).toBeLessThan(500);
      expect(new Set(rows)).toEqual(new Set(['[Truncated]']));
    });
  });

  it('replaces a credential nested deeper than five levels', () => {
    const line = JSON.stringify(write({ record: nest(8, { password: 'value-deep', visible: 'v' }) }, 'x'));

    expect(line).not.toContain('value-deep');
    expect(line).toContain('"password":"[redacted]","visible":"v"');
  });

  it('writes a Buffer of 5 million bytes as its type and length at once, in the first levels and below the fifth', () => {
    const file = Buffer.alloc(5_000_000);

    const started = Date.now();
    const shallow = write({ file, jid: 'j' }, 'x');
    const deep = write({ a: { b: { c: { d: { e: { file } } } } } }, 'x');

    expect(Date.now() - started).toBeLessThan(1000);
    expect(shallow).toMatchObject({ file: { type: 'Buffer', length: 5_000_000 }, jid: 'j', msg: 'x' });
    expect(deep).toMatchObject({ a: { b: { c: { d: { e: { file: { type: 'Buffer', length: 5_000_000 } } } } } } });
  });

  it('writes a property named __proto__ as a field, with the credentials under it redacted', () => {
    const line = JSON.stringify(write(JSON.parse('{"__proto__":{"a":1,"password":"value-proto"},"b":2}'), 'm'));

    expect(line).toContain('"__proto__":{"a":1,"password":"[redacted]"}');
    expect(line).toContain('"b":2');
    expect(line).not.toContain('value-proto');
  });

  it('counts a typed array by the elements it has, not by the length it claims', () => {
    const file = Object.defineProperty(new Uint8Array(1_000_001), 'length', { value: 0 });

    expect(write({ file, jid: 'j' }, 'x')).toMatchObject({ file: { type: 'Uint8Array', length: 1_000_001 }, jid: 'j' });
  });

  it('writes a Map as its pairs with the value of a credential key redacted, and a Date as its ISO text', () => {
    const line = JSON.stringify(
      write({
        keys: new Map([
          ['Password', 'value-map'],
          ['jid', 'j'],
        ]),
        at: new Date(0),
      }),
    );

    expect(line).toContain('"keys":[["Password","[redacted]"],["jid","j"]]');
    expect(line).toContain('"at":"1970-01-01T00:00:00.000Z"');
    expect(line).not.toContain('value-map');
  });

  it('copies an array that reports a length that is not a count as empty, and keeps the rest of the record', () => {
    const reporting = (length: unknown): unknown[] =>
      new Proxy([], {
        get: (target, key, receiver): unknown => (key === 'length' ? length : Reflect.get(target, key, receiver)),
      });
    const line = JSON.stringify(
      write({ a: reporting({ password: 'value-length' }), b: reporting(-1), c: reporting(NaN), keep: 1 }, 'x'),
    );

    expect(line).not.toContain('value-length');
    expect(JSON.parse(line)).toMatchObject({ a: [], b: [], c: [], keep: 1, msg: 'x' });
  });

  it('writes a record that is an array longer than the limit as one [Truncated] field', () => {
    const line = write(new Array<number>(1_000_001).fill(0), 'x');

    expect(line).toMatchObject({ metadata: '[Truncated]', msg: 'x' });
    expect(line).not.toHaveProperty('0');
  });

  it('keeps one field per entry for a record that is an array within the limit, as before', () => {
    const line = write([10, 20], 'x');

    expect(line).toMatchObject({ 0: 10, 1: 20, msg: 'x' });
    expect(line).not.toHaveProperty('metadata');
  });

  it('writes an array subclass as the plain array it holds', () => {
    class Rows extends Array<unknown> {
      toJSON(): string[] {
        return ['replaced'];
      }
    }

    expect(write({ rows: Rows.from([1, { password: 'p' }]) }, 'x')).toMatchObject({
      rows: [1, { password: '[redacted]' }],
    });
  });

  it('writes a sparse array of the largest length as [Truncated] at once', () => {
    const list: unknown[] = [];
    list.length = 2 ** 32 - 1;

    const started = Date.now();
    const line = write({ list, jid: 'j' }, 'x');

    expect(Date.now() - started).toBeLessThan(1000);
    expect(line).toMatchObject({ list: '[Truncated]', jid: 'j', msg: 'x' });
  });

  it('writes what lies beyond the bounded amount of deep data as [Truncated], never raw', () => {
    const line = write({ record: nest(1500, { password: 'value-far' }), jid: 'j' }, 'x');

    expect(JSON.stringify(line)).not.toContain('value-far');
    expect(JSON.stringify(line)).toContain('"[Truncated]"');
    expect(line.jid).toBe('j');
  });

  it.each([
    ['a first-level', 1],
    ['a deep', 7],
  ])('writes %s circular reference as [Circular] and keeps the message', (_name, levels) => {
    const line = write({ record: nest(levels, withCycle()) }, 'socket closed');

    expect(line.msg).toBe('socket closed');
    expect(JSON.stringify(line)).toContain('"self":"[Circular]"');
  });

  it('writes a BigInt as its decimal text', () => {
    expect(write({ total: 10n, nested: { ids: [1n, 2n] } }, 'x')).toMatchObject({
      total: '10',
      nested: { ids: ['1', '2'] },
    });
  });

  it('never calls a toJSON on the record, so it cannot write what the redaction removed', () => {
    const line = write({ entity: { id: 1, toJSON: () => ({ password: 'value-json' }) } }, 'x');

    expect(JSON.stringify(line)).not.toContain('value-json');
    expect(line.entity).toEqual({ id: 1 });
  });

  // A function is not data: it is left out of the record, so nothing it has or returns is written.
  describe('a function in the record', () => {
    class WithStaticToJson {
      static toJSON(): Record<string, string> {
        return { password: 'value-fn' };
      }
    }
    const functions: Array<[string, () => unknown]> = [
      [
        'a function with a toJSON of its own',
        () => Object.assign(() => 1, { toJSON: () => ({ password: 'value-fn' }) }),
      ],
      ['a class with a static toJSON', () => WithStaticToJson],
      ['a function with properties of its own', () => Object.assign(() => 1, { note: 'value-fn', nested: { id: 7 } })],
    ];

    it.each(functions)('leaves out %s found in the record', (_name, make) => {
      const line = write({ id: 1, handler: make(), list: [make()], deep: nest(6, make()) }, 'x');

      expect(JSON.stringify(line)).not.toContain('value-fn');
      expect(line).toMatchObject({ id: 1, msg: 'x', list: [null] });
      expect(line).not.toHaveProperty('handler');
    });

    it.each(functions)('writes the message alone when the record is %s', (_name, make) => {
      const line = write(make(), 'x');

      expect(JSON.stringify(line)).not.toContain('value-fn');
      expect(Object.keys(line).sort()).toEqual(['context', 'level', 'msg', 'ts']);
      expect(line).toMatchObject({ level: 'debug', context: 'baileys-wire', msg: 'x' });
    });
  });

  it.each([
    [
      'a getter that throws',
      {
        get boom(): string {
          throw new Error('getter');
        },
      },
    ],
    [
      'a proxy whose traps throw',
      new Proxy(
        {},
        {
          ownKeys: (): never => {
            throw new Error('ownKeys');
          },
        },
      ),
    ],
  ])('writes the message without the record when it holds %s', (_name, record) => {
    expect(write(record, 'connection update')).toMatchObject({ msg: 'connection update', metadata: '[Unreadable]' });
  });

  it("keeps an error's message and stack when its own props hold a cycle or a BigInt", () => {
    const err = Object.assign(new Error('stream errored'), { attempts: 5n });
    Object.assign(err, { self: err });

    const line = write({ err }, 'x') as { err: Record<string, unknown> };

    expect(line.err).toMatchObject({ name: 'Error', message: 'stream errored', attempts: '5', self: '[Circular]' });
    expect(line.err.stack).toContain('baileys-logger.spec.ts');
  });
});
