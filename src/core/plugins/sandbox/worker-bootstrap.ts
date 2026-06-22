import { parentPort } from 'worker_threads';
import { HostToWorkerMessage, WorkerToHostMessage } from './protocol';

/**
 * Worker entry for an untrusted plugin. Loads the plugin module and drives its lifecycle in
 * response to host messages. This is the *only* code that runs alongside untrusted plugin code, so
 * it keeps no host references — its sole channel out is `parentPort`.
 *
 * Phase B1: lifecycle only. The plugin receives an empty context stub; the capability bridge (B2)
 * and hook bridge (B3) replace that with proxies that round-trip through the host.
 */

interface LifecyclePlugin {
  onLoad?(context: unknown): unknown;
  onEnable?(context: unknown): unknown;
  onDisable?(context: unknown): unknown;
  onUnload?(context: unknown): unknown;
}

const port = parentPort;
if (!port) {
  throw new Error('worker-bootstrap must be run as a worker thread');
}

let plugin: LifecyclePlugin | null = null;

const send = (message: WorkerToHostMessage): void => port.postMessage(message);
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

port.on('message', (message: HostToWorkerMessage) => {
  void handle(message);
});

async function handle(message: HostToWorkerMessage): Promise<void> {
  if (message.kind === 'load') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(message.mainPath) as { default?: new () => LifecyclePlugin } & (new () => LifecyclePlugin);
      const PluginCtor = mod.default ?? mod;
      plugin = new PluginCtor();
      send({ kind: 'ready' });
    } catch (error) {
      send({ kind: 'error', error: errorMessage(error) });
    }
    return;
  }

  if (message.kind === 'lifecycle') {
    try {
      // B1: no real capability context yet — pass an empty stub.
      await plugin?.[message.method]?.({});
      send({ kind: 'lifecycle-result', id: message.id, ok: true });
    } catch (error) {
      send({ kind: 'lifecycle-result', id: message.id, ok: false, error: errorMessage(error) });
    }
  }
}
