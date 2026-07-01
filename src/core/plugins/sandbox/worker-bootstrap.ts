import { parentPort } from 'worker_threads';
import { HostToWorkerMessage, WorkerToHostMessage } from './protocol';
import { WorkerCapabilityClient, buildSandboxContext } from './worker-capability';
import { WorkerHookRegistry, WorkerHookHandler, hookConfigStore } from './worker-hooks';
import { WebhookRegistry, WebhookHandler } from './worker-webhooks';

/**
 * Worker entry for an untrusted plugin. Loads the plugin module and drives its lifecycle in response
 * to host messages. This is the only code that runs alongside untrusted plugin code, so it keeps no
 * host references — its sole channel out is `parentPort`, and every capability call round-trips to
 * the host (which validates permission + session scope) via the capability client.
 */

interface LifecyclePlugin {
  onLoad?(context: unknown): unknown;
  onEnable?(context: unknown): unknown;
  onDisable?(context: unknown): unknown;
  onUnload?(context: unknown): unknown;
  onConfigChange?(context: unknown, config: Record<string, unknown>): unknown;
  healthCheck?(): unknown;
}

const port = parentPort;
if (!port) {
  throw new Error('worker-bootstrap must be run as a worker thread');
}

const send = (message: WorkerToHostMessage): void => port.postMessage(message);
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const capClient = new WorkerCapabilityClient(send);
const hookRegistry = new WorkerHookRegistry(send);
const webhookRegistry = new WebhookRegistry(send);

// ctx.logger proxy: forwards to the host's per-plugin logger (the same one in-process plugins use).
const logger = {
  log: (message: string, meta?: Record<string, unknown>) => send({ kind: 'log', level: 'log', message, meta }),
  debug: (message: string, meta?: Record<string, unknown>) => send({ kind: 'log', level: 'debug', message, meta }),
  warn: (message: string, meta?: Record<string, unknown>) => send({ kind: 'log', level: 'warn', message, meta }),
  error: (message: string, error?: unknown, meta?: Record<string, unknown>) =>
    send({
      kind: 'log',
      level: 'error',
      message,
      meta: error !== undefined ? { ...meta, error: errorMessage(error) } : meta,
    }),
};
let plugin: LifecyclePlugin | null = null;
let context: Record<string, unknown> | null = null;
// The base ('*') config; ctx.config returns the per-hook session slice when one is in scope, else this.
let baseConfig: Record<string, unknown> = {};

port.on('message', (message: HostToWorkerMessage) => {
  if (message.kind === 'cap-result') {
    capClient.handleResult(message);
    return;
  }
  if (message.kind === 'hook') {
    void hookRegistry.handleHook(message);
    return;
  }
  if (message.kind === 'webhook') {
    void webhookRegistry.handleWebhook(message);
    return;
  }
  void handle(message);
});

async function handle(message: HostToWorkerMessage): Promise<void> {
  if (message.kind === 'load') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(message.mainPath) as { default?: new () => LifecyclePlugin } & (new () => LifecyclePlugin);
      const PluginCtor = mod.default ?? mod;
      plugin = new PluginCtor();
      const staticContext = message.context ?? { pluginId: 'unknown', config: {} };
      baseConfig = staticContext.config;
      context = {
        pluginId: staticContext.pluginId,
        // Per-session: a hook dispatch scopes its resolved slice via hookConfigStore; outside a hook
        // (lifecycle, onConfigChange) this is the base config.
        get config() {
          return hookConfigStore.getStore()?.config ?? baseConfig;
        },
        logger,
        ...buildSandboxContext(capClient),
        registerHook: (event: string, handler: WorkerHookHandler, priority?: number) =>
          hookRegistry.register(event, handler, priority),
        registerWebhook: (route: string, handler: WebhookHandler) => webhookRegistry.register(route, handler),
      };
      send({ kind: 'ready' });
    } catch (error) {
      send({ kind: 'error', error: errorMessage(error) });
    }
    return;
  }

  if (message.kind === 'lifecycle') {
    try {
      await plugin?.[message.method]?.(context);
      send({ kind: 'lifecycle-result', id: message.id, ok: true });
    } catch (error) {
      send({ kind: 'lifecycle-result', id: message.id, ok: false, error: errorMessage(error) });
    }
    return;
  }

  if (message.kind === 'config-change') {
    // Refresh the base config so later (non-hook) reads of ctx.config see the new value, then notify
    // the plugin (fire-and-forget — onConfigChange returns void, and an ack would race the next op).
    baseConfig = message.config;
    void Promise.resolve(plugin?.onConfigChange?.(context, message.config)).catch(error =>
      logger.error('onConfigChange threw', error),
    );
    return;
  }

  if (message.kind === 'health-check') {
    try {
      const result = plugin?.healthCheck
        ? ((await plugin.healthCheck()) as { healthy: boolean; message?: string })
        : { healthy: true, message: 'Plugin does not implement health check' };
      send({ kind: 'health-result', id: message.id, healthy: result.healthy, message: result.message });
    } catch (error) {
      send({ kind: 'health-result', id: message.id, healthy: false, message: errorMessage(error) });
    }
  }
}
