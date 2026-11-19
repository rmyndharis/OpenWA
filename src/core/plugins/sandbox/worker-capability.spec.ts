import { WorkerCapabilityClient, buildSandboxContext } from './worker-capability';
import {
  SANDBOX_MAX_HELD_CAPS,
  SANDBOX_MAX_INFLIGHT_CAPS,
  SANDBOX_MAX_PENDING_CAPS,
  WorkerToHostMessage,
} from './protocol';
import { WorkerHookRegistry, hookConfigStore } from './worker-hooks';

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

  it('rejects without keeping a pending entry when the call cannot be posted', async () => {
    // postMessage throws DataCloneError synchronously for an uncloneable arg (a Promise, a function).
    const client = new WorkerCapabilityClient(() => {
      throw new Error('could not be cloned');
    });

    await expect(client.call('messages.sendText', ['s', 'c', Promise.resolve('x')])).rejects.toThrow(
      'could not be cloned',
    );
    expect((client as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0);
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

  describe('a loop that does not await its calls', () => {
    type CapMessage = Extract<WorkerToHostMessage, { kind: 'cap' }>;
    const capsOf = (sent: WorkerToHostMessage[]): CapMessage[] =>
      sent.filter((message): message is CapMessage => message.kind === 'cap');
    const answer = (client: WorkerCapabilityClient, message: WorkerToHostMessage, result: unknown): void =>
      client.handleResult({ kind: 'cap-result', id: (message as CapMessage).id, ok: true, result });
    const pendingOf = (client: WorkerCapabilityClient): number =>
      (client as unknown as { pending: Map<number, unknown> }).pending.size;
    const heldOf = (client: WorkerCapabilityClient): number => (client as unknown as { held: unknown[] }).held.length;
    // A call whose rejection is also read where a case looks at it; marking it handled keeps a refusal that a case did
    // not expect a failed assertion instead of an unhandled rejection.
    const issue = (client: WorkerCapabilityClient, verb: string, args: unknown[]): Promise<unknown> => {
      const call = client.call(verb, args);
      call.catch(() => undefined);
      return call;
    };

    it('keeps the worker bound above the bound the host enforces, so the host still runs as many calls as it allows', () => {
      expect(SANDBOX_MAX_PENDING_CAPS).toBeGreaterThan(SANDBOX_MAX_INFLIGHT_CAPS);
    });

    it('holds back the call past the bound, and posts it in call order as replies free slots', async () => {
      const sent: WorkerToHostMessage[] = [];
      const client = new WorkerCapabilityClient(m => sent.push(m));

      const total = SANDBOX_MAX_PENDING_CAPS + 5;
      const calls = Array.from({ length: total }, (_, i) => issue(client, 'storage.get', [`k${i}`]));
      expect(sent).toHaveLength(SANDBOX_MAX_PENDING_CAPS);
      expect(heldOf(client)).toBe(5);

      // One answer frees one slot, and the call that has waited longest takes it.
      answer(client, sent[0], 'v0');
      await expect(calls[0]).resolves.toBe('v0');
      expect(sent).toHaveLength(SANDBOX_MAX_PENDING_CAPS + 1);
      expect(sent[SANDBOX_MAX_PENDING_CAPS]).toMatchObject({ kind: 'cap', args: [`k${SANDBOX_MAX_PENDING_CAPS}`] });

      // An error answer frees a slot as well. Each answer settles its own call, held ones included.
      for (let i = 1; i < sent.length; i++) {
        const { id, args } = sent[i] as CapMessage;
        if (i % 2 === 0) client.handleResult({ kind: 'cap-result', id, ok: false, error: `no ${String(args[0])}` });
        else answer(client, sent[i], `v${String(args[0])}`);
      }
      expect(capsOf(sent).map(message => message.args[0])).toEqual(Array.from({ length: total }, (_, i) => `k${i}`));
      await expect(
        Promise.all(
          calls.map(call =>
            call.then(
              value => value,
              (error: Error) => error.message,
            ),
          ),
        ),
      ).resolves.toEqual(
        Array.from({ length: total }, (_, i) => (i === 0 ? 'v0' : i % 2 === 0 ? `no k${i}` : `vk${i}`)),
      );
      expect(pendingOf(client)).toBe(0);
      expect(heldOf(client)).toBe(0);
    });

    it('refuses the call past the held bound once, without posting it, and still releases every call before it', async () => {
      const sent: WorkerToHostMessage[] = [];
      const client = new WorkerCapabilityClient(m => sent.push(m));

      const accepted = SANDBOX_MAX_PENDING_CAPS + SANDBOX_MAX_HELD_CAPS;
      const calls = Array.from({ length: accepted }, (_, i) => issue(client, 'storage.get', [i]));
      const refused = issue(client, 'storage.get', ['one too many']);
      await expect(refused).rejects.toThrow(`too many held capability calls (limit ${SANDBOX_MAX_HELD_CAPS})`);
      expect(sent).toHaveLength(SANDBOX_MAX_PENDING_CAPS);

      for (let i = 0; i < sent.length; i++) answer(client, sent[i], i);
      expect(sent).toHaveLength(accepted);
      expect(capsOf(sent).some(message => message.args[0] === 'one too many')).toBe(false);
      await expect(Promise.all(calls)).resolves.toEqual(Array.from({ length: accepted }, (_, i) => i));
      expect(pendingOf(client)).toBe(0);
      expect(heldOf(client)).toBe(0);
    });

    it('rejects a refused call instead of throwing, so a plugin that chains a catch handles it', async () => {
      const client = new WorkerCapabilityClient(() => undefined);
      for (let i = 0; i < SANDBOX_MAX_PENDING_CAPS + SANDBOX_MAX_HELD_CAPS; i++) {
        void issue(client, 'storage.get', [i]);
      }

      let refused: Promise<unknown> | undefined;
      expect(() => (refused = issue(client, 'storage.get', ['x']))).not.toThrow();
      await expect(refused).rejects.toBeInstanceOf(Error);
    });

    it('does not hold calls that are answered as they go', async () => {
      const sent: WorkerToHostMessage[] = [];
      const client = new WorkerCapabilityClient(m => sent.push(m));

      for (let i = 0; i < SANDBOX_MAX_PENDING_CAPS * 8; i++) {
        const call = issue(client, 'storage.get', ['k']);
        expect(sent).toHaveLength(i + 1); // posted at once, never held
        answer(client, sent[i], i);
        await expect(call).resolves.toBe(i);
      }
      expect(sent).toHaveLength(SANDBOX_MAX_PENDING_CAPS * 8);
    });

    it('sends a held call the arguments it had when it was made, not as the plugin changed them since', () => {
      const sent: WorkerToHostMessage[] = [];
      const client = new WorkerCapabilityClient(m => sent.push(m));
      for (let i = 0; i < SANDBOX_MAX_PENDING_CAPS; i++) void issue(client, 'storage.get', [i]);

      const value = { n: 1 };
      void issue(client, 'storage.set', ['k', value]);
      value.n = 2;
      answer(client, sent[0], null);

      expect(sent[SANDBOX_MAX_PENDING_CAPS]).toMatchObject({ verb: 'storage.set', args: ['k', { n: 1 }] });
    });

    it('rejects only its own call when a held call has an argument that cannot be cloned', async () => {
      const sent: WorkerToHostMessage[] = [];
      const client = new WorkerCapabilityClient(m => sent.push(m));
      for (let i = 0; i < SANDBOX_MAX_PENDING_CAPS; i++) void issue(client, 'storage.get', [i]);

      const uncloneable = issue(client, 'storage.set', ['k', () => 1]);
      const after = issue(client, 'storage.get', ['after']);
      await expect(uncloneable).rejects.toThrow();
      expect(heldOf(client)).toBe(1);

      answer(client, sent[0], null);
      expect(capsOf(sent).map(message => message.args[0])).toEqual([
        ...Array.from({ length: SANDBOX_MAX_PENDING_CAPS }, (_, i) => i),
        'after',
      ]);
      answer(client, sent[SANDBOX_MAX_PENDING_CAPS], 'v');
      await expect(after).resolves.toBe('v');
      expect(heldOf(client)).toBe(0);
      expect(pendingOf(client)).toBe(SANDBOX_MAX_PENDING_CAPS - 1);
    });

    it('rejects only its own call when a held call cannot be posted, and releases the calls behind it', async () => {
      const sent: WorkerToHostMessage[] = [];
      const client = new WorkerCapabilityClient(m => {
        if ((m as CapMessage).verb === 'unpostable') throw new Error('could not be cloned');
        sent.push(m);
      });
      for (let i = 0; i < SANDBOX_MAX_PENDING_CAPS; i++) void issue(client, 'storage.get', [i]);
      const unpostable = issue(client, 'unpostable', []);
      const after = issue(client, 'storage.get', ['after']);

      answer(client, sent[0], null);

      await expect(unpostable).rejects.toThrow('could not be cloned');
      expect(sent[SANDBOX_MAX_PENDING_CAPS]).toMatchObject({ verb: 'storage.get', args: ['after'] });
      expect(heldOf(client)).toBe(0);
      expect(pendingOf(client)).toBe(SANDBOX_MAX_PENDING_CAPS);
      answer(client, sent[SANDBOX_MAX_PENDING_CAPS], 'v');
      await expect(after).resolves.toBe('v');
    });

    it('posts a held call with the chain of the hook dispatch that made it, whatever releases it', async () => {
      const sent: WorkerToHostMessage[] = [];
      const client = new WorkerCapabilityClient(m => sent.push(m));
      const hooks = new WorkerHookRegistry(m => sent.push(m));
      for (let i = 0; i < SANDBOX_MAX_PENDING_CAPS; i++) void issue(client, 'storage.get', [i]);
      hooks.register('message:sending', () => {
        void issue(client, 'messages.sendText', ['in-hook']);
        return { continue: true };
      });
      const chain = ['message:received', 'message:sending'];
      await hooks.handleHook({ kind: 'hook', id: 1, event: 'message:sending', data: {}, source: 't', inFlight: chain });
      void issue(client, 'messages.sendText', ['outside']); // an ingress handler or a timer

      // The dispatch is over. The replies that free the slots arrive in the context of some other chain.
      hookConfigStore.run({ inFlight: ['unrelated'] }, () => {
        answer(client, sent[0], null);
        answer(client, sent[1], null);
      });

      const released = capsOf(sent).slice(SANDBOX_MAX_PENDING_CAPS);
      expect(released.map(message => [message.args[0], message.inFlight])).toEqual([
        ['in-hook', chain],
        ['outside', undefined],
      ]);
    });
  });

  it('tags a call made inside a hook handler with that dispatch chain, and only that call', async () => {
    const sent: WorkerToHostMessage[] = [];
    const client = new WorkerCapabilityClient(m => sent.push(m));
    const hooks = new WorkerHookRegistry(m => sent.push(m));
    hooks.register('message:sending', () => {
      void client.call('messages.sendText', ['in-hook']);
      return { continue: true };
    });

    void client.call('messages.sendText', ['outside']); // an ingress handler or a timer
    await hooks.handleHook({
      kind: 'hook',
      id: 1,
      event: 'message:sending',
      data: {},
      source: 't',
      inFlight: ['message:received', 'message:sending'],
    });

    const caps = sent.filter((m): m is Extract<WorkerToHostMessage, { kind: 'cap' }> => m.kind === 'cap');
    expect(caps.map(c => [c.args[0], c.inFlight])).toEqual([
      ['outside', undefined],
      ['in-hook', ['message:received', 'message:sending']],
    ]);
  });

  it('does not tag a call a hook handler defers past the end of its dispatch', async () => {
    const sent: WorkerToHostMessage[] = [];
    const client = new WorkerCapabilityClient(m => sent.push(m));
    const hooks = new WorkerHookRegistry(m => sent.push(m));
    let fireLater!: () => void;
    const later = new Promise<void>(resolve => (fireLater = resolve));
    hooks.register('message:sent', () => {
      void later.then(() => client.call('messages.sendText', ['later']));
      return { continue: true };
    });

    await hooks.handleHook({ kind: 'hook', id: 1, event: 'message:sent', data: {}, source: 't' });
    fireLater();
    await later;
    await Promise.resolve();

    const caps = sent.filter((m): m is Extract<WorkerToHostMessage, { kind: 'cap' }> => m.kind === 'cap');
    expect(caps.map(c => [c.args[0], c.inFlight])).toEqual([['later', undefined]]);
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

    await ctx.engine.getChatHistory('s', 'c@c.us', 20, true);
    expect(call).toHaveBeenCalledWith('engine.getChatHistory', ['s', 'c@c.us', 20, true]);

    await ctx.storage.set('k', { a: 1 });
    expect(call).toHaveBeenCalledWith('storage.set', ['k', { a: 1 }]);
  });
});
