import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { HookManager } from '../hooks';
import { PluginLoaderService } from './plugin-loader.service';
import { PluginStorageService } from './plugin-storage.service';
import { PluginInstance, PluginStatus, PluginType } from './plugin.interfaces';
import { PLUGIN_INSTANCE_PORT } from './plugin-host-ports';
import { PluginWorkerHost } from './sandbox/plugin-worker-host';
import { IngressProcessor, IngressJobData } from '../../modules/queue/processors/ingress.processor';

describe('queued ingress dispatch budgets', () => {
  const channels: { close: () => void }[] = [];

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    for (const channel of channels.splice(0)) channel.close();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function setup(typingMaxMs: number, replyAfterMs?: number) {
    let receive: ((message: unknown) => void) | undefined;
    let exit: ((code: number) => void) | undefined;
    const channel = {
      postMessage(message: { kind: string; id: number }) {
        if (message.kind === 'webhook' && replyAfterMs !== undefined) {
          setTimeout(() => receive?.({ kind: 'webhook-result', id: message.id, status: 200 }), replyAfterMs);
        }
      },
      onMessage: (listener: (message: unknown) => void) => (receive = listener),
      onExit: (listener: (code: number) => void) => (exit = listener),
      terminate: () => Promise.resolve(),
    };
    const host = new PluginWorkerHost(channel as never);
    channels.push({ close: () => exit?.(0) });
    const instance = {
      id: 'reply:inbox',
      pluginId: 'reply',
      instanceId: 'inbox',
      sessionScope: 'session-1',
      secret: 'dummy-secret',
      verifyToken: null,
      config: {},
      enabled: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const instancePort = { resolve: () => Promise.resolve(instance), list: () => Promise.resolve([instance]) };
    const config = new ConfigService({
      features: {
        autoStartSessions: false,
        storeEphemeralMessages: true,
        resolveLidToPhone: false,
        simulateTyping: true,
        simulateTypingMaxMs: typingMaxMs,
      },
    });
    const hooks = new HookManager();
    const loader = new PluginLoaderService(
      config,
      hooks,
      {} as PluginStorageService,
      {
        get: (token: unknown) => {
          if (token === PLUGIN_INSTANCE_PORT) return instancePort;
          throw new Error('Unexpected provider');
        },
      } as unknown as ModuleRef,
    );
    const state = loader as unknown as {
      plugins: Map<string, PluginInstance>;
      sandboxHosts: Map<string, PluginWorkerHost>;
    };
    state.plugins.set('reply', {
      manifest: {
        id: 'reply',
        name: 'Reply',
        version: '1.0.0',
        type: PluginType.EXTENSION,
        main: 'index.js',
        ingress: [
          {
            route: 'reply',
            mode: 'async',
            verify: 'core',
            maxBodyBytes: 65536,
            signature: { scheme: 'hmac-sha256', header: 'x-signature' },
          },
        ],
      },
      instance: null,
      status: PluginStatus.ENABLED,
      builtIn: false,
      config: {},
      loadedAt: new Date(0),
    });
    state.sandboxHosts.set('reply', host);
    const data: IngressJobData = {
      pluginId: 'reply',
      instanceId: 'inbox',
      route: 'reply',
      deliveryId: 'delivery-1',
      sessionId: 'session-1',
      payload: { headers: {}, query: {}, body: '{}', rawBody: '{}', admission: { verified: true } },
    };
    const processor = new IngressProcessor(loader, {} as never, hooks, {} as never, {} as never);
    const queued = () => processor.process({ id: 'job-1', data, attemptsMade: 0, opts: { attempts: 3 } } as never);
    return { queued, inline: () => loader.dispatchWebhookForInstance(data) };
  }

  it.each([
    { typingMaxMs: 5000, replyAfterMs: 5800 },
    { typingMaxMs: 8000, replyAfterMs: 12000 },
  ])('finishes a queued reply after $replyAfterMs ms', async ({ typingMaxMs, replyAfterMs }) => {
    const { queued } = setup(typingMaxMs, replyAfterMs);
    const outcome = queued().then(
      () => 'completed',
      (error: Error) => error.message,
    );
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(replyAfterMs);
    expect(await outcome).toBe('completed');
  });

  it('keeps inline dispatch bounded at five seconds', async () => {
    const { inline } = setup(5000, 5800);
    let outcome = 'pending';
    void inline().then(
      () => (outcome = 'completed'),
      (error: Error) => (outcome = error.message),
    );
    await jest.advanceTimersByTimeAsync(4999);
    expect(outcome).toBe('pending');
    await jest.advanceTimersByTimeAsync(1);
    expect(outcome).toMatch(/status 504/);
  });

  it('expires queued dispatch at the default typing cap plus five seconds', async () => {
    const { queued } = setup(5000);
    let outcome = 'pending';
    void queued().then(
      () => (outcome = 'completed'),
      (error: Error) => (outcome = error.message),
    );
    await jest.advanceTimersByTimeAsync(9999);
    expect(outcome).toBe('pending');
    await jest.advanceTimersByTimeAsync(1);
    expect(outcome).toMatch(/status 504/);
  });

  it('caps queued dispatch below the default thirty-second worker lock', async () => {
    const { queued } = setup(60000);
    let outcome = 'pending';
    void queued().then(
      () => (outcome = 'completed'),
      (error: Error) => (outcome = error.message),
    );
    await jest.advanceTimersByTimeAsync(24999);
    expect(outcome).toBe('pending');
    await jest.advanceTimersByTimeAsync(1);
    expect(outcome).toMatch(/status 504/);
  });
});
