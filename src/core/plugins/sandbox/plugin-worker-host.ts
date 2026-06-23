import {
  PluginWorkerChannel,
  PluginLifecycleMethod,
  WorkerToHostMessage,
  SandboxStaticContext,
  PluginLogLevel,
} from './protocol';

/**
 * Host-side driver for a single untrusted plugin running in a worker. Owns the request/response
 * correlation over a {@link PluginWorkerChannel}: it posts `load`/`lifecycle` messages and resolves
 * the matching promise when the worker replies, and fails every outstanding call if the worker dies.
 *
 * Phase B1 covers lifecycle only. The capability bridge (B2) and hook bridge (B3) extend this with
 * their own correlated message kinds, all over the same channel.
 */
export class PluginWorkerHost {
  private nextId = 1;
  private ready = false;
  private dead = false;
  private readyWaiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }> = [];
  private readonly pending = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }
  >();
  private readonly hookPending = new Map<
    number,
    { resolve: (result: { continue: boolean; data?: unknown }) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly healthPending = new Map<
    number,
    { resolve: (result: { healthy: boolean; message?: string }) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly channel: PluginWorkerChannel,
    // Runs a worker-initiated capability call host-side (validating permission + session scope before
    // the real verb). Absent => the worker has no capabilities (e.g. before the bridge is wired).
    private readonly capDispatcher?: (verb: string, args: unknown[]) => Promise<unknown>,
    // Called when the worker subscribes a handler to an event, so the host can register a shim with
    // the hook manager that dispatches into the worker.
    private readonly onHookSubscribe?: (event: string, priority?: number) => void,
    // Routes a worker plugin's ctx.logger.* call to the host's per-plugin logger.
    private readonly onLog?: (level: PluginLogLevel, message: string, meta?: Record<string, unknown>) => void,
  ) {
    this.channel.onMessage(message => this.handleMessage(message));
    this.channel.onExit(code => this.handleExit(code));
  }

  /**
   * Dispatch a hook event to the worker and await its handler result. Bounded by `timeoutMs`: if the
   * worker's handler is slow or wedged, this resolves `{ continue: true }` so the host's hook chain
   * is never stalled by an untrusted plugin (and `onTimeout` flags it for the caller).
   */
  dispatchHook(options: {
    event: string;
    data: unknown;
    source: string;
    sessionId?: string;
    config?: Record<string, unknown>;
    timeoutMs: number;
    onTimeout?: () => void;
  }): Promise<{ continue: boolean; data?: unknown }> {
    const id = this.nextId++;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.hookPending.delete(id);
        options.onTimeout?.();
        resolve({ continue: true });
      }, options.timeoutMs);
      this.hookPending.set(id, { resolve, timer });
      this.channel.postMessage({
        kind: 'hook',
        id,
        event: options.event,
        data: options.data,
        sessionId: options.sessionId,
        source: options.source,
        config: options.config,
      });
    });
  }

  /**
   * Load the plugin module in the worker; resolves once it reports `ready`, rejects if it errors.
   * When `timeoutMs` is given, a worker that never reports ready rejects the call (the caller then
   * tears the worker down) so a wedged module load can't hang enable forever.
   */
  load(mainPath: string, context?: SandboxStaticContext, timeoutMs?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(new Error('plugin worker is no longer running'));
      if (this.ready) return resolve();
      const waiter: { resolve: () => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> } = {
        resolve,
        reject,
      };
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const index = this.readyWaiters.indexOf(waiter);
          if (index !== -1) this.readyWaiters.splice(index, 1);
          reject(new Error(`plugin worker load timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.readyWaiters.push(waiter);
      this.channel.postMessage(context ? { kind: 'load', mainPath, context } : { kind: 'load', mainPath });
    });
  }

  /**
   * Invoke a plugin lifecycle method in the worker; resolves/rejects on the correlated result.
   * When `timeoutMs` is given, a method that never replies rejects the call so a wedged
   * onLoad/onEnable/onDisable can't hang the enable/disable request indefinitely.
   */
  runLifecycle(method: PluginLifecycleMethod, timeoutMs?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(new Error('plugin worker is no longer running'));
      const id = this.nextId++;
      const entry: { resolve: () => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> } = {
        resolve,
        reject,
      };
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`plugin worker lifecycle '${method}' timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.channel.postMessage({ kind: 'lifecycle', id, method });
    });
  }

  /** Push a config update to the worker so it refreshes ctx.config and runs onConfigChange. Fire-and-forget. */
  sendConfigChange(config: Record<string, unknown>): void {
    if (this.dead) return;
    this.channel.postMessage({ kind: 'config-change', config });
  }

  /**
   * Ask the worker plugin to run healthCheck(). Bounded by `timeoutMs`: a wedged plugin resolves to
   * unhealthy rather than hanging the health endpoint.
   */
  healthCheck(timeoutMs: number): Promise<{ healthy: boolean; message?: string }> {
    if (this.dead) return Promise.resolve({ healthy: false, message: 'plugin worker is no longer running' });
    const id = this.nextId++;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.healthPending.delete(id);
        resolve({ healthy: false, message: 'health check timed out' });
      }, timeoutMs);
      this.healthPending.set(id, { resolve, timer });
      this.channel.postMessage({ kind: 'health-check', id });
    });
  }

  /** Tear the worker down. */
  terminate(): Promise<void> {
    return this.channel.terminate();
  }

  private handleMessage(message: WorkerToHostMessage): void {
    switch (message.kind) {
      case 'ready':
        this.ready = true;
        this.drain(this.readyWaiters, w => {
          if (w.timer) clearTimeout(w.timer);
          w.resolve();
        });
        break;
      case 'error': {
        const error = new Error(message.error);
        this.drain(this.readyWaiters, w => {
          if (w.timer) clearTimeout(w.timer);
          w.reject(error);
        });
        break;
      }
      case 'lifecycle-result': {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (waiter.timer) clearTimeout(waiter.timer);
        if (message.ok) waiter.resolve();
        else waiter.reject(new Error(message.error));
        break;
      }
      case 'cap':
        void this.handleCapRequest(message);
        break;
      case 'hook-subscribe':
        this.onHookSubscribe?.(message.event, message.priority);
        break;
      case 'log':
        this.onLog?.(message.level, message.message, message.meta);
        break;
      case 'hook-result': {
        const waiter = this.hookPending.get(message.id);
        if (!waiter) return;
        this.hookPending.delete(message.id);
        clearTimeout(waiter.timer);
        const result: { continue: boolean; data?: unknown } = { continue: message.continue };
        if (message.data !== undefined) result.data = message.data;
        waiter.resolve(result);
        break;
      }
      case 'health-result': {
        const waiter = this.healthPending.get(message.id);
        if (!waiter) return;
        this.healthPending.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve({ healthy: message.healthy, message: message.message });
        break;
      }
    }
  }

  private async handleCapRequest(message: Extract<WorkerToHostMessage, { kind: 'cap' }>): Promise<void> {
    if (!this.capDispatcher) {
      this.channel.postMessage({ kind: 'cap-result', id: message.id, ok: false, error: 'no capability dispatcher' });
      return;
    }
    try {
      const result = await this.capDispatcher(message.verb, message.args);
      this.channel.postMessage({ kind: 'cap-result', id: message.id, ok: true, result });
    } catch (error) {
      this.channel.postMessage({
        kind: 'cap-result',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleExit(code: number): void {
    this.dead = true;
    const error = new Error(`plugin worker exited unexpectedly (code ${code})`);
    this.drain(this.readyWaiters, w => {
      if (w.timer) clearTimeout(w.timer);
      w.reject(error);
    });
    this.pending.forEach(waiter => {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    });
    this.pending.clear();
    this.healthPending.forEach(({ resolve, timer }) => {
      clearTimeout(timer);
      resolve({ healthy: false, message: 'plugin worker exited' });
    });
    this.healthPending.clear();
    // Drain in-flight hooks too (symmetry with the maps above): resolve {continue:true} — the same
    // fail-open value the per-hook timeout already produces — so the host hook chain unblocks
    // immediately on a worker crash instead of stalling for the full hook timeout per in-flight hook.
    this.hookPending.forEach(({ resolve, timer }) => {
      clearTimeout(timer);
      resolve({ continue: true });
    });
    this.hookPending.clear();
  }

  private drain<T>(waiters: T[], fn: (w: T) => void): void {
    const current = waiters.splice(0, waiters.length);
    current.forEach(fn);
  }
}
