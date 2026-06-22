import { WorkerCapabilityClient, buildSandboxContext } from './worker-capability';
import { WorkerToHostMessage } from './protocol';

describe('WorkerCapabilityClient', () => {
  it('posts a cap request and resolves on the matching cap-result', async () => {
    const sent: WorkerToHostMessage[] = [];
    const client = new WorkerCapabilityClient(m => sent.push(m));

    const pending = client.call('messages.sendText', ['s', 'c', 'hi']);
    const req = sent[0] as Extract<WorkerToHostMessage, { kind: 'cap' }>;
    expect(req).toMatchObject({ kind: 'cap', verb: 'messages.sendText', args: ['s', 'c', 'hi'] });

    client.handleResult({ kind: 'cap-result', id: req.id, ok: true, result: { messageId: 'm' } });
    await expect(pending).resolves.toEqual({ messageId: 'm' });
  });

  it('rejects on an error cap-result', async () => {
    const sent: WorkerToHostMessage[] = [];
    const client = new WorkerCapabilityClient(m => sent.push(m));

    const pending = client.call('messages.sendText', []);
    const req = sent[0] as Extract<WorkerToHostMessage, { kind: 'cap' }>;
    client.handleResult({ kind: 'cap-result', id: req.id, ok: false, error: 'permission denied' });

    await expect(pending).rejects.toThrow('permission denied');
  });

  it('correlates concurrent calls by id', async () => {
    const sent: WorkerToHostMessage[] = [];
    const client = new WorkerCapabilityClient(m => sent.push(m));

    const a = client.call('storage.get', ['a']);
    const b = client.call('storage.get', ['b']);
    const [reqA, reqB] = sent as Extract<WorkerToHostMessage, { kind: 'cap' }>[];
    expect(reqA.id).not.toBe(reqB.id);

    client.handleResult({ kind: 'cap-result', id: reqB.id, ok: true, result: 'B' });
    client.handleResult({ kind: 'cap-result', id: reqA.id, ok: true, result: 'A' });
    await expect(a).resolves.toBe('A');
    await expect(b).resolves.toBe('B');
  });
});

describe('buildSandboxContext', () => {
  it('proxies each capability verb to client.call with positional args', async () => {
    const call = jest.fn().mockResolvedValue('ok');
    const ctx = buildSandboxContext({ call } as unknown as WorkerCapabilityClient);

    await ctx.messages.sendText('s', 'c', 'hi');
    expect(call).toHaveBeenCalledWith('messages.sendText', ['s', 'c', 'hi']);

    await ctx.messages.reply('s', 'c', 'q', 'hi');
    expect(call).toHaveBeenCalledWith('messages.reply', ['s', 'c', 'q', 'hi']);

    await ctx.engine.getGroupInfo('s', 'g');
    expect(call).toHaveBeenCalledWith('engine.getGroupInfo', ['s', 'g']);

    await ctx.storage.set('k', { a: 1 });
    expect(call).toHaveBeenCalledWith('storage.set', ['k', { a: 1 }]);
  });
});
