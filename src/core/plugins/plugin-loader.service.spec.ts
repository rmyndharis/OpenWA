import { PluginLoaderService } from './plugin-loader.service';
import { PluginCircuitBreaker } from '../hooks/plugin-circuit-breaker.service';
import { HookManager } from '../hooks';
import { PluginPermissionDeniedError } from './exceptions/plugin-permission-denied.error';
import { PluginInstance, PluginStatus, PluginType } from './plugin.interfaces';

function makeLoader() {
  const config = {
    get: (key: string) => {
      const map: Record<string, unknown> = {
        'plugins.dir': './plugins',
        'plugins.hookTimeoutMs': 5000,
        'plugins.lifecycleTimeoutMs': 10000,
        'plugins.circuitBreakerThreshold': 5,
        'cluster.enabled': false,
      };
      return map[key];
    },
  } as any;
  const breaker = new PluginCircuitBreaker();
  const hookManager = new HookManager(breaker);
  const storage = {
    getPluginConfig: () => ({}),
    setPluginStatus: () => {},
    setPluginConfig: () => {},
    createPluginStorage: () => ({
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    }),
  } as any;
  return new PluginLoaderService(config, hookManager, storage, breaker);
}

function instance(permissions?: string[], secretKeys: string[] = []): PluginInstance {
  return {
    manifest: {
      id: 'p1',
      name: 'P1',
      version: '1.0.0',
      type: PluginType.EXTENSION,
      main: 'index.js',
      permissions: permissions as any,
      configSchema: secretKeys.length
        ? {
            type: 'object',
            properties: Object.fromEntries(secretKeys.map(k => [k, { type: 'string', secret: true }])),
          }
        : undefined,
    },
    status: PluginStatus.INSTALLED,
    config: { token: 'super-secret', name: 'visible' },
    instance: null,
    loadedAt: new Date(),
  };
}

describe('PluginLoaderService capabilities', () => {
  it('denies storage when not granted', async () => {
    const loader = makeLoader();
    const ctx = (loader as any).createPluginContext(instance([]));
    await expect(ctx.storage.get('k')).rejects.toBeInstanceOf(PluginPermissionDeniedError);
  });

  it('allows storage when granted', async () => {
    const loader = makeLoader();
    const ctx = (loader as any).createPluginContext(instance(['storage']));
    await expect(ctx.storage.get('k')).resolves.toBeNull();
  });

  it('returns undefined from getService when services not granted', () => {
    const loader = makeLoader();
    const ctx = (loader as any).createPluginContext(instance([]));
    expect(ctx.getService('anything')).toBeUndefined();
  });

  it('is permissive when permissions are absent (storage works)', async () => {
    const loader = makeLoader();
    const ctx = (loader as any).createPluginContext(instance(undefined));
    await expect(ctx.storage.get('k')).resolves.toBeNull();
  });

  it('freezes the context', () => {
    const loader = makeLoader();
    const ctx = (loader as any).createPluginContext(instance(['storage']));
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it('redacts secret values that appear in log meta', () => {
    const loader = makeLoader();
    const logs: Array<{ msg: string; meta: unknown }> = [];
    (loader as any).logger = {
      log: (msg: string, meta: unknown) => logs.push({ msg, meta }),
      debug: () => {},
      warn: () => {},
      error: () => {},
    };
    const ctx = (loader as any).createPluginContext(instance(['storage'], ['token']));
    ctx.logger.log('ok', { value: 'super-secret', nested: { k: 'super-secret' } });
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).toContain('***');
  });

  it('redacts secret config values in the plugin logger', () => {
    const loader = makeLoader();
    const logs: string[] = [];
    (loader as any).logger = {
      log: (m: string) => logs.push(m),
      debug: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    };
    const ctx = (loader as any).createPluginContext(instance(['storage'], ['token']));
    ctx.logger.log('value is super-secret here');
    expect(logs.join('\n')).not.toContain('super-secret');
    expect(logs.join('\n')).toContain('***');
  });
});
