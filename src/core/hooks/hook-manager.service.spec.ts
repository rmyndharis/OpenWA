import { HookManager } from './hook-manager.service';
import { PluginCircuitBreaker } from './plugin-circuit-breaker.service';
import { HookContext } from './hook.interfaces';

describe('HookManager execute with isolation', () => {
  let manager: HookManager;
  let breaker: PluginCircuitBreaker;

  beforeEach(() => {
    breaker = new PluginCircuitBreaker();
    breaker.configure(2);
    manager = new HookManager(breaker);
    manager.configure(50); // hook timeout 50ms
  });

  it('still runs the mutate/halt pipeline normally', async () => {
    manager.register('p1', 'message:sending', async (ctx: HookContext<{ body: string }>) => {
      return { continue: true, data: { body: ctx.data.body + '!' } };
    });
    const out = await manager.execute('message:sending', { body: 'hi' }, { source: 'test' });
    expect(out.continue).toBe(true);
    expect(out.data.body).toBe('hi!');
  });

  it('halts the chain when a handler returns continue:false', async () => {
    manager.register('p1', 'message:sending', async () => ({ continue: false }));
    manager.register('p2', 'message:sending', async ctx => ({ continue: true, data: ctx.data }));
    const out = await manager.execute('message:sending', { body: 'x' }, { source: 'test' });
    expect(out.continue).toBe(false);
  });

  it('counts a hanging handler as a failure and trips after threshold', async () => {
    manager.register('slow', 'message:received', () => new Promise(() => {}));
    await manager.execute('message:received', {}, { source: 'test' });
    expect(breaker.isTripped('slow')).toBe(false);
    await manager.execute('message:received', {}, { source: 'test' });
    expect(breaker.isTripped('slow')).toBe(true);
  });

  it('skips handlers of a tripped plugin and removes its hooks on trip', async () => {
    let calls = 0;
    manager.register('bad', 'message:received', async () => {
      calls += 1;
      throw new Error('boom');
    });
    await manager.execute('message:received', {}, { source: 'test' });
    await manager.execute('message:received', {}, { source: 'test' });
    const callsAtTrip = calls;
    await manager.execute('message:received', {}, { source: 'test' });
    expect(calls).toBe(callsAtTrip);
    expect(manager.getHookCount('message:received')).toBe(0);
  });

  it('records success and keeps the counter from tripping on intermittent failures', async () => {
    let n = 0;
    manager.register('flaky', 'message:received', async ctx => {
      n += 1;
      if (n === 1) throw new Error('once');
      return { continue: true, data: ctx.data };
    });
    await manager.execute('message:received', {}, { source: 'test' });
    await manager.execute('message:received', {}, { source: 'test' });
    await manager.execute('message:received', {}, { source: 'test' });
    expect(breaker.isTripped('flaky')).toBe(false);
  });

  it('treats a handler that returns HookResult.error as a failure and trips after threshold', async () => {
    manager.register('errplugin', 'message:received', async () => {
      return { continue: true, error: new Error('signalled') };
    });
    await manager.execute('message:received', {}, { source: 'test' });
    expect(breaker.isTripped('errplugin')).toBe(false); // 1 failure, threshold 2
    await manager.execute('message:received', {}, { source: 'test' });
    expect(breaker.isTripped('errplugin')).toBe(true); // 2nd failure trips
  });
});
