import {
  PluginWorkerChannel,
  PluginLifecycleMethod,
  WorkerToHostMessage,
  SandboxStaticContext,
  PluginLogLevel,
} from './protocol';
import type { SearchQuery, SearchResults } from '../../../modules/search/search.types';

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
  private readonly webhookPending = new Map<
    number,
    {
      resolve: (result: {
        status: number;
        headers?: Record<string, string>;
        body?: string;
        ok: boolean;
        error?: string;
      }) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly healthPending = new Map<
    number,
    { resolve: (result: { healthy: boolean; message?: string }) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly searchPending = new Map<
    number,
    {
      resolve: (result: { ok: true; results: SearchResults } | { ok: false; error: string }) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  // Hook events currently dispatched to the worker and not yet settled, as a multiset. While the
  // worker handles a hook it may issue capability calls that round-trip to the host; those run inside
  // this in-flight set so a capability that re-fires the same event is short-circuited (HookManager's
  // AsyncLocalStorage re-entrancy guard does not span the worker IPC boundary).
  private readonly inFlightHookEvents = new Map<string, number>();

  // Worker-initiated capability calls currently running host-side, bounded by maxInFlightCaps.
  private inFlightCaps = 0;
  // True once terminate() is called, so onExit can tell a deliberate kill (disable/enable-failure) from an
  // unexpected worker crash — only the latter is logged as a warning.
  private terminated = false;

  constructor(
    private readonly channel: PluginWorkerChannel,
    // Runs a worker-initiated capability call host-side (validating permission + session scope before
    // the real verb). Absent => the worker has no capabilities (e.g. before the bridge is wired).
    private readonly capDispatcher?: (verb: string, args: unknown[]) => Promise<unknown>,
    // Called when the worker subscribes a handler to an event, so the host can register a shim with
    // the hook manager that dispatches into the worker.
    private readonly onHookSubscribe?: (event: string, priority?: number) => void,
    // Called when the worker claims an ingress route (registered a webhook handler for it), so the
    // host can record it against the manifest-declared routes (mirrors onHookSubscribe for ingress).
    private readonly onWebhookSubscribe?: (route: string) => void,
    // Routes a worker plugin's ctx.logger.* call to the host's per-plugin logger.
    private readonly onLog?: (level: PluginLogLevel, message: string, meta?: Record<string, unknown>) => void,
    // Runs a worker-initiated capability call inside the in-flight hook context, so a capability that
    // re-fires an event this worker is currently handling is short-circuited (re-entrancy across IPC).
    // Absent => capability calls run with no hook guard (e.g. before the bridge is wired, or in tests).
    private readonly runWithHookGuard?: (inFlightEvents: string[], run: () => Promise<unknown>) => Promise<unknown>,
    // Max worker-initiated capability calls the host will run concurrently for this worker. When this many
    // cap requests are in flight, further cap messages are rejected with an error cap-result (the worker
    // sees a thrown Error) instead of queuing host-side work — bounding the aggregate sendText/net.fetch/
    // storage load a single sandboxed plugin can trigger. Absent/undefined => no cap (legacy behavior).
    private readonly maxInFlightCaps?: number,
    // Called when the worker sends `search-provider-register` (the plugin called ctx.registerSearchProvider),
    // so the host can create a PluginSearchProvider and register it. Mirrors onHookSubscribe /
    // onWebhookSubscribe for the search bridge. Absent => the host ignores the declaration (e.g. tests).
    private readonly onSearchProviderRegister?: () => void,
    // Called once after the worker exits (crash or terminate), after in-flight calls are drained, so the
    // loader can release plugin-owned host resources (e.g. unregister a search provider the worker declared).
    private readonly onExit?: (code: number, intentional: boolean) => void,
  ) {
    this.channel.onMessage(message => this.handleMessage(message));
    this.channel.onExit(code => this.handleExit(code));
  }

  private incInFlightHook(event: string): void {
    this.inFlightHookEvents.set(event, (this.inFlightHookEvents.get(event) ?? 0) + 1);
  }

  private decInFlightHook(event: string): void {
    const count = this.inFlightHookEvents.get(event);
    if (count === undefined) return;
    if (count <= 1) this.inFlightHookEvents.delete(event);
    else this.inFlightHookEvents.set(event, count - 1);
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
    this.incInFlightHook(options.event);
    return new Promise(resolve => {
      // settle decrements the in-flight counter on every exit path (worker result, timeout, or crash
      // drain) since it is what the hookPending entry's resolve runs.
      const settle = (result: { continue: boolean; data?: unknown }): void => {
        this.decInFlightHook(options.event);
        resolve(result);
      };
      const timer = setTimeout(() => {
        this.hookPending.delete(id);
        options.onTimeout?.();
        settle({ continue: true });
      }, options.timeoutMs);
      this.hookPending.set(id, { resolve: settle, timer });
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
   * Dispatch a verified inbound webhook to the worker and await its handler result. Cloned from
   * dispatchHook: bounded by `timeoutMs`, and fail-open — a slow or wedged worker resolves a default
   * 504 (the provider was already ack'd in async mode) rather than hanging the HTTP request. A
   * mid-request worker crash is drained to 502 in handleExit, so the request never hangs forever.
   */
  dispatchWebhook(options: {
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
    config?: Record<string, unknown>;
    timeoutMs: number;
    onTimeout?: () => void;
  }): Promise<{ status: number; headers?: Record<string, string>; body?: string; ok: boolean; error?: string }> {
    const id = this.nextId++;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.webhookPending.delete(id);
        options.onTimeout?.();
        resolve({ ok: false, status: 504 }); // fail-open: provider already ack'd in async mode
      }, options.timeoutMs);
      this.webhookPending.set(id, { resolve, timer });
      this.channel.postMessage({
        kind: 'webhook',
        id,
        instanceId: options.instanceId,
        route: options.route,
        method: options.method,
        headers: options.headers,
        query: options.query,
        body: options.body,
        rawBody: options.rawBody,
        verified: options.verified,
        deliveryId: options.deliveryId,
        sessionId: options.sessionId,
        config: options.config,
      });
    });
  }

  /**
   * Dispatch a search query to a plugin that registered as a SearchProvider and await its result.
   * Bounded by `timeoutMs`: a slow/wedged worker resolves ok:false (the caller throws) rather than
   * hanging the /search request. A mid-search worker crash is drained to ok:false in handleExit.
   */
  dispatchSearch(options: {
    query: SearchQuery;
    timeoutMs: number;
  }): Promise<{ ok: true; results: SearchResults } | { ok: false; error: string }> {
    if (this.dead) return Promise.resolve({ ok: false, error: 'plugin worker is no longer running' });
    const id = this.nextId++;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.searchPending.delete(id);
        resolve({ ok: false, error: 'search timed out' });
      }, options.timeoutMs);
      this.searchPending.set(id, { resolve, timer });
      this.channel.postMessage({ kind: 'search', id, query: options.query });
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
    this.terminated = true;
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
      case 'webhook-subscribe':
        this.onWebhookSubscribe?.(message.route);
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
      case 'webhook-result': {
        const waiter = this.webhookPending.get(message.id);
        if (!waiter) return;
        this.webhookPending.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve({
          ok: message.error == null,
          status: message.status,
          headers: message.headers,
          body: message.body,
          error: message.error,
        });
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
      case 'search-provider-register':
        this.onSearchProviderRegister?.();
        break;
      case 'search-result': {
        const waiter = this.searchPending.get(message.id);
        if (!waiter) return;
        this.searchPending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.ok) waiter.resolve({ ok: true, results: message.results });
        else waiter.resolve({ ok: false, error: message.error });
        break;
      }
    }
  }

  private async handleCapRequest(message: Extract<WorkerToHostMessage, { kind: 'cap' }>): Promise<void> {
    if (this.maxInFlightCaps !== undefined && this.inFlightCaps >= this.maxInFlightCaps) {
      this.channel.postMessage({
        kind: 'cap-result',
        id: message.id,
        ok: false,
        error: `capability call rejected: too many concurrent capability calls (limit ${this.maxInFlightCaps})`,
      });
      return;
    }
    if (!this.capDispatcher) {
      this.channel.postMessage({ kind: 'cap-result', id: message.id, ok: false, error: 'no capability dispatcher' });
      return;
    }
    this.inFlightCaps++;
    try {
      const dispatcher = this.capDispatcher;
      const run = (): Promise<unknown> => dispatcher(message.verb, message.args);
      // Run inside the in-flight hook context so a capability that re-fires an event this worker is
      // currently handling is short-circuited by HookManager's re-entrancy guard (which otherwise
      // can't see across the IPC boundary). No hooks in flight => run directly, no wrapping cost.
      const inFlight = [...this.inFlightHookEvents.keys()];
      const result =
        this.runWithHookGuard && inFlight.length > 0 ? await this.runWithHookGuard(inFlight, run) : await run();
      this.channel.postMessage({ kind: 'cap-result', id: message.id, ok: true, result });
    } catch (error) {
      this.channel.postMessage({
        kind: 'cap-result',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlightCaps--;
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
    // Drain in-flight webhooks: a mid-request worker crash must return 502, never hang the HTTP
    // request. (The per-request timeout would eventually fail-open to 504, but the request should not
    // wait the full window when the worker is already known dead.)
    this.webhookPending.forEach(({ resolve, timer }) => {
      clearTimeout(timer);
      resolve({ ok: false, status: 502 });
    });
    this.webhookPending.clear();
    // Drain in-flight searches: a mid-query worker crash must reject (ok:false) so the /search caller
    // gets an error instead of waiting the full timeout for a worker that is already dead.
    this.searchPending.forEach(({ resolve, timer }) => {
      clearTimeout(timer);
      resolve({ ok: false, error: 'plugin worker exited' });
    });
    this.searchPending.clear();
    this.onExit?.(code, this.terminated);
  }

  private drain<T>(waiters: T[], fn: (w: T) => void): void {
    const current = waiters.splice(0, waiters.length);
    current.forEach(fn);
  }
}
