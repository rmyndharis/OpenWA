/**
 * Wire protocol between the host (PluginWorkerHost) and an untrusted plugin worker.
 *
 * The worker has exactly one channel out — these messages — and no ambient access to the host. The
 * host validates every request before acting on it, so a hostile worker cannot escalate beyond what
 * its manifest declares.
 *
 * Phase B1 scope: lifecycle only (load + onLoad/onEnable/onDisable/onUnload). The capability bridge
 * (B2) and hook bridge (B3) add more message kinds later.
 */

export type PluginLifecycleMethod = 'onLoad' | 'onEnable' | 'onDisable' | 'onUnload';

export type HostToWorkerMessage =
  | { kind: 'load'; mainPath: string }
  | { kind: 'lifecycle'; id: number; method: PluginLifecycleMethod }
  // Reply to a worker-initiated capability call.
  | { kind: 'cap-result'; id: number; ok: true; result: unknown }
  | { kind: 'cap-result'; id: number; ok: false; error: string };

export type WorkerToHostMessage =
  | { kind: 'ready' }
  | { kind: 'lifecycle-result'; id: number; ok: true }
  | { kind: 'lifecycle-result'; id: number; ok: false; error: string }
  // Worker-initiated capability call (ctx.messages.* / ctx.engine.* / ctx.storage.*). The host
  // validates it (permission + session scope) before running the real verb and replying.
  | { kind: 'cap'; id: number; verb: string; args: unknown[] }
  | { kind: 'error'; error: string };

/**
 * Transport abstraction over the worker. The real implementation wraps a Node `worker_thread`; tests
 * use an in-memory fake. Keeping the host's protocol logic behind this interface makes it unit-
 * testable without spawning an OS thread, and leaves room for a child-process transport later.
 */
export interface PluginWorkerChannel {
  postMessage(message: HostToWorkerMessage): void;
  onMessage(handler: (message: WorkerToHostMessage) => void): void;
  onExit(handler: (code: number) => void): void;
  terminate(): Promise<void>;
}
