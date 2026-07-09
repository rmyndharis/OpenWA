import { WorkerSearchRegistry } from './worker-search-registry';
import { WorkerToHostMessage } from './protocol';

const collect = () => {
  const sent: WorkerToHostMessage[] = [];
  return { sent, post: (m: WorkerToHostMessage) => sent.push(m) };
};

const okResults = { hits: [], total: 0, tookMs: 2, provider: 'plugin:x' };

describe('WorkerSearchRegistry', () => {
  it('posts search-provider-register on the first register', () => {
    const { sent, post } = collect();
    const reg = new WorkerSearchRegistry(post);

    reg.register(() => Promise.resolve(okResults));

    expect(sent).toContainEqual({ kind: 'search-provider-register' });
  });

  it('does not re-post search-provider-register on a second register (replace handler only)', () => {
    const { sent, post } = collect();
    const reg = new WorkerSearchRegistry(post);
    reg.register(() => Promise.resolve(okResults));
    reg.register(() => Promise.resolve(okResults));

    expect(sent.filter(m => m.kind === 'search-provider-register')).toHaveLength(1);
  });

  it('runs the handler on a search and replies ok:true with the results', async () => {
    const { sent, post } = collect();
    const reg = new WorkerSearchRegistry(post);
    reg.register(() => Promise.resolve(okResults));

    await reg.handleSearch({ kind: 'search', id: 7, query: { q: 'hello' } });

    expect(sent).toContainEqual({ kind: 'search-result', id: 7, ok: true, results: okResults });
  });

  it('threads the query into the handler', async () => {
    const { sent, post } = collect();
    const reg = new WorkerSearchRegistry(post);
    reg.register(q => Promise.resolve({ hits: [], total: 0, tookMs: 1, provider: String(q.q) }));

    await reg.handleSearch({ kind: 'search', id: 1, query: { q: 'term' } });

    expect(sent.find(m => m.kind === 'search-result')).toMatchObject({ ok: true, results: { provider: 'term' } });
  });

  it('replies ok:false with the error message when the handler throws', async () => {
    const { sent, post } = collect();
    const reg = new WorkerSearchRegistry(post);
    reg.register(() => Promise.reject(new Error('backend down')));

    await reg.handleSearch({ kind: 'search', id: 3, query: { q: 'x' } });

    expect(sent.find(m => m.kind === 'search-result')).toMatchObject({ id: 3, ok: false, error: 'backend down' });
  });

  it('replies ok:false when no handler is registered', async () => {
    const { sent, post } = collect();
    const reg = new WorkerSearchRegistry(post);

    await reg.handleSearch({ kind: 'search', id: 1, query: { q: 'x' } });

    expect(sent.find(m => m.kind === 'search-result')).toMatchObject({ id: 1, ok: false });
  });
});
