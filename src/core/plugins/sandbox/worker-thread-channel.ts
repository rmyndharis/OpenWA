import { Worker } from 'worker_threads';
import { PluginWorkerChannel, HostToWorkerMessage, WorkerToHostMessage } from './protocol';

export interface WorkerThreadChannelOptions {
  /** Path to the worker bootstrap entry (compiled `worker-bootstrap.js` in production). */
  workerEntry: string;
  /** Hard memory cap for the worker; an OOM terminates the worker, not the host. */
  maxOldGenerationSizeMb?: number;
  /** Extra Node args for the worker (e.g. a TS loader in tests). */
  execArgv?: string[];
  /** Environment for the worker. Later phases use this to hand the worker a minimal, scrubbed env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Real {@link PluginWorkerChannel} backed by a Node `worker_thread`. Deliberately thin: it only
 * shuttles messages and surfaces worker lifetime events. All protocol logic lives in
 * {@link PluginWorkerHost}, so this adapter (and a future child-process variant) stays trivial.
 */
export class WorkerThreadChannel implements PluginWorkerChannel {
  private readonly worker: Worker;

  constructor(options: WorkerThreadChannelOptions) {
    this.worker = new Worker(options.workerEntry, {
      execArgv: options.execArgv,
      env: options.env,
      resourceLimits:
        options.maxOldGenerationSizeMb !== undefined
          ? { maxOldGenerationSizeMb: options.maxOldGenerationSizeMb }
          : undefined,
    });
  }

  postMessage(message: HostToWorkerMessage): void {
    this.worker.postMessage(message);
  }

  onMessage(handler: (message: WorkerToHostMessage) => void): void {
    this.worker.on('message', handler);
    // Surface a worker startup/runtime crash as a protocol error so the host's pending call rejects
    // with the real reason instead of only an opaque exit code.
    this.worker.on('error', (error: unknown) =>
      handler({ kind: 'error', error: error instanceof Error ? error.message : String(error) }),
    );
  }

  onExit(handler: (code: number) => void): void {
    this.worker.on('exit', handler);
  }

  async terminate(): Promise<void> {
    await this.worker.terminate();
  }
}
