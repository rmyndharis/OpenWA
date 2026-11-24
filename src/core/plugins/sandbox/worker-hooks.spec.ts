import { WorkerHookHandler, WorkerHookRegistry } from './worker-hooks';
import { WorkerCapabilityClient } from './worker-capability';
import { WorkerToHostMessage } from './protocol';

const collect = () => {
  const sent: WorkerToHostMessage[] = [];
  return { sent, post: (m: WorkerToHostMessage) => sent.push(m) };
};
const num = (data: unknown): number => (data as { n: number }).n;

describe('WorkerHookRegistry', () => {
  it('posts hook-subscribe on the first registration for an event', () => {
    const { sent, post } = collect();
    const reg = new WorkerHookRegistry(post);

    reg.register('message:received', () => Promise.resolve({ continue: true }), 50);

    expect(sent).toContainEqual({ kind: 'hook-subscribe', event: 'message:received', priority: 50 });
  });

  it('does not re-subscribe for a second handler on the same event', () => {
    const { sent, post } = collect();
    const reg = new WorkerHookRegistry(post);

    reg.register('message:received', () => Promise.resolve({ continue: true }));
    reg.register('message:received', () => Promise.resolve({ continue: true }));

    expect(sent.filter(m => m.kind === 'hook-subscribe')).toHaveLength(1);
  });

  it('re-subscribes when a later handler lowers the event priority, and only then', () => {
    const { sent, post } = collect();
    const reg = new WorkerHookRegistry(post);

    reg.register('message:sending', () => Promise.resolve({ continue: true }), 200);
    reg.register('message:sending', () => Promise.resolve({ continue: true }), 1);
    reg.register('message:sending', () => Promise.resolve({ continue: true }), 300);

    expect(sent.filter(m => m.kind === 'hook-subscribe')).toEqual([
      { kind: 'hook-subscribe', event: 'message:sending', priority: 200 },
      { kind: 'hook-subscribe', event: 'message:sending', priority: 1 },
    ]);
  });

  it('compares a later priority against the default when the first one is not a finite number', () => {
    const { sent, post } = collect();
    const reg = new WorkerHookRegistry(post);

    reg.register('message:sending', () => Promise.resolve({ continue: true }), 'abc');
    reg.register('message:sending', () => Promise.resolve({ continue: true }), 1);

    expect(sent.filter(m => m.kind === 'hook-subscribe')).toEqual([
      { kind: 'hook-subscribe', event: 'message:sending', priority: 100 },
      { kind: 'hook-subscribe', event: 'message:sending', priority: 1 },
    ]);
  });

  it('runs the handler on a hook and replies with continue + modified data', async () => {
    const { sent, post } = collect();
    const reg = new WorkerHookRegistry(post);
    reg.register('message:received', ctx =>
      Promise.resolve({ continue: false, data: { ...(ctx.data as object), tagged: true } }),
    );

    await reg.handleHook({ kind: 'hook', id: 3, event: 'message:received', data: { body: 'hi' }, source: 'Engine' });

    expect(sent).toContainEqual({ kind: 'hook-result', id: 3, continue: false, data: { body: 'hi', tagged: true } });
  });

  it('threads data through handlers in priority order and stops on continue:false', async () => {
    const { sent, post } = collect();
    const reg = new WorkerHookRegistry(post);
    reg.register('e', () => Promise.resolve({ continue: true, data: { n: 1 } }), 10);
    reg.register('e', ctx => Promise.resolve({ continue: false, data: { n: num(ctx.data) + 1 } }), 20);
    reg.register('e', () => Promise.resolve({ continue: true, data: { n: 99 } }), 30); // must not run

    await reg.handleHook({ kind: 'hook', id: 1, event: 'e', data: {}, source: 's' });

    expect(sent.find(m => m.kind === 'hook-result')).toMatchObject({ continue: false, data: { n: 2 } });
  });

  it('skips a later handler result the event cannot use, keeping an earlier rewrite', async () => {
    const { sent, post } = collect();
    const reg = new WorkerHookRegistry(post);
    reg.register(
      'message:received',
      ctx => Promise.resolve({ continue: true, data: { ...(ctx.data as object), body: '[redacted]' } }),
      10,
    );
    reg.register('message:received', () => Promise.resolve({ continue: true, data: null }), 100);

    const message = { id: 'm1', chatId: 'c@c.us', body: 'secret' };
    await reg.handleHook({ kind: 'hook', id: 5, event: 'message:received', data: message, source: 'Engine' });

    expect(sent.find(m => m.kind === 'hook-result')).toMatchObject({ data: { ...message, body: '[redacted]' } });
  });

  it('a throwing handler does not break the chain', async () => {
    const { sent, post } = collect();
    const reg = new WorkerHookRegistry(post);
    reg.register('e', () => Promise.reject(new Error('boom')));

    await reg.handleHook({ kind: 'hook', id: 1, event: 'e', data: { x: 1 }, source: 's' });

    expect(sent.find(m => m.kind === 'hook-result')).toMatchObject({ continue: true });
  });

  it('discards data a handler returns with an error and reports the first failure', async () => {
    const { sent, post } = collect();
    const reg = new WorkerHookRegistry(post);
    const message = { id: 'm1', chatId: 'c@c.us', body: 'secret' };
    let seen: unknown;
    reg.register('message:received', () => ({ continue: true, data: { ...message, body: '[redacted]' } }), 10);
    reg.register('message:received', () => ({ continue: true, data: message, error: new Error('first failure') }), 20);
    reg.register('message:received', () => Promise.reject(new Error('second failure')), 30);
    reg.register(
      'message:received',
      ({ data }) => {
        seen = data;
        return { continue: true };
      },
      40,
    );

    await reg.handleHook({ kind: 'hook', id: 1, event: 'message:received', data: message, source: 'Engine' });

    expect(seen).toEqual({ ...message, body: '[redacted]' });
    expect(sent.find(m => m.kind === 'hook-result')).toMatchObject({
      continue: true,
      data: { ...message, body: '[redacted]' },
      error: 'first failure',
    });
  });

  it('keeps a veto that comes with an error, discards its data, and still reports the error', async () => {
    const { sent, post } = collect();
    const reg = new WorkerHookRegistry(post);
    const message = { id: 'm1', chatId: 'c@c.us', body: 'secret' };
    let laterRan = false;
    reg.register('message:received', () => ({ continue: true, data: { ...message, body: '[redacted]' } }), 10);
    reg.register('message:received', () => ({ continue: false, data: message, error: new Error('failed') }), 20);
    reg.register('message:received', () => {
      laterRan = true;
      return { continue: true };
    });

    await reg.handleHook({ kind: 'hook', id: 1, event: 'message:received', data: message, source: 'Engine' });

    expect(laterRan).toBe(false);
    expect(sent.find(m => m.kind === 'hook-result')).toEqual({
      kind: 'hook-result',
      id: 1,
      continue: false,
      data: { ...message, body: '[redacted]' },
      error: 'failed',
    });
  });

  it('reports a throwing handler to the host on the hook-result (later handlers still run)', async () => {
    const { sent, post } = collect();
    const reg = new WorkerHookRegistry(post);
    reg.register('e', () => Promise.reject(new Error('boom')), 10);
    reg.register('e', () => Promise.resolve({ continue: true, data: { n: 2 } }), 20);

    await reg.handleHook({ kind: 'hook', id: 1, event: 'e', data: { x: 1 }, source: 's' });

    // The error rides the result so the host can surface it; the chain's fail-open shape is unchanged.
    expect(sent.find(m => m.kind === 'hook-result')).toMatchObject({ continue: true, data: { n: 2 }, error: 'boom' });
  });

  it('reports an uncloneable handler result as an error instead of rejecting the dispatch', async () => {
    // parentPort.postMessage structured-clones the result; a rejection here would be unhandled in the
    // worker (the bootstrap calls handleHook with void) and kill it.
    const sent: WorkerToHostMessage[] = [];
    const post = (m: WorkerToHostMessage): void => {
      sent.push(structuredClone(m));
    };
    const reg = new WorkerHookRegistry(post);
    reg.register('e', ({ data }) => Promise.resolve({ continue: true, data: { ...(data as object), fn: () => 1 } }));

    await expect(
      reg.handleHook({ kind: 'hook', id: 1, event: 'e', data: { x: 1 }, source: 's' }),
    ).resolves.toBeUndefined();

    const result = sent.find(m => m.kind === 'hook-result') as Extract<WorkerToHostMessage, { kind: 'hook-result' }>;
    expect(result).toMatchObject({ id: 1, continue: true });
    expect(result.error).toContain('could not be sent');
    expect(result).not.toHaveProperty('data'); // the host keeps the original data
  });

  it('reports only the FIRST handler error and stringifies non-Error throws', async () => {
    const { sent, post } = collect();
    const reg = new WorkerHookRegistry(post);
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a non-Error rejection is exactly the case under test (it must be stringified, not crash the wire)
    reg.register('e', () => Promise.reject('string failure'), 10);
    reg.register('e', () => Promise.reject(new Error('second')), 20);

    await reg.handleHook({ kind: 'hook', id: 1, event: 'e', data: {}, source: 's' });

    expect(sent.find(m => m.kind === 'hook-result')).toMatchObject({ continue: true, error: 'string failure' });
  });

  it.each([
    ['empty string', ''],
    ['zero', 0],
    ['null', null],
  ])('records falsy result.error (%s) as a non-empty error string and discards its data', async (_label, errVal) => {
    const { sent, post } = collect();
    const reg = new WorkerHookRegistry(post);
    reg.register('message:sending', () => ({
      continue: true,
      data: { poisoned: true },
      error: errVal as unknown as Error,
    }));

    await reg.handleHook({
      kind: 'hook',
      id: 1,
      event: 'message:sending',
      data: { orig: true },
      source: 'MessageService',
    });

    const res = sent.find(m => m.kind === 'hook-result') as Extract<WorkerToHostMessage, { kind: 'hook-result' }>;
    expect(res.data).toEqual({ orig: true });
    expect(typeof res.error).toBe('string');
    expect(res.error!.length).toBeGreaterThan(0);
  });

  it.each([
    ['empty Error', () => new Error()],
    ['empty string', () => ''],
    ['AggregateError with empty message', () => new AggregateError([new Error('ECONNREFUSED')], '')],
    [
      'AggregateError with null-prototype name',
      () => {
        const err = new AggregateError([new Error('ECONNREFUSED')], '');
        Object.defineProperty(err, 'name', { value: Object.create(null) });
        return err;
      },
    ],
    [
      'AggregateError with Symbol name',
      () => {
        const err = new AggregateError([new Error('ECONNREFUSED')], '');
        Object.defineProperty(err, 'name', { value: Symbol('bad-name') });
        return err;
      },
    ],
    [
      'AggregateError with throwing name getter',
      () => {
        const err = new AggregateError([new Error('ECONNREFUSED')], '');
        Object.defineProperty(err, 'name', {
          get() {
            throw new Error('name getter exploded');
          },
        });
        return err;
      },
    ],
    [
      'AggregateError with throwing errors getter',
      () => {
        const err = new AggregateError([], '');
        Object.defineProperty(err, 'errors', {
          get() {
            throw new Error('errors getter exploded');
          },
        });
        return err;
      },
    ],
    ['null-prototype object', () => Object.create(null) as unknown],
    [
      'object with throwing toString',
      () => ({
        toString() {
          throw new Error('poison');
        },
      }),
    ],
  ])(
    'safely formats pathological thrown value (%s) as a non-empty error without rejecting in fail-open and fail-closed modes',
    async (_label, makeErr) => {
      for (const failClosed of [false, true]) {
        const { sent, post } = collect();
        const reg = new WorkerHookRegistry(post);
        // eslint-disable-next-line @typescript-eslint/require-await -- async throw exercises promise rejection with non-Error reasons
        reg.register('message:sending', async () => {
          throw makeErr();
        });

        await expect(
          reg.handleHook({
            kind: 'hook',
            id: 1,
            event: 'message:sending',
            data: { orig: true },
            source: 'MessageService',
            failClosed,
          }),
        ).resolves.toBeUndefined();

        const res = sent.find(m => m.kind === 'hook-result') as Extract<WorkerToHostMessage, { kind: 'hook-result' }>;
        expect(typeof res.error).toBe('string');
        expect(res.error!.trim().length).toBeGreaterThan(0);
      }
    },
  );

  it.each([
    ['corrupted payload string', { payload: 'corrupted' }],
    ['array payload', { payload: [] }],
    ['Date payload', { payload: new Date('2026-01-01T00:00:00Z') }],
    ['Map payload', { payload: new Map() }],
    ['Set payload', { payload: new Set() }],
    ['RegExp payload', { payload: /re/ }],
    ['inherited prototype payload', Object.create({ payload: { ok: true } }) as unknown],
    ['empty object without payload', {}],
    ['null result data', null],
    ['null payload field', { payload: null }],
  ])('fails closed on unusable webhook:before data (%s) and short-circuits later handlers', async (_label, badData) => {
    const { sent, post } = collect();
    const reg = new WorkerHookRegistry(post);
    const later = jest.fn();
    reg.register('webhook:before', () => ({ continue: true, data: badData }), 10);
    reg.register(
      'webhook:before',
      () => {
        later();
        return { continue: true };
      },
      20,
    );

    await reg.handleHook({
      kind: 'hook',
      id: 7,
      event: 'webhook:before',
      data: { sessionId: 's1', event: 'message.received', payload: { data: { ok: true } } },
      source: 'WebhookService',
      failClosed: true,
    });

    expect(later).not.toHaveBeenCalled();
    const res = sent.find(m => m.kind === 'hook-result') as Extract<WorkerToHostMessage, { kind: 'hook-result' }>;
    expect(res.error).toBe('hook handler returned an unusable payload');
  });

  it('short-circuits remaining worker handlers on throw or result.error when failClosed is true', async () => {
    const { sent, post } = collect();
    const reg = new WorkerHookRegistry(post);
    const later = jest.fn();
    reg.register('message:sending', () => Promise.reject(new Error('first failed')), 10);
    reg.register(
      'message:sending',
      () => {
        later();
        return { continue: true, data: { rewritten: true } };
      },
      20,
    );

    await reg.handleHook({
      kind: 'hook',
      id: 9,
      event: 'message:sending',
      data: { input: { text: 'hi' } },
      source: 'MessageService',
      failClosed: true,
    });

    expect(later).not.toHaveBeenCalled();
    expect(sent.find(m => m.kind === 'hook-result')).toMatchObject({
      continue: true,
      error: 'first failed',
    });
  });

  it.each<[string, unknown]>([
    ['string continue', { continue: 'false' }],
    ['numeric continue', { continue: 1 }],
    ['empty object missing continue', {}],
    ['string primitive', 'ok'],
    ['numeric primitive', 42],
    ['null', null],
    ['array', []],
  ])(
    'fails closed on malformed handler result (%s) without allowing egress or silently cancelling',
    async (_label, badResult) => {
      const { sent, post } = collect();
      const reg = new WorkerHookRegistry(post);
      const later = jest.fn();
      reg.register('webhook:before', (() => badResult) as unknown as WorkerHookHandler, 10);
      reg.register(
        'webhook:before',
        () => {
          later();
          return { continue: true };
        },
        20,
      );

      await reg.handleHook({
        kind: 'hook',
        id: 11,
        event: 'webhook:before',
        data: { sessionId: 's1', event: 'message.received', payload: { data: { ok: true } } },
        source: 'WebhookService',
        failClosed: true,
      });

      expect(later).not.toHaveBeenCalled();
      expect(sent.find(m => m.kind === 'hook-result')).toMatchObject({
        continue: true,
        error: 'hook handler returned an invalid result: continue must be a boolean',
      });
    },
  );

  it('clears dispatchId before posting hook-result and retains netScopeId only for floated net.fetch', async () => {
    const { sent, post } = collect();
    const reg = new WorkerHookRegistry(post);
    const client = new WorkerCapabilityClient(post);
    let floatedStorage!: Promise<unknown>;
    let floatedFetch!: Promise<unknown>;

    reg.register('message:received', () => {
      floatedStorage = Promise.resolve().then(() => client.call('storage.get', ['k1']));
      floatedFetch = floatedStorage.then(() => client.call('net.fetch', ['https://s1.example/ok']));
      return { continue: true };
    });

    await reg.handleHook({
      kind: 'hook',
      id: 21,
      dispatchId: 'disp-21',
      netScopeId: 'net-21',
      event: 'message:received',
      data: {},
      source: 'Engine',
    });
    await Promise.resolve();
    await Promise.resolve();
    const storageReq = sent.find(m => m.kind === 'cap' && m.verb === 'storage.get') as Extract<
      WorkerToHostMessage,
      { kind: 'cap' }
    >;
    expect(storageReq).toBeDefined();
    expect(storageReq.dispatchId).toBeUndefined();
    expect(storageReq.netScopeId).toBeUndefined();

    client.handleResult({ kind: 'cap-result', id: storageReq.id, ok: true, result: null });
    await Promise.resolve();
    await Promise.resolve();
    const fetchReq = sent.find(m => m.kind === 'cap' && m.verb === 'net.fetch') as Extract<
      WorkerToHostMessage,
      { kind: 'cap' }
    >;
    expect(fetchReq).toBeDefined();
    expect(fetchReq.dispatchId).toBeUndefined();
    expect(fetchReq.netScopeId).toBe('net-21');
    client.handleResult({ kind: 'cap-result', id: fetchReq.id, ok: true, result: null });
    await floatedFetch;
    const hookResIdx = sent.findIndex(m => m.kind === 'hook-result');
    const storageIdx = sent.findIndex(m => m.kind === 'cap' && m.verb === 'storage.get');
    expect(hookResIdx).toBeGreaterThanOrEqual(0);
    expect(hookResIdx).toBeLessThan(storageIdx);
  });
});
