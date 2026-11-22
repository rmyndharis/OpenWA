// Hook handlers must satisfy the async HookHandler signature; the test stubs return synchronously,
// so the no-await rule doesn't apply to them here.
/* eslint-disable @typescript-eslint/require-await */
import { AsyncLocalStorage } from 'async_hooks';
import { ConfigService } from '@nestjs/config';
import { DataSource, type Repository } from 'typeorm';
import { HookExecutionError, HookManager, PRE_EGRESS_HOOK_EVENTS } from './hook-manager.service';
import { HookContext, HookHandler, HookResult, HookEvent } from './hook.interfaces';
import { EngineRegistry } from '../../engine/engine-registry.service';
import type { IncomingMessage, IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { Message } from '../../modules/message/entities/message.entity';
import { MessageSendService } from '../../modules/message/message-send.service';
import { SendPacingService } from '../../modules/message/send-pacing.service';
import { MessageProjector } from '../../modules/session/message-projector.service';
import type { Session } from '../../modules/session/entities/session.entity';
import type { SessionService } from '../../modules/session/session.service';
import type { TemplateService } from '../../modules/template/template.service';
import type { EventsGateway } from '../../modules/events/events.gateway';
import type { WebhookService } from '../../modules/webhook/webhook.service';
import type { StatusStoreService } from '../../modules/status-store/status-store.service';
import type { SessionLidResolver } from '../../modules/session/session-lid-resolver.service';

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

  it('skips a result the caller cannot use, keeping an earlier handler rewrite', async () => {
    const isMessage = (d: unknown) => typeof d === 'object' && d !== null && 'id' in d;
    hm.register(
      'redact',
      'message:received',
      async ctx => ({
        continue: true,
        data: { ...(ctx.data as object), body: '[redacted]' },
      }),
      10,
    );
    hm.register('bot', 'message:received', async () => ({ continue: true, data: null }), 100);

    const guarded = await hm.execute<unknown>(
      'message:received',
      { id: 'm1', body: 'secret' },
      {
        source: 'test',
        accept: isMessage,
      },
    );
    expect(guarded.data).toEqual({ id: 'm1', body: '[redacted]' });

    // Without `accept` any defined data is adopted, as before.
    const unguarded = await hm.execute<unknown>('message:received', { id: 'm1', body: 'secret' }, { source: 'test' });
    expect(unguarded.data).toBeNull();
  });

  it('isolateData clones currentData per handler so in-place mutations on throw, error, or no-data cannot leak', async () => {
    const initial = { input: { mentions: ['62811@c.us'], meta: { tag: 'orig' } } };
    const seenByObserver: Array<{ mentions: string[]; tag: string }> = [];

    hm.register(
      'throws',
      'message:sending',
      async ctx => {
        const payload = ctx.data as typeof initial;
        payload.input.mentions.push('62991@c.us');
        payload.input.meta.tag = 'from-throw';
        throw new Error('handler crashed');
      },
      10,
    );
    hm.register(
      'returns-error',
      'message:sending',
      async ctx => {
        const payload = ctx.data as typeof initial;
        payload.input.mentions.push('62992@c.us');
        payload.input.meta.tag = 'from-error';
        return { continue: true, data: payload, error: new Error('reported error') };
      },
      20,
    );
    hm.register(
      'no-data',
      'message:sending',
      async ctx => {
        const payload = ctx.data as typeof initial;
        payload.input.mentions.push('62993@c.us');
        payload.input.meta.tag = 'from-no-data';
        return { continue: true };
      },
      30,
    );
    hm.register(
      'observer',
      'message:sending',
      async ctx => {
        const payload = ctx.data as typeof initial;
        seenByObserver.push({ mentions: [...payload.input.mentions], tag: payload.input.meta.tag });
        return { continue: true, data: payload };
      },
      40,
    );

    const res = await hm.execute('message:sending', initial, { source: 'test', isolateData: true });

    expect(initial).toEqual({ input: { mentions: ['62811@c.us'], meta: { tag: 'orig' } } });
    expect(seenByObserver).toEqual([{ mentions: ['62811@c.us'], tag: 'orig' }]);
    expect(res.data).toEqual({ input: { mentions: ['62811@c.us'], meta: { tag: 'orig' } } });
  });

  it('isolateData falls back to recursive deep cloning when data contains a non-structuredCloneable leaf', async () => {
    const markerFn = () => 'non-cloneable';
    const initial = { input: { mentions: ['62811@c.us'], meta: { tag: 'orig' }, helper: markerFn } };

    hm.register(
      'mutates-and-throws',
      'message:sending',
      async ctx => {
        const payload = ctx.data as typeof initial;
        payload.input.mentions.push('62999@c.us');
        payload.input.meta.tag = 'corrupted';
        throw new Error('boom');
      },
      10,
    );

    const res = await hm.execute('message:sending', initial, { source: 'test', isolateData: true });

    expect(initial.input.mentions).toEqual(['62811@c.us']);
    expect(initial.input.meta).toEqual({ tag: 'orig' });
    expect(res.data.input.mentions).toEqual(['62811@c.us']);
    expect(res.data.input.meta).toEqual({ tag: 'orig' });
    expect(res.data.input.helper).toBe(markerFn);
  });

  it('normalizeData transforms accepted handler output before later handlers run', async () => {
    const seenByLater: string[] = [];
    hm.register(
      'first',
      'message:sending',
      async ctx => ({
        continue: true,
        data: { ...(ctx.data as { chatId: string; text: string }), chatId: 'spoofed@c.us', text: 'edited' },
      }),
      10,
    );
    hm.register(
      'second',
      'message:sending',
      async ctx => {
        seenByLater.push((ctx.data as { chatId: string }).chatId);
        return { continue: true, data: ctx.data };
      },
      20,
    );

    const res = await hm.execute(
      'message:sending',
      { chatId: 'orig@c.us', text: 'hi' },
      {
        source: 'test',
        isolateData: true,
        normalizeData: d => ({ ...d, chatId: 'orig@c.us' }),
      },
    );

    expect(seenByLater).toEqual(['orig@c.us']);
    expect(res.data).toEqual({ chatId: 'orig@c.us', text: 'edited' });
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
    // Captured and asserted outside the handler: runHandlers isolates handler errors, so an expect
    // thrown inside the handler would be logged and swallowed instead of failing the test.
    let inner: HookResult | undefined;
    manager.register('p1', 'message:sending', async (ctx: HookContext): Promise<HookResult> => {
      calls += 1;
      inner = await manager.execute('message:sending', ctx.data, { source: 'test' });
      return { continue: true };
    });

    const result = await manager.execute('message:sending', { n: 1 }, { source: 'test' });

    expect(calls).toBe(1);
    expect(result.continue).toBe(true);
    expect(inner).toEqual({ continue: true, data: { n: 1 } });
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

describe('HookManager priority', () => {
  it('runs a non-numeric or non-finite priority at the default, keeping every other handler in order', async () => {
    const hm = new HookManager();
    const order: string[] = [];
    const push = (name: string) => () => {
      order.push(name);
      return Promise.resolve({ continue: true });
    };
    hm.register('rewrite', 'message:sending', push('rewrite@50'), 50);
    hm.register('junk', 'message:sending', push('junk'), 'high' as unknown as number);
    hm.register('nan', 'message:sending', push('nan'), NaN);
    hm.register('veto', 'message:sending', push('veto@10'), 10);

    await hm.execute('message:sending', {}, { source: 't' });

    expect(order).toEqual(['veto@10', 'rewrite@50', 'junk', 'nan']);
  });

  it('setPriority moves an existing registration and re-sorts its chain', async () => {
    const hm = new HookManager();
    const order: string[] = [];
    hm.register('a', 'message:sent', () => (order.push('a'), Promise.resolve({ continue: true })), 100);
    const id = hm.register('b', 'message:sent', () => (order.push('b'), Promise.resolve({ continue: true })), 200);

    hm.setPriority(id, 1);
    await hm.execute('message:sent', {}, { source: 't' });

    expect(order).toEqual(['b', 'a']);
  });

  it('runs every handler once when one moves a later registration ahead of itself mid-chain', async () => {
    const hm = new HookManager();
    const order: string[] = [];
    let cId = '';
    hm.register('a', 'message:sent', () => (order.push('a'), Promise.resolve({ continue: true })), 10);
    hm.register(
      'b',
      'message:sent',
      () => {
        order.push('b');
        hm.setPriority(cId, 1);
        return Promise.resolve({ continue: true });
      },
      20,
    );
    cId = hm.register('c', 'message:sent', () => (order.push('c'), Promise.resolve({ continue: true })), 30);

    await hm.execute('message:sent', {}, { source: 't' });

    expect(order).toEqual(['a', 'b', 'c']);
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

  it('currentInFlight reports the whole chain a handler runs under (what a sandbox dispatch forwards)', async () => {
    const hm = new HookManager();
    let seen: HookEvent[] = [];
    hm.register('p', 'message:sent', async () => {
      seen = hm.currentInFlight();
      return { continue: true };
    });
    expect(hm.currentInFlight()).toEqual([]);
    await hm.runInFlight(SENDING, () => hm.execute('message:sent', {}, { source: 't' }));
    expect(seen).toEqual(['message:sending', 'message:sent']);
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

describe('HookManager fail-closed pre-egress mode', () => {
  const prevEnv = process.env.HOOK_PRE_EGRESS_FAIL_CLOSED;

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.HOOK_PRE_EGRESS_FAIL_CLOSED;
    else process.env.HOOK_PRE_EGRESS_FAIL_CLOSED = prevEnv;
  });

  it('defines PRE_EGRESS_HOOK_EVENTS as message:sending and webhook:before', () => {
    expect([...PRE_EGRESS_HOOK_EVENTS].sort()).toEqual(['message:sending', 'webhook:before']);
  });

  it('defaults to fail-open on pre-egress hooks when HOOK_PRE_EGRESS_FAIL_CLOSED is unset', async () => {
    delete process.env.HOOK_PRE_EGRESS_FAIL_CLOSED;
    const hm = new HookManager();
    const later = jest.fn();
    hm.register(
      'bad',
      'message:sending',
      async () => {
        throw new Error('boom');
      },
      10,
    );
    hm.register(
      'next',
      'message:sending',
      async ctx => {
        later();
        return { continue: true, data: ctx.data };
      },
      20,
    );

    const res = await hm.execute('message:sending', { text: 'hi' }, { source: 'test' });
    expect(res).toEqual({ continue: true, data: { text: 'hi' } });
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('stops the chain and throws HookExecutionError on handler throw when HOOK_PRE_EGRESS_FAIL_CLOSED=true', async () => {
    process.env.HOOK_PRE_EGRESS_FAIL_CLOSED = 'true';
    const hm = new HookManager();
    const later = jest.fn();
    const cause = new Error('policy db unreachable');
    hm.register(
      'compliance',
      'message:sending',
      async () => {
        throw cause;
      },
      10,
    );
    hm.register(
      'later',
      'message:sending',
      async ctx => {
        later();
        return { continue: true, data: ctx.data };
      },
      20,
    );

    let thrown: unknown;
    try {
      await hm.execute('message:sending', { text: 'hi' }, { source: 'test' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(HookExecutionError);
    expect(thrown).toMatchObject({ pluginId: 'compliance', event: 'message:sending', cause });
    expect(later).not.toHaveBeenCalled();
  });

  it('throws HookExecutionError on result.error (even with continue:false) when configured via ConfigService', async () => {
    delete process.env.HOOK_PRE_EGRESS_FAIL_CLOSED;
    const configService = {
      get: jest.fn((key: string) => (key === 'hooks.preEgressFailClosed' ? true : undefined)),
    } as unknown as ConfigService;
    const hm = new HookManager(configService);
    const later = jest.fn();
    const cause = new Error('sandbox timeout');

    hm.register('dlp', 'webhook:before', async () => ({ continue: false, error: cause }), 10);
    hm.register(
      'later',
      'webhook:before',
      async ctx => {
        later();
        return { continue: true, data: ctx.data };
      },
      20,
    );

    await expect(
      hm.execute('webhook:before', { payload: { data: {} } }, { source: 'WebhookService' }),
    ).rejects.toMatchObject({
      name: 'HookExecutionError',
      pluginId: 'dlp',
      event: 'webhook:before',
      cause,
    });
    expect(later).not.toHaveBeenCalled();
  });

  it('throws HookExecutionError when accept rejects handler output in fail-closed mode', async () => {
    process.env.HOOK_PRE_EGRESS_FAIL_CLOSED = 'true';
    const hm = new HookManager();
    const later = jest.fn();
    hm.register('mutator', 'webhook:before', async () => ({ continue: true, data: { payload: 'not-an-object' } }), 10);
    hm.register(
      'later',
      'webhook:before',
      async ctx => {
        later();
        return { continue: true, data: ctx.data };
      },
      20,
    );

    await expect(
      hm.execute(
        'webhook:before',
        { payload: { ok: true } },
        {
          source: 'WebhookService',
          accept: (d: unknown) =>
            typeof d === 'object' &&
            d !== null &&
            typeof (d as { payload?: unknown }).payload === 'object' &&
            (d as { payload?: unknown }).payload !== null,
        },
      ),
    ).rejects.toBeInstanceOf(HookExecutionError);
    expect(later).not.toHaveBeenCalled();
  });

  it('still allows clean plugin veto (continue:false without error) in fail-closed mode', async () => {
    process.env.HOOK_PRE_EGRESS_FAIL_CLOSED = 'true';
    const hm = new HookManager();
    hm.register('blocker', 'message:sending', async () => ({ continue: false }), 10);

    await expect(hm.execute('message:sending', { text: 'hi' }, { source: 'test' })).resolves.toEqual({
      continue: false,
      data: { text: 'hi' },
    });
  });

  it('keeps non-pre-egress events fail-open under HOOK_PRE_EGRESS_FAIL_CLOSED=true unless overridden per call', async () => {
    process.env.HOOK_PRE_EGRESS_FAIL_CLOSED = 'true';
    const hm = new HookManager();
    hm.register('observer', 'message:received', async () => {
      throw new Error('analytics crash');
    });

    await expect(hm.execute('message:received', { body: 'hi' }, { source: 'Engine' })).resolves.toEqual({
      continue: true,
      data: { body: 'hi' },
    });

    await expect(
      hm.execute('message:received', { body: 'hi' }, { source: 'Engine', failClosed: true }),
    ).rejects.toBeInstanceOf(HookExecutionError);

    hm.register('sender-guard', 'message:sending', async () => {
      throw new Error('temporary error');
    });
    await expect(
      hm.execute('message:sending', { body: 'hi' }, { source: 'MessageService', failClosed: false }),
    ).resolves.toEqual({
      continue: true,
      data: { body: 'hi' },
    });
  });

  it.each([
    ['null-prototype object', () => Object.create(null) as unknown],
    [
      'object with throwing toString',
      () => ({
        toString() {
          throw new Error('toString exploded');
        },
      }),
    ],
    ['empty Error', () => new Error()],
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
    ['empty string', () => ''],
  ])(
    'safely handles pathological thrown value (%s) in both fail-open and fail-closed modes',
    async (_label, makeErr) => {
      delete process.env.HOOK_PRE_EGRESS_FAIL_CLOSED;
      const failOpenHm = new HookManager();
      failOpenHm.register('weird', 'message:sending', async () => {
        throw makeErr();
      });
      await expect(
        failOpenHm.execute('message:sending', { text: 'ok' }, { source: 'MessageService' }),
      ).resolves.toEqual({
        continue: true,
        data: { text: 'ok' },
      });

      process.env.HOOK_PRE_EGRESS_FAIL_CLOSED = 'true';
      const failClosedHm = new HookManager();
      failClosedHm.register('weird', 'message:sending', async () => {
        throw makeErr();
      });
      let thrown: unknown;
      try {
        await failClosedHm.execute('message:sending', { text: 'ok' }, { source: 'MessageService' });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(HookExecutionError);
      expect((thrown as HookExecutionError).message).not.toMatch(/:\s*$/);
    },
  );

  it('unregisterPluginExcept retains only specified events and allows later full cleanup via unregisterPlugin', () => {
    const hm = new HookManager();
    hm.register('p1', 'message:received', async () => ({ continue: true }));
    hm.register('p1', 'message:sending', async () => ({ continue: true }));
    hm.register('p1', 'webhook:before', async () => ({ continue: true }));
    hm.register('p2', 'message:received', async () => ({ continue: true }));

    hm.unregisterPluginExcept('p1', PRE_EGRESS_HOOK_EVENTS);

    expect(hm.getPluginEvents('p1').sort()).toEqual(['message:sending', 'webhook:before']);
    expect(hm.getHookCount('message:received')).toBe(1); // p2 untouched
    expect(hm.getHookCount('message:sending')).toBe(1);
    expect(hm.getHookCount('webhook:before')).toBe(1);

    hm.unregisterPlugin('p1');
    expect(hm.getPluginEvents('p1')).toEqual([]);
    expect(hm.getHookCount('message:sending')).toBe(0);
    expect(hm.getHookCount('webhook:before')).toBe(0);
  });

  it.each<[string, unknown]>([
    ['string continue', { continue: 'false' }],
    ['numeric continue', { continue: 1 }],
    ['empty object missing continue', {}],
    ['string primitive', 'ok'],
    ['numeric primitive', 42],
    ['null', null],
    ['array', []],
  ])('fails closed with HookExecutionError when handler returns malformed result (%s)', async (_label, badResult) => {
    process.env.HOOK_PRE_EGRESS_FAIL_CLOSED = 'true';
    const hm = new HookManager();
    const later = jest.fn();
    hm.register('bad', 'message:sending', (() => Promise.resolve(badResult)) as unknown as HookHandler, 10);
    hm.register(
      'later',
      'message:sending',
      async ctx => {
        later();
        return { continue: true, data: ctx.data };
      },
      20,
    );

    let thrown: unknown;
    try {
      await hm.execute('message:sending', { text: 'hi' }, { source: 'MessageService' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(HookExecutionError);
    expect((thrown as HookExecutionError).message).toContain('continue must be a boolean');
    expect(later).not.toHaveBeenCalled();
  });

  it('still propagates explicit result.error cause when continue is omitted in fail-closed mode', async () => {
    process.env.HOOK_PRE_EGRESS_FAIL_CLOSED = 'true';
    const hm = new HookManager();
    const cause = new Error('explicit plugin error');
    hm.register('bad', 'message:sending', (() => Promise.resolve({ error: cause })) as unknown as HookHandler, 10);

    await expect(hm.execute('message:sending', { text: 'hi' }, { source: 'MessageService' })).rejects.toMatchObject({
      name: 'HookExecutionError',
      pluginId: 'bad',
      event: 'message:sending',
      cause,
    });
  });
});

describe('HookManager async message:sent echo origin guard', () => {
  it('tracks isEventInFlight, consumes marked echo origins once, respects TTL, and bounds size with FIFO eviction', () => {
    jest.useFakeTimers();
    try {
      const hm = new HookManager();
      expect(hm.isEventInFlight('message:sent')).toBe(false);
      hm.runInFlight(['message:sent'], () => {
        expect(hm.isEventInFlight('message:sent')).toBe(true);
        expect(hm.isEventInFlight('message:received')).toBe(false);
      });
      expect(hm.isEventInFlight('message:sent')).toBe(false);

      // Empty inputs are no-ops.
      hm.markEchoOrigin('', 'msg-1');
      hm.markEchoOrigin('s1', '');
      expect(hm.consumeEchoOrigin('', 'msg-1')).toBe(false);
      expect(hm.consumeEchoOrigin('s1', '')).toBe(false);

      // One-shot consume scoped per session.
      hm.markEchoOrigin('s1', 'msg-1');
      expect(hm.consumeEchoOrigin('s2', 'msg-1')).toBe(false);
      expect(hm.consumeEchoOrigin('s1', 'msg-1')).toBe(true);
      expect(hm.consumeEchoOrigin('s1', 'msg-1')).toBe(false);

      // TTL expiry (5 minutes).
      hm.markEchoOrigin('s1', 'msg-ttl');
      jest.advanceTimersByTime(5 * 60_000 - 1);
      expect(hm.consumeEchoOrigin('s1', 'msg-ttl')).toBe(true);

      hm.markEchoOrigin('s1', 'msg-expired');
      jest.advanceTimersByTime(5 * 60_000);
      expect(hm.consumeEchoOrigin('s1', 'msg-expired')).toBe(false);

      // Bounded at 10,000 entries with FIFO eviction.
      for (let i = 0; i < 10_005; i++) {
        hm.markEchoOrigin('s1', `m-${i}`);
      }
      expect(hm.consumeEchoOrigin('s1', 'm-0')).toBe(false);
      expect(hm.consumeEchoOrigin('s1', 'm-4')).toBe(false);
      expect(hm.consumeEchoOrigin('s1', 'm-5')).toBe(true);
      expect(hm.consumeEchoOrigin('s1', 'm-10004')).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('suppresses second message:sent hook on echo when an in-process message:sent handler sends a message', async () => {
    const db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message],
      synchronize: true,
    }).initialize();
    try {
      const repo = db.getRepository(Message);
      const hm = new HookManager();
      const engines = new EngineRegistry();
      const emitMessageSent = jest.fn();
      const webhookDispatch = jest.fn().mockResolvedValue(undefined);
      let nextMsgSeq = 2;

      const sendTextMessage = jest.fn(async (chatId: string, text: string) => {
        const id = `WA-MSG-${nextMsgSeq++}`;
        const timestamp = Math.floor(Date.now() / 1000);
        // Simulate the asynchronous own-send echo arriving from the WhatsApp engine.
        setImmediate(() => {
          const echo: IncomingMessage = {
            id,
            chatId,
            from: '620000@c.us',
            to: chatId,
            fromMe: true,
            body: text,
            type: 'text',
            timestamp,
            isGroup: false,
            kind: 'individual',
          };
          projector.handleOwnSendEcho('s1', engine, echo);
        });
        return { id, timestamp };
      });
      const engine = {
        sendTextMessage,
        sendChatState: jest.fn().mockResolvedValue(undefined),
      } as unknown as IWhatsAppEngine;
      engines.set('s1', engine);

      const sessionRepo = { update: jest.fn().mockResolvedValue({ affected: 1 }) } as unknown as Repository<Session>;
      const projector = new MessageProjector(
        repo,
        sessionRepo,
        engines,
        { emitMessage: jest.fn(), emitMessageSent } as unknown as EventsGateway,
        { dispatch: webhookDispatch } as unknown as WebhookService,
        hm,
        {} as StatusStoreService,
        { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
      );

      const config = new ConfigService({ features: { simulateTyping: false } });
      const sender = new MessageSendService(
        repo,
        { findOne: jest.fn().mockResolvedValue({ id: 's1', phone: '620000' }) } as unknown as SessionService,
        engines,
        hm,
        {} as TemplateService,
        new SendPacingService(repo, sessionRepo),
        config,
      );

      const hookCalls: string[] = [];
      hm.register('echo-plugin', 'message:sent', async ctx => {
        const msg = ctx.data as IncomingMessage;
        hookCalls.push(msg.id);
        await sender.sendText('s1', { chatId: msg.chatId, text: 'auto-reply' });
        return { continue: true, data: ctx.data };
      });

      const firstEcho: IncomingMessage = {
        id: 'WA-MSG-1',
        chatId: '628111@c.us',
        from: '620000@c.us',
        to: '628111@c.us',
        fromMe: true,
        body: 'initial',
        type: 'text',
        timestamp: 1_700_000_000,
        isGroup: false,
        kind: 'individual',
      };
      projector.handleOwnSendEcho('s1', engine, firstEcho);
      for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));

      // The message:sent hook ran ONLY for WA-MSG-1; WA-MSG-2's echo was suppressed from re-entering the hook.
      expect(hookCalls).toEqual(['WA-MSG-1']);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);

      // Still persisted both messages and emitted webhook + WS message.sent for both.
      const rows = await repo.find({ order: { waMessageId: 'ASC' } });
      expect(rows.map(r => r.waMessageId)).toEqual(['WA-MSG-1', 'WA-MSG-2']);
      expect(emitMessageSent).toHaveBeenCalledTimes(2);
      expect(webhookDispatch).toHaveBeenCalledTimes(2);
    } finally {
      await db.destroy();
    }
  });

  it('suppresses early own-send echo arriving before engine.sendTextMessage resolves and releases waiters on failure', async () => {
    const runAtRoot = AsyncLocalStorage.snapshot();
    const db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message],
      synchronize: true,
    }).initialize();
    try {
      const repo = db.getRepository(Message);
      const hm = new HookManager();
      const engines = new EngineRegistry();
      const emitMessageSent = jest.fn();
      const webhookDispatch = jest.fn().mockResolvedValue(undefined);
      let nextMsgSeq = 2;

      const sendTextMessage = jest.fn((chatId: string, text: string) => {
        const id = `WA-EARLY-${nextMsgSeq++}`;
        const timestamp = Math.floor(Date.now() / 1000);
        // Simulate whatsapp-web.js emitting message_create in a root ALS context at 5ms,
        // BEFORE engine.sendTextMessage resolves { id, timestamp } at 40ms.
        runAtRoot(() => {
          setTimeout(() => {
            const echo: IncomingMessage = {
              id,
              chatId,
              from: '620000@c.us',
              to: chatId,
              fromMe: true,
              body: text,
              type: 'text',
              timestamp,
              isGroup: false,
              kind: 'individual',
            };
            projector.handleOwnSendEcho('s1', engine, echo);
          }, 5);
        });
        return new Promise<{ id: string; timestamp: number }>(resolve => {
          setTimeout(() => resolve({ id, timestamp }), 40);
        });
      });
      const engine = {
        sendTextMessage,
        sendChatState: jest.fn().mockResolvedValue(undefined),
      } as unknown as IWhatsAppEngine;
      engines.set('s1', engine);

      const sessionRepo = { update: jest.fn().mockResolvedValue({ affected: 1 }) } as unknown as Repository<Session>;
      const projector = new MessageProjector(
        repo,
        sessionRepo,
        engines,
        { emitMessage: jest.fn(), emitMessageSent } as unknown as EventsGateway,
        { dispatch: webhookDispatch } as unknown as WebhookService,
        hm,
        {} as StatusStoreService,
        { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
      );

      const config = new ConfigService({ features: { simulateTyping: false } });
      const sender = new MessageSendService(
        repo,
        { findOne: jest.fn().mockResolvedValue({ id: 's1', phone: '620000' }) } as unknown as SessionService,
        engines,
        hm,
        {} as TemplateService,
        new SendPacingService(repo, sessionRepo),
        config,
      );

      const hookCalls: string[] = [];
      hm.register('echo-plugin', 'message:sent', async ctx => {
        const msg = ctx.data as IncomingMessage;
        hookCalls.push(msg.id);
        if (hookCalls.length <= 3) {
          await sender.sendText('s1', { chatId: msg.chatId, text: 'early-reply' });
        }
        return { continue: true, data: ctx.data };
      });

      projector.handleOwnSendEcho('s1', engine, {
        id: 'WA-EARLY-1',
        chatId: '628111@c.us',
        from: '620000@c.us',
        to: '628111@c.us',
        fromMe: true,
        body: 'initial',
        type: 'text',
        timestamp: 1_700_000_000,
        isGroup: false,
        kind: 'individual',
      });

      await new Promise(resolve => setTimeout(resolve, 180));

      expect(hookCalls).toEqual(['WA-EARLY-1']);
      expect(sendTextMessage).toHaveBeenCalledTimes(1);
      expect(emitMessageSent).toHaveBeenCalledTimes(2);
      expect(webhookDispatch).toHaveBeenCalledTimes(2);
      // Echo origin must have been consumed by the early echo, leaving zero stale entries.
      expect(hm.consumeEchoOrigin('s1', 'WA-EARLY-2')).toBe(false);

      // A failing engine send initiated inside message:sent must release pending waiters so
      // unrelated echoes on the same session never stall.
      sendTextMessage.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('engine send failed')), 20);
          }),
      );
      const failingSend = hm.runInFlight(['message:sent'], () =>
        sender.sendText('s1', { chatId: '628111@c.us', text: 'will-fail' }),
      );
      failingSend.catch(() => undefined);

      await new Promise(resolve => setTimeout(resolve, 5));
      runAtRoot(() => {
        projector.handleOwnSendEcho('s1', engine, {
          id: 'WA-UNRELATED-3',
          chatId: '628222@c.us',
          from: '620000@c.us',
          to: '628222@c.us',
          fromMe: true,
          body: 'from-phone',
          type: 'text',
          timestamp: 1_700_000_010,
          isGroup: false,
          kind: 'individual',
        });
      });

      await expect(failingSend).rejects.toThrow('engine send failed');
      await new Promise(resolve => setTimeout(resolve, 120));
      expect(hookCalls).toEqual(['WA-EARLY-1', 'WA-UNRELATED-3']);
    } finally {
      await db.destroy();
    }
  });

  it('suppresses echo when an in-process message:sent handler fires sendText or sendTemplate without awaiting', async () => {
    const runAtRoot = AsyncLocalStorage.snapshot();
    const db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Message],
      synchronize: true,
    }).initialize();
    try {
      const repo = db.getRepository(Message);
      const hm = new HookManager();
      const engines = new EngineRegistry();
      const emitMessageSent = jest.fn();
      const webhookDispatch = jest.fn().mockResolvedValue(undefined);
      let nextMsgSeq = 2;

      const sendTextMessage = jest.fn((chatId: string, text: string) => {
        const id = `WA-FF-${nextMsgSeq++}`;
        const timestamp = Math.floor(Date.now() / 1000);
        return new Promise<{ id: string; timestamp: number }>(resolve => {
          setTimeout(() => {
            resolve({ id, timestamp });
            runAtRoot(() => {
              setTimeout(() => {
                projector.handleOwnSendEcho('s1', engine, {
                  id,
                  chatId,
                  from: '620000@c.us',
                  to: chatId,
                  fromMe: true,
                  body: text,
                  type: 'text',
                  timestamp,
                  isGroup: false,
                  kind: 'individual',
                });
              }, 5);
            });
          }, 25);
        });
      });
      const engine = {
        sendTextMessage,
        sendChatState: jest.fn().mockResolvedValue(undefined),
      } as unknown as IWhatsAppEngine;
      engines.set('s1', engine);

      const sessionRepo = { update: jest.fn().mockResolvedValue({ affected: 1 }) } as unknown as Repository<Session>;
      const projector = new MessageProjector(
        repo,
        sessionRepo,
        engines,
        { emitMessage: jest.fn(), emitMessageSent } as unknown as EventsGateway,
        { dispatch: webhookDispatch } as unknown as WebhookService,
        hm,
        {} as StatusStoreService,
        { resolveSenderPhone: jest.fn().mockResolvedValue(null) } as unknown as SessionLidResolver,
      );

      const templateService = {
        resolve: jest.fn(
          () =>
            new Promise(resolve => {
              setTimeout(() => resolve({ header: null, body: 'template-reply', footer: null }), 15);
            }),
        ),
      } as unknown as TemplateService;

      const config = new ConfigService({ features: { simulateTyping: false } });
      const sender = new MessageSendService(
        repo,
        { findOne: jest.fn().mockResolvedValue({ id: 's1', phone: '620000' }) } as unknown as SessionService,
        engines,
        hm,
        templateService,
        new SendPacingService(repo, sessionRepo),
        config,
      );

      const hookCalls: string[] = [];
      const detachedSends: Promise<unknown>[] = [];
      hm.register('fire-and-forget', 'message:sent', async ctx => {
        const msg = ctx.data as IncomingMessage;
        hookCalls.push(msg.id);
        if (hookCalls.length <= 3) {
          // Intentionally NOT awaited so HookManager.runInFlight clears its ALS scope immediately.
          detachedSends.push(sender.sendText('s1', { chatId: msg.chatId, text: 'ff-text' }));
          detachedSends.push(sender.sendTemplate('s1', { chatId: msg.chatId, templateName: 'welcome' }));
        }
        return { continue: true, data: ctx.data };
      });

      projector.handleOwnSendEcho('s1', engine, {
        id: 'WA-FF-1',
        chatId: '628111@c.us',
        from: '620000@c.us',
        to: '628111@c.us',
        fromMe: true,
        body: 'initial',
        type: 'text',
        timestamp: 1_700_000_000,
        isGroup: false,
        kind: 'individual',
      });

      await new Promise(resolve => setTimeout(resolve, 200));
      await Promise.all(detachedSends);
      await new Promise(resolve => setTimeout(resolve, 60));

      expect(hookCalls).toEqual(['WA-FF-1']);
      expect(sendTextMessage).toHaveBeenCalledTimes(2);
      expect(emitMessageSent).toHaveBeenCalledTimes(3);
      expect(webhookDispatch).toHaveBeenCalledTimes(3);
    } finally {
      await db.destroy();
    }
  });
});
