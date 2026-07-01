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

/** Static context fields handed to a sandboxed plugin at load (serializable; no live references). */
export interface SandboxStaticContext {
  pluginId: string;
  config: Record<string, unknown>;
}

export type PluginLogLevel = 'log' | 'debug' | 'warn' | 'error';

export type HostToWorkerMessage =
  | { kind: 'load'; mainPath: string; context?: SandboxStaticContext }
  | { kind: 'lifecycle'; id: number; method: PluginLifecycleMethod }
  // Reply to a worker-initiated capability call.
  | { kind: 'cap-result'; id: number; ok: true; result: unknown }
  | { kind: 'cap-result'; id: number; ok: false; error: string }
  // Dispatch a subscribed hook to the worker; it runs its handler(s) and replies with hook-result.
  // `config` is the per-session-resolved config the host computed for this event's sessionId (the
  // override merged over the base); the worker exposes it as ctx.config for the duration of the call.
  | {
      kind: 'hook';
      id: number;
      event: string;
      data: unknown;
      sessionId?: string;
      source: string;
      config?: Record<string, unknown>;
    }
  // The plugin's config was updated: refresh ctx.config and invoke onConfigChange (fire-and-forget).
  | { kind: 'config-change'; config: Record<string, unknown> }
  // Ask the worker plugin to run its healthCheck(); it replies with health-result.
  | { kind: 'health-check'; id: number }
  // Dispatch a verified inbound webhook to the worker for a route it subscribed to (webhook-subscribe).
  // `body`/`rawBody` are buffered host-side to a string, like PluginNetResponse.body. `verified`
  // reflects the host's signature check (see PluginIngressRoute.verify); the worker still re-checks
  // when `verify: 'self'`. The worker replies with webhook-result.
  | {
      kind: 'webhook';
      id: number;
      instanceId: string;
      route: string;
      method: string;
      headers: Record<string, string>;
      query: Record<string, string>;
      body: string;
      rawBody: string;
      verified: boolean;
      deliveryId: string;
      sessionId?: string;
    };

export type WorkerToHostMessage =
  | { kind: 'ready' }
  | { kind: 'lifecycle-result'; id: number; ok: true }
  | { kind: 'lifecycle-result'; id: number; ok: false; error: string }
  // Worker-initiated capability call (ctx.messages.* / ctx.engine.* / ctx.storage.*). The host
  // validates it (permission + session scope) before running the real verb and replying.
  | { kind: 'cap'; id: number; verb: string; args: unknown[] }
  // The worker asks the host to dispatch `event` to it (registered a handler for it).
  | { kind: 'hook-subscribe'; event: string; priority?: number }
  // The worker's handler result for a dispatched hook (continue/modify/error).
  | { kind: 'hook-result'; id: number; continue: boolean; data?: unknown; error?: string }
  // The worker plugin's ctx.logger.* call, routed to the host's per-plugin logger.
  | { kind: 'log'; level: PluginLogLevel; message: string; meta?: Record<string, unknown> }
  // The worker plugin's healthCheck() result for a host health-check request.
  | { kind: 'health-result'; id: number; healthy: boolean; message?: string }
  // The worker claims an ingress route declared in its manifest (registered a webhook handler for it).
  | { kind: 'webhook-subscribe'; route: string }
  // The worker's response to a dispatched webhook — the host relays this to the caller (sync-reply
  // mode) or discards it (async mode). `error` set = the handler threw.
  | {
      kind: 'webhook-result';
      id: number;
      status: number;
      headers?: Record<string, string>;
      body?: string;
      error?: string;
    }
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
