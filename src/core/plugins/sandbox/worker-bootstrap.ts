import { parentPort } from 'worker_threads';
import { HostToWorkerMessage, WorkerToHostMessage } from './protocol';
import { WorkerCapabilityClient, buildSandboxContext, SandboxCapabilityContext } from './worker-capability';

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
}

const port = parentPort;
if (!port) {
  throw new Error('worker-bootstrap must be run as a worker thread');
}

const send = (message: WorkerToHostMessage): void => port.postMessage(message);
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const capClient = new WorkerCapabilityClient(send);
let plugin: LifecyclePlugin | null = null;
let context: SandboxCapabilityContext | null = null;

port.on('message', (message: HostToWorkerMessage) => {
  if (message.kind === 'cap-result') {
    capClient.handleResult(message);
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
      context = buildSandboxContext(capClient);
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
  }
}
