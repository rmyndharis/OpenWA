import { WorkerHookRegistry } from './worker-hooks';
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

  it('keeps a veto that comes with an error but does not apply its data', async () => {
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
});
