// Hook handlers must satisfy the async HookHandler signature; the test stubs return synchronously,
// so the no-await rule doesn't apply to them here.
/* eslint-disable @typescript-eslint/require-await */
import { HookManager } from './hook-manager.service';
import { HookContext, HookResult, HookEvent } from './hook.interfaces';

describe('HookManager', () => {
  let hm: HookManager;

  beforeEach(() => {
    hm = new HookManager();
  });

  it('returns {continue:true, data} unchanged when no handlers are registered', async () => {
    const res = await hm.execute('message:received', { a: 1 }, { source: 'test' });
    expect(res).toEqual({ continue: true, data: { a: 1 } });
  });

  it('runs handlers in ascending priority order and propagates the mutated data', async () => {
    hm.register(
      'p',
      'message:received',
      async ctx => ({ continue: true, data: [...(ctx.data as string[]), 'late'] }),
      20,
    );
    hm.register(
      'p',
      'message:received',
      async ctx => ({ continue: true, data: [...(ctx.data as string[]), 'early'] }),
      10,
    );

    const res = await hm.execute<string[]>('message:received', [], { source: 'test' });
    expect(res.data).toEqual(['early', 'late']); // priority 10 runs before 20
  });

  it('stops the chain when a handler returns continue:false', async () => {
    const second = jest.fn();
    hm.register('p', 'message:received', async () => ({ continue: false, data: 'stopped' }), 10);
    hm.register(
      'p',
      'message:received',
      async ctx => {
        second();
        return { continue: true, data: ctx.data };
      },
      20,
    );

    const res = await hm.execute('message:received', 'start', { source: 'test' });
    expect(res).toEqual({ continue: false, data: 'stopped' });
    expect(second).not.toHaveBeenCalled();
  });

  it('isolates a throwing handler — later handlers still run', async () => {
    const later = jest.fn();
    hm.register(
      'p',
      'message:received',
      async () => {
        throw new Error('boom');
      },
      10,
    );
    hm.register(
      'p',
      'message:received',
      async ctx => {
        later();
        return { continue: true, data: ctx.data };
      },
      20,
    );

    const res = await hm.execute('message:received', 'd', { source: 'test' });
    expect(later).toHaveBeenCalledTimes(1);
    expect(res.continue).toBe(true);
  });

  it('isolates a handler that returns result.error — the chain continues', async () => {
    const later = jest.fn();
    hm.register('p', 'message:received', async ctx => ({ continue: true, data: ctx.data, error: new Error('x') }), 10);
    hm.register(
      'p',
      'message:received',
      async ctx => {
        later();
        return { continue: true, data: ctx.data };
      },
      20,
    );

    const res = await hm.execute('message:received', 'd', { source: 'test' });
    expect(later).toHaveBeenCalledTimes(1);
    expect(res.continue).toBe(true);
  });

  it('discards the mutated data of a handler that also returns an error (error means discard output)', async () => {
    // A handler that signals an error must NOT have its (possibly partial/corrupted) mutation applied —
    // otherwise a half-transformed payload reaches persistence/webhooks/WS presented as success.
    hm.register(
      'bad',
      'message:received',
      async () => ({ continue: true, data: 'CORRUPTED', error: new Error('partial failure') }),
      10,
    );

    const res = await hm.execute('message:received', 'original', { source: 'test' });

    expect(res.continue).toBe(true);
    expect(res.data).toBe('original'); // the errored handler's mutation is dropped
  });

  it('discards an errored handler mutation even on the stop path (continue:false + error)', async () => {
    hm.register(
      'bad',
      'message:received',
      async () => ({ continue: false, data: 'CORRUPTED', error: new Error('x') }),
      10,
    );

    const res = await hm.execute('message:received', 'original', { source: 'test' });

    expect(res.continue).toBe(false); // the chain still stops
    expect(res.data).toBe('original'); // but the errored mutation is not carried out on stop
  });

  it('register/unregister/hasHooks/getHookCount track registrations', () => {
    expect(hm.hasHooks('session:created')).toBe(false);
    const id = hm.register('p', 'session:created', async ctx => ({ continue: true, data: ctx.data }));
    expect(hm.hasHooks('session:created')).toBe(true);
    expect(hm.getHookCount('session:created')).toBe(1);

    hm.unregister(id);
    expect(hm.getHookCount('session:created')).toBe(0);
    expect(hm.hasHooks('session:created')).toBe(false);
  });

  it("unregisterPlugin removes only that plugin's hooks", () => {
    hm.register('A', 'session:ready', async ctx => ({ continue: true, data: ctx.data }));
    hm.register('A', 'session:ready', async ctx => ({ continue: true, data: ctx.data }));
    hm.register('B', 'session:ready', async ctx => ({ continue: true, data: ctx.data }));

    hm.unregisterPlugin('A');
    expect(hm.getHookCount('session:ready')).toBe(1); // only B remains
  });
});

