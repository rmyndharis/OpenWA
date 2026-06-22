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

  it('a throwing handler does not break the chain', async () => {
    const { sent, post } = collect();
    const reg = new WorkerHookRegistry(post);
    reg.register('e', () => Promise.reject(new Error('boom')));

    await reg.handleHook({ kind: 'hook', id: 1, event: 'e', data: { x: 1 }, source: 's' });

    expect(sent.find(m => m.kind === 'hook-result')).toMatchObject({ continue: true });
  });
});