describe('HookManager re-entrancy guard', () => {
  let manager: HookManager;

  beforeEach(() => {
    manager = new HookManager();
  });

  it('short-circuits a handler that re-fires the same event (no infinite recursion)', async () => {
    let calls = 0;
    manager.register('p1', 'message:sending', async (ctx: HookContext): Promise<HookResult> => {
      calls += 1;
      const inner = await manager.execute('message:sending', ctx.data, { source: 'test' });
      expect(inner).toEqual({ continue: true, data: ctx.data });
      return { continue: true };
    });

    const result = await manager.execute('message:sending', { n: 1 }, { source: 'test' });

    expect(calls).toBe(1);
    expect(result.continue).toBe(true);
  });

  it('does NOT block a handler that fires a DIFFERENT event', async () => {
    const seen: string[] = [];
    manager.register('p1', 'message:received', async (ctx: HookContext): Promise<HookResult> => {
      seen.push('received');
      await manager.execute('message:sent', ctx.data, { source: 'test' });
      return { continue: true };
    });
    manager.register('p2', 'message:sent', async (): Promise<HookResult> => {
      seen.push('sent');
      return { continue: true };
    });

    await manager.execute('message:received', { n: 1 }, { source: 'test' });

    expect(seen).toEqual(['received', 'sent']);
  });
});

describe('HookManager.isInFlight + selective re-entrancy guard (conversation.send pattern)', () => {
  const SENDING: HookEvent[] = ['message:sending'];

  it('isInFlight is false at the top level and true only inside a matching in-flight context', () => {
    const hm = new HookManager();
    expect(hm.isInFlight('message:sending')).toBe(false);
    let matching = false;
    let unrelated = false;
    hm.runInFlight(SENDING, () => {
      matching = hm.isInFlight('message:sending');
      unrelated = hm.isInFlight('message:received');
    });
    expect(matching).toBe(true);
    expect(unrelated).toBe(false);
  });

  it('a top-level guarded send still fires message:sending for unrelated observers; genuine re-entrancy suppresses it', async () => {
    const hm = new HookManager();
    let observerCalls = 0;
    hm.register('audit', 'message:sending', async ctx => {
      observerCalls++;
      return { continue: true, data: ctx.data };
    });
    // Mirrors the plugin-loader binding for ctx.conversations.send: guard ONLY on an already-in-flight event.
    const runGuarded = <T>(events: HookEvent[], run: () => Promise<T>): Promise<T> =>
      events.some(e => hm.isInFlight(e)) ? hm.runInFlight(events, run) : run();

    // Top-level send: an unrelated audit/moderation observer MUST see the outbound message:sending.
    await runGuarded(SENDING, () => hm.execute('message:sending', {}, { source: 'send' }));
    expect(observerCalls).toBe(1);

    // A send issued from WITHIN a message:sending handler's context (echo-loop) MUST be suppressed.
    observerCalls = 0;
    await hm.runInFlight(SENDING, () =>
      runGuarded(SENDING, () => hm.execute('message:sending', {}, { source: 'reentrant-send' })),
    );
    expect(observerCalls).toBe(0);
  });
});
