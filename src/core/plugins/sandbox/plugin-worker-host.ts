import { randomUUID } from 'crypto';
import {
  PluginWorkerChannel,
  PluginLifecycleMethod,
  WorkerToHostMessage,
  SandboxStaticContext,
  SandboxDispatchContext,
  PluginLogLevel,
  SEND_CAP_VERBS,
} from './protocol';
import type { SearchQuery, SearchResults } from '../../../modules/search/search.types';
import { createLogger } from '../../../common/services/logger.service';

const logger = createLogger('PluginWorkerHost');

/**
 * Capability verbs whose host-side work IS an outbound message send. A media send (the URL
 * download — itself bounded at 30s by MEDIA_DOWNLOAD_TIMEOUT_MS — then the WhatsApp upload) can
 * legitimately outrun the lookup-oriented capTimeoutMs, and a cap timeout does NOT cancel the
 * underlying work: the worker would record a failure while the message still lands, and a plugin
 * retrying on that error would deliver a duplicate. These verbs therefore get
 * SEND_CAP_TIMEOUT_FACTOR × the base budget (see withCapTimeout), so the timeout stays a "wedged
 * call" signal instead of firing inside normal execution. The in-flight bound is unchanged.
 */
// The budget of a send verb (SEND_CAP_VERBS) as a multiple of capTimeoutMs (default 30s → 120s: the 30s media download +
// upload headroom).
const SEND_CAP_TIMEOUT_FACTOR = 4;

/** Longest worker-reported error kept for an exit message and the plugin's status. */
const MAX_WORKER_ERROR_CHARS = 500;

/** Longest text a worker reports in a result that the host keeps or forwards, and what stands for a non-string. */
const MAX_WORKER_TEXT_CHARS = 8192;
const NON_STRING_WORKER_VALUE = '[non-string worker value]';

/**
 * The text of a field a worker filled in: a string, cut to a bounded length, or a fixed marker for anything else.
 * Plugin code can post any value, so nothing is turned into text (String(), a template, an Error message) before this.
 */
function workerText(value: unknown): string {
  if (typeof value !== 'string') return NON_STRING_WORKER_VALUE;
  return value.length > MAX_WORKER_TEXT_CHARS ? `${value.slice(0, MAX_WORKER_TEXT_CHARS)}…[truncated]` : value;
}

/**
 * Timed-out hook dispatches whose in-flight claim is still honoured, per worker. A handler that never
 * returns would otherwise keep one entry per dispatch for as long as the worker lives; past this many,
 * the oldest claim is given back.
 */
const MAX_LATE_HOOK_CLAIMS = 32;

/** Bounded cache sizing for per-dispatch deterministic send deduplication across webhook retries. */
const WEBHOOK_SEND_DEDUP_MAX = 1024;
const WEBHOOK_SEND_DEDUP_TTL_MS = 15 * 60 * 1000;
const MAX_NET_SCOPE_CACHE = 4096;

interface ActiveCapEntry {
  controller: AbortController;
  cancel?: (reason: Error) => void;
}

interface InFlightDispatchEntry {
  context: SandboxDispatchContext;
  hookEvent?: string;
  inFlight?: string[];
  kind: 'hook' | 'webhook';
  deadlineAt?: number;
  deliveryKey?: string;
  sendSeq: number;
  activeCaps: Set<ActiveCapEntry>;
}

interface WebhookSendDedupEntry {
  expiresAt: number;
  hasResolved: boolean;
  value?: unknown;
  pending?: Promise<unknown>;
}

/** Worker replies that finish a host request; one arriving during a liveness probe restarts its window. */
const PROGRESS_KINDS: ReadonlySet<WorkerToHostMessage['kind']> = new Set([
  'lifecycle-result',
  'hook-result',
  'webhook-result',
  'health-result',
  'search-result',
]);

/** Host-side capability dispatcher invoked for worker-initiated `cap` requests. */
export type CapabilityDispatcher = (
  verb: string,
  args: unknown[],
  dispatchContext?: SandboxDispatchContext,
  signal?: AbortSignal,
) => Promise<unknown>;

/**
 * Host-side driver for a single untrusted plugin running in a worker. Owns the request/response
 * correlation over a {@link PluginWorkerChannel}: it posts `load`/`lifecycle` messages and resolves
 * the matching promise when the worker replies, and fails every outstanding call if the worker dies.
 * Capability, hook, webhook, search and health traffic use their own correlated message kinds over
 * the same channel.
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
    {
      resolve: (result: { continue: boolean; data?: unknown; error?: string }) => void;
      timer: ReturnType<typeof setTimeout>;
    }
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
  // Dispatches that timed out host-side while their handler may still be running in the worker, oldest
  // first, each with the release of the in-flight claim it still holds. See holdLateClaim.
  private readonly lateHookClaims = new Map<number, () => void>();
  // Host-authoritative session/instance context and in-flight hook event chain for active hook
  // and webhook dispatches, keyed by a host-generated dispatchId. Looked up when a worker issues a
  // capability call so the host never trusts worker-supplied session, instance, or hook claims.
  private readonly inFlightDispatches = new Map<string, InFlightDispatchEntry>();
  // Bounded deterministic send-outcome cache keyed per webhook delivery & send ordinal (or explicit caller key)
  // so BullMQ retries never replay duplicate outbound sends when a previous attempt already sent or is still running.
  private readonly webhookSendDedups = new Map<string, WebhookSendDedupEntry>();
  // Active capability calls; cancelled (signal aborted + timeout timer cleared) on terminate() or exit.
  private readonly activeCaps = new Set<ActiveCapEntry>();
  // Host-minted opaque tokens mapping concrete hook sessionIds for floated off-dispatch net.fetch calls.
  private readonly sessionToNetScopeId = new Map<string, string>();
  private readonly netScopeIdToSession = new Map<string, string>();

  // Worker-initiated capability calls currently running host-side, bounded by maxInFlightCaps.
  private inFlightCaps = 0;
  // Capability calls that timed out host-side whose underlying promise has not yet settled.
  private unsettledTimedOutCaps = 0;
  // True once terminate() is called, so onExit can tell a deliberate kill (disable/enable-failure) from an
  // unexpected worker crash — only the latter is logged as a warning.
  private terminated = false;
  // The last error the worker reported (an uncaught exception arrives as one just before the exit), kept for
  // the exit: once the worker is ready no load() waits for it. Plugin-chosen text, so one bounded line.
  private lastWorkerError?: string;
  // The liveness probe in flight, if any, and whether onUnresponsive has already fired (it fires once).
  private probe?: { id: number; timer: ReturnType<typeof setTimeout> };
  private unresponsiveReported = false;
  // Timestamp of the last worker response proving its event loop turned (ready, pong, or dispatch result).
  private lastWorkerActivityAt = Date.now();
  // Optional periodic idle liveness check started once load() resolves ready; cleared on exit/terminate.
  private idleLivenessTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly channel: PluginWorkerChannel,
    // Runs a worker-initiated capability call host-side (validating permission + session scope before
    // the real verb). Absent => the worker has no capabilities (e.g. before the bridge is wired).
    private readonly capDispatcher?: CapabilityDispatcher,
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
    // `reason` is the last error the worker reported before it exited, when it reported one.
    private readonly onExit?: (code: number, intentional: boolean, reason?: string) => void,
    // Host-side budget for ONE capability call. A worker whose calls hang would otherwise hold its
    // in-flight slots forever (self-DoS once maxInFlightCaps are all wedged). On timeout the worker gets
    // an error cap-result, the call's AbortSignal is aborted, and the slot frees (while unsettled late
    // promises remain bounded). Absent/undefined => no per-call timeout (legacy behavior).
    private readonly capTimeoutMs?: number,
    // After a hook/webhook/search/health timeout (or idle interval), the host pings the worker and waits
    // this long for the pong the bootstrap sends before any plugin code runs. A full window with neither
    // the pong nor any other dispatch result means the worker's event loop is blocked (a slow async handler
    // still answers), and onUnresponsive is called once so the caller can terminate it. Either absent =>
    // no probing (legacy behavior).
    private readonly livenessTimeoutMs?: number,
    private readonly onUnresponsive?: () => void,
    // Optional interval (ms) for periodic idle liveness probing once load() reports ready. Defaults to 0
    // (disabled) so unit tests remain deterministic; production passes 30_000 ms.
    private readonly livenessIntervalMs = 0,
  ) {
    this.channel.onMessage(message => this.handleMessage(message));
    this.channel.onExit(code => this.handleExit(code));
  }

  private getOrCreateNetScopeId(sessionId: string): string {
    const existing = this.sessionToNetScopeId.get(sessionId);
    if (existing !== undefined) {
      this.sessionToNetScopeId.delete(sessionId);
      this.sessionToNetScopeId.set(sessionId, existing);
      this.netScopeIdToSession.delete(existing);
      this.netScopeIdToSession.set(existing, sessionId);
      return existing;
    }
    while (this.sessionToNetScopeId.size >= MAX_NET_SCOPE_CACHE) {
      const oldestSession = this.sessionToNetScopeId.keys().next().value;
      if (oldestSession === undefined) break;
      const oldestToken = this.sessionToNetScopeId.get(oldestSession);
      this.sessionToNetScopeId.delete(oldestSession);
      if (oldestToken !== undefined) this.netScopeIdToSession.delete(oldestToken);
    }
    const token = randomUUID();
    this.sessionToNetScopeId.set(sessionId, token);
    this.netScopeIdToSession.set(token, sessionId);
    return token;
  }

  /**
   * Dispatch a hook event to the worker and await its handler result. Bounded by `timeoutMs`: if the
   * worker's handler is slow or wedged, this resolves `{ continue: true }` so the host's hook chain
   * is never stalled by an untrusted plugin (and `onTimeout` flags it for the caller). When the worker
   * reports that one of its handlers threw, the resolved `error` carries the first failure so the
   * caller can surface it — the chain still fails open.
   */
  dispatchHook(options: {
    event: string;
    data: unknown;
    source: string;
    sessionId?: string;
    config?: Record<string, unknown>;
    // Events already in flight on the host's hook chain when this dispatch fires (the caller's
    // ancestors); forwarded so a capability call the handler makes is guarded against all of them.
    inFlight?: string[];
    failClosed?: boolean;
    timeoutMs: number;
    onTimeout?: () => void;
  }): Promise<{ continue: boolean; data?: unknown; error?: string }> {
    // Fail fast on a dead worker: a post-crash dispatchHook (the hook shim still holds the stale host
    // reference) would otherwise post to the dead worker and stall the chain for the full timeout before
    // resolving. Populating `error` lets fail-closed callers reject the send while fail-open callers continue.
    if (this.dead) return Promise.resolve({ continue: true, error: 'plugin worker is no longer running' });
    const id = this.nextId++;
    const dispatchId = randomUUID();
    const netScopeId =
      options.sessionId && options.sessionId !== '*' ? this.getOrCreateNetScopeId(options.sessionId) : undefined;
    const inFlight = [...new Set([...(options.inFlight ?? []), options.event])];
    this.inFlightDispatches.set(dispatchId, {
      context: { sessionId: options.sessionId },
      hookEvent: options.event,
      inFlight,
      kind: 'hook',
      sendSeq: 0,
      activeCaps: new Set(),
    });
    return new Promise((resolve, reject) => {
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        this.lateHookClaims.delete(id);
        this.inFlightDispatches.delete(dispatchId);
      };
      // settle gives the in-flight claim back on every exit path that ends the dispatch (the worker's
      // result, a late one included, or the crash drain) since it is what the hookPending entry's resolve
      // runs. Resolving a second time is a no-op, so a late result only releases the claim.
      const settle = (result: { continue: boolean; data?: unknown; error?: string }): void => {
        release();
        resolve(result);
      };
      const timer = setTimeout(() => {
        options.onTimeout?.();
        this.probeLiveness();
        // The chain moves on without this plugin, but its handler is still running in the worker, and
        // a capability call it makes from here on still names this dispatch. Retain both the in-flight
        // re-entrancy claim and the dispatch context until the late result arrives, eviction past
        // MAX_LATE_HOOK_CLAIMS, or worker exit.
        resolve({ continue: true, error: `hook timed out after ${options.timeoutMs}ms` });
        this.holdLateClaim(id, release);
      }, options.timeoutMs);
      this.hookPending.set(id, { resolve: settle, timer });
      try {
        this.channel.postMessage({
          kind: 'hook',
          id,
          dispatchId,
          ...(netScopeId ? { netScopeId } : {}),
          event: options.event,
          data: options.data,
          sessionId: options.sessionId,
          source: options.source,
          config: options.config,
          inFlight,
          ...(options.failClosed ? { failClosed: true } : {}),
        });
      } catch (error) {
        clearTimeout(timer);
        this.hookPending.delete(id);
        release();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Keep the claim of a timed-out dispatch until the worker answers it or exits, bounded by
   * {@link MAX_LATE_HOOK_CLAIMS}. The hookPending entry stays too, so the late result finds it.
   */
  private holdLateClaim(id: number, release: () => void): void {
    this.lateHookClaims.set(id, release);
    if (this.lateHookClaims.size <= MAX_LATE_HOOK_CLAIMS) return;
    const [oldest, giveBack] = this.lateHookClaims.entries().next().value as [number, () => void];
    const waiter = this.hookPending.get(oldest);
    if (waiter) clearTimeout(waiter.timer);
    this.hookPending.delete(oldest); // an answer this late is ignored
    giveBack();
  }

  /**
   * Dispatch a verified inbound webhook to the worker and await its handler result. Cloned from
   * dispatchHook and bounded by `timeoutMs`: a slow or wedged worker resolves ok:false with 504, and a
   * mid-dispatch worker crash is drained to 502 in handleExit. The ingress job throws on either, so the
   * queued delivery is retried or dead-lettered rather than waiting forever.
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
    dedupKey?: string;
    sessionId?: string;
    config?: Record<string, unknown>;
    timeoutMs: number;
    onTimeout?: () => void;
  }): Promise<{ status: number; headers?: Record<string, string>; body?: string; ok: boolean; error?: string }> {
    // Fail fast on a dead worker — mirrors the in-flight crash-drain's 502 (handleExit) so a post-crash
    // dispatchWebhook returns immediately instead of waiting the full timeout for a worker that's gone.
    if (this.dead) return Promise.resolve({ ok: false, status: 502 });
    const id = this.nextId++;
    const dispatchId = randomUUID();
    const effectiveDedupId = options.dedupKey ?? options.deliveryId;
    const deliveryKey = effectiveDedupId ? `${options.instanceId}:${options.route}:${effectiveDedupId}` : undefined;
    const dispatchEntry: InFlightDispatchEntry = {
      context: { sessionId: options.sessionId, instanceId: options.instanceId },
      kind: 'webhook',
      deadlineAt: Date.now() + options.timeoutMs,
      deliveryKey,
      sendSeq: 0,
      activeCaps: new Set(),
    };
    this.inFlightDispatches.set(dispatchId, dispatchEntry);
    return new Promise((resolve, reject) => {
      const settle = (result: {
        status: number;
        headers?: Record<string, string>;
        body?: string;
        ok: boolean;
        error?: string;
      }): void => {
        this.inFlightDispatches.delete(dispatchId);
        resolve(result);
      };
      const timer = setTimeout(() => {
        this.webhookPending.delete(id);
        this.inFlightDispatches.delete(dispatchId);
        const timeoutReason = new Error(`webhook dispatch timed out after ${options.timeoutMs}ms`);
        for (const cap of dispatchEntry.activeCaps) {
          if (!cap.controller.signal.aborted) {
            cap.controller.abort(timeoutReason);
          }
          cap.cancel?.(timeoutReason);
        }
        dispatchEntry.activeCaps.clear();
        options.onTimeout?.();
        this.probeLiveness();
        resolve({ ok: false, status: 504 }); // the ingress job retries or dead-letters the delivery
      }, options.timeoutMs);
      this.webhookPending.set(id, { resolve: settle, timer });
      try {
        this.channel.postMessage({
          kind: 'webhook',
          id,
          dispatchId,
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
      } catch (error) {
        clearTimeout(timer);
        this.webhookPending.delete(id);
        this.inFlightDispatches.delete(dispatchId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
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
        this.probeLiveness();
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
        this.probeLiveness();
        resolve({ healthy: false, message: 'health check timed out' });
      }, timeoutMs);
      this.healthPending.set(id, { resolve, timer });
      this.channel.postMessage({ kind: 'health-check', id });
    });
  }

  /**
   * Ask the worker whether its event loop is still turning. A dispatch timeout alone cannot tell a
   * slow async handler (harmless: its side effect still lands) from a synchronous loop that will never
   * yield and keeps queueing every later dispatch; the bootstrap answers a ping before plugin code, so
   * only the latter stays silent past livenessTimeoutMs.
   */
  private probeLiveness(): void {
    if (this.livenessTimeoutMs === undefined || !this.onUnresponsive) return;
    if (this.dead || this.terminated || this.probe || this.unresponsiveReported) return;
    const id = this.nextId++;
    this.armProbe(id);
    this.channel.postMessage({ kind: 'ping', id });
  }

  // (Re)start the probe window. The port is FIFO, so a worker working through a burst of dispatches
  // reads the ping only after that backlog; every result it sends meanwhile proves its loop is turning
  // and restarts the window (handleMessage). Only a full window with no answer at all is reported.
  // The verdict waits one loop turn: after a host-side stall the timers phase runs before the poll
  // phase that delivers port messages, so a pong already queued must be read before judging. A pong
  // or a re-arm handled in between replaces this.probe, which the timer comparison detects.
  private armProbe(id: number): void {
    if (this.probe) clearTimeout(this.probe.timer);
    const timer = setTimeout(
      () =>
        setImmediate(() => {
          if (this.probe?.timer !== timer) return;
          this.probe = undefined;
          if (this.dead || this.terminated || this.unresponsiveReported) return;
          this.unresponsiveReported = true;
          this.onUnresponsive?.();
        }),
      this.livenessTimeoutMs,
    );
    this.probe = { id, timer };
  }

  private startIdleLivenessMonitor(): void {
    if (
      this.idleLivenessTimer ||
      this.livenessIntervalMs <= 0 ||
      this.livenessTimeoutMs === undefined ||
      !this.onUnresponsive ||
      this.dead ||
      this.terminated
    ) {
      return;
    }
    const timer = setInterval(() => {
      if (this.dead || this.terminated || this.unresponsiveReported) {
        this.stopIdleLivenessMonitor();
        return;
      }
      if (this.probe) return;
      if (Date.now() - this.lastWorkerActivityAt >= this.livenessIntervalMs) {
        this.probeLiveness();
      }
    }, this.livenessIntervalMs);
    timer.unref?.();
    this.idleLivenessTimer = timer;
  }

  private stopIdleLivenessMonitor(): void {
    if (this.idleLivenessTimer) {
      clearInterval(this.idleLivenessTimer);
      this.idleLivenessTimer = undefined;
    }
  }

  private abortActiveCaps(reason: Error): void {
    const entries = [...this.activeCaps];
    this.activeCaps.clear();
    for (const entry of entries) {
      if (!entry.controller.signal.aborted) entry.controller.abort(reason);
      entry.cancel?.(reason);
    }
  }

  /** Tear the worker down. */
  terminate(): Promise<void> {
    this.terminated = true;
    this.stopIdleLivenessMonitor();
    this.abortActiveCaps(new Error('plugin worker terminated'));
    this.inFlightDispatches.clear();
    this.sessionToNetScopeId.clear();
    this.netScopeIdToSession.clear();
    return this.channel.terminate();
  }

  private handleMessage(message: WorkerToHostMessage): void {
    // Plugin code can post to parentPort directly, so a message is untrusted input. Anything that throws
    // here escapes the channel's listener as an uncaught exception and takes the whole host down.
    if (typeof message !== 'object' || message === null) return;
    try {
      this.routeMessage(message);
    } catch (error) {
      logger.warn(
        `Dropped a malformed sandbox worker message: ${error instanceof Error ? error.message : String(error)}`,
        { action: 'sandbox_worker_message_dropped' },
      );
    }
  }

  private routeMessage(message: WorkerToHostMessage): void {
    // Only answers to host requests count as progress: a synchronous loop can still post log, cap or
    // subscribe messages, but it cannot finish a dispatch.
    if (message.kind === 'ready' || message.kind === 'pong' || PROGRESS_KINDS.has(message.kind)) {
      this.lastWorkerActivityAt = Date.now();
    }
    if (this.probe && PROGRESS_KINDS.has(message.kind)) this.armProbe(this.probe.id);
    switch (message.kind) {
      case 'ready':
        this.ready = true;
        this.startIdleLivenessMonitor();
        this.drain(this.readyWaiters, w => {
          if (w.timer) clearTimeout(w.timer);
          w.resolve();
        });
        break;
      case 'error': {
        const text = workerText(message.error);
        this.lastWorkerError = text.replace(/\s+/g, ' ').slice(0, MAX_WORKER_ERROR_CHARS);
        const error = new Error(text);
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
        else waiter.reject(new Error(workerText(message.error)));
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
        if (typeof message.continue !== 'boolean') {
          waiter.resolve({ continue: true, error: 'malformed hook-result: continue must be a boolean' });
          break;
        }
        const result: { continue: boolean; data?: unknown; error?: string } = { continue: message.continue };
        if (message.data !== undefined) result.data = message.data;
        if (message.error !== undefined) {
          const formatted = workerText(message.error);
          result.error = formatted.trim().length > 0 ? formatted : 'sandbox hook failed';
        }
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
          error: message.error == null ? undefined : workerText(message.error),
        });
        break;
      }
      case 'health-result': {
        const waiter = this.healthPending.get(message.id);
        if (!waiter) return;
        this.healthPending.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve({
          // Plugin code returns what it likes; only a literal true reads as healthy.
          healthy: message.healthy === true,
          message: message.message === undefined ? undefined : workerText(message.message),
        });
        break;
      }
      case 'pong':
        if (this.probe?.id === message.id) {
          clearTimeout(this.probe.timer);
          this.probe = undefined;
        }
        break;
      case 'search-provider-register':
        this.onSearchProviderRegister?.();
        break;
      case 'search-result': {
        const waiter = this.searchPending.get(message.id);
        if (!waiter) return;
        this.searchPending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.ok) waiter.resolve({ ok: true, results: message.results });
        else waiter.resolve({ ok: false, error: workerText(message.error) });
        break;
      }
    }
  }

  private async handleCapRequest(message: Extract<WorkerToHostMessage, { kind: 'cap' }>): Promise<void> {
    if (this.dead || this.terminated) return;
    if (typeof message.verb !== 'string') {
      this.channel.postMessage({ kind: 'cap-result', id: message.id, ok: false, error: NON_STRING_WORKER_VALUE });
      return;
    }
    if (this.maxInFlightCaps !== undefined && this.inFlightCaps >= this.maxInFlightCaps) {
      this.channel.postMessage({
        kind: 'cap-result',
        id: message.id,
        ok: false,
        error: `capability call rejected: too many concurrent capability calls (limit ${this.maxInFlightCaps})`,
      });
      return;
    }
    if (
      this.maxInFlightCaps !== undefined &&
      this.inFlightCaps + this.unsettledTimedOutCaps >= this.maxInFlightCaps * 2
    ) {
      this.channel.postMessage({
        kind: 'cap-result',
        id: message.id,
        ok: false,
        error: `capability call rejected: too many unsettled timed-out capability calls (limit ${this.maxInFlightCaps * 2})`,
      });
      return;
    }
    if (!this.capDispatcher) {
      this.channel.postMessage({ kind: 'cap-result', id: message.id, ok: false, error: 'no capability dispatcher' });
      return;
    }
    let dispatchEntry: InFlightDispatchEntry | undefined;
    let dispatchContext: SandboxDispatchContext | undefined;
    if (message.dispatchId !== undefined) {
      if (typeof message.dispatchId !== 'string' || !this.inFlightDispatches.has(message.dispatchId)) {
        this.channel.postMessage({
          kind: 'cap-result',
          id: message.id,
          ok: false,
          error: 'capability call rejected: unknown or expired dispatch context',
        });
        return;
      }
      dispatchEntry = this.inFlightDispatches.get(message.dispatchId);
      dispatchContext = dispatchEntry?.context;
    } else if (message.verb === 'net.fetch' && message.netScopeId !== undefined) {
      if (typeof message.netScopeId !== 'string' || !this.netScopeIdToSession.has(message.netScopeId)) {
        this.channel.postMessage({
          kind: 'cap-result',
          id: message.id,
          ok: false,
          error: 'capability call rejected: unknown or expired net scope context',
        });
        return;
      }
      dispatchContext = { sessionId: this.netScopeIdToSession.get(message.netScopeId)! };
    }
    const controller = new AbortController();
    let cancelledByTeardown = false;
    const capEntry: ActiveCapEntry = {
      controller,
      cancel: () => {
        cancelledByTeardown = true;
      },
    };
    this.activeCaps.add(capEntry);
    dispatchEntry?.activeCaps.add(capEntry);
    this.inFlightCaps++;
    try {
      const dispatcher = this.capDispatcher;
      const run = (): Promise<unknown> => dispatcher(message.verb, message.args, dispatchContext, controller.signal);
      // Always derive guardedEvents strictly from the host-recorded dispatch entry. Calls without
      // a valid host-issued dispatchId (timers, lifecycle, or an untrusted worker stripping
      // dispatchId) carry no hook guard so a worker can never spoof inFlight claims across dispatches.
      const guardedEvents = dispatchEntry?.inFlight ? [...dispatchEntry.inFlight] : [];
      const execute = (): Promise<unknown> =>
        this.runWithHookGuard && guardedEvents.length > 0 ? this.runWithHookGuard(guardedEvents, run) : run();
      const work =
        dispatchEntry?.kind === 'webhook' && SEND_CAP_VERBS.has(message.verb)
          ? this.runWebhookSendWithDedup(dispatchEntry, message.dispatchId!, message.verb, message.args, execute)
          : execute();
      const result = await this.withCapTimeout(
        message.verb,
        work,
        capEntry,
        () => {
          cancelledByTeardown = true;
        },
        dispatchEntry?.kind === 'webhook' ? dispatchEntry.deadlineAt : undefined,
      );
      if (!cancelledByTeardown && !this.dead && !this.terminated) {
        this.channel.postMessage({ kind: 'cap-result', id: message.id, ok: true, result });
      }
    } catch (error) {
      if (!cancelledByTeardown && !this.dead && !this.terminated) {
        this.channel.postMessage({
          kind: 'cap-result',
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.activeCaps.delete(capEntry);
      dispatchEntry?.activeCaps.delete(capEntry);
      this.inFlightCaps--;
    }
  }

  private runWebhookSendWithDedup(
    dispatchEntry: InFlightDispatchEntry,
    dispatchId: string,
    verb: string,
    args: unknown[],
    execute: () => Promise<unknown>,
  ): Promise<unknown> {
    const firstArg = args[0] as { idempotencyKey?: unknown } | undefined;
    const explicitKey =
      typeof firstArg?.idempotencyKey === 'string' && firstArg.idempotencyKey.length > 0
        ? firstArg.idempotencyKey
        : undefined;
    const dedupKey = explicitKey
      ? `explicit:${dispatchEntry.deliveryKey ?? dispatchId}:${verb}:${explicitKey}`
      : dispatchEntry.deliveryKey
        ? `auto:${dispatchEntry.deliveryKey}:${verb}:${dispatchEntry.sendSeq++}`
        : undefined;
    if (!dedupKey) return execute();

    const now = Date.now();
    for (const [k, v] of this.webhookSendDedups) {
      if (v.expiresAt <= now && !v.pending) this.webhookSendDedups.delete(k);
    }

    const startFresh = (): Promise<unknown> => {
      while (this.webhookSendDedups.size >= WEBHOOK_SEND_DEDUP_MAX) {
        const oldest = this.webhookSendDedups.keys().next().value;
        if (oldest === undefined) break;
        this.webhookSendDedups.delete(oldest);
      }
      const record: WebhookSendDedupEntry = {
        expiresAt: Date.now() + WEBHOOK_SEND_DEDUP_TTL_MS,
        hasResolved: false,
      };
      const tracked = execute().then(
        value => {
          record.hasResolved = true;
          record.value = value;
          record.pending = undefined;
          return value;
        },
        err => {
          if (this.webhookSendDedups.get(dedupKey) === record) {
            this.webhookSendDedups.delete(dedupKey);
          }
          record.pending = undefined;
          throw err;
        },
      );
      tracked.catch(() => undefined);
      record.pending = tracked;
      this.webhookSendDedups.set(dedupKey, record);
      return tracked;
    };

    const existing = this.webhookSendDedups.get(dedupKey);
    if (existing && existing.expiresAt > now) {
      if (existing.hasResolved) return Promise.resolve(existing.value);
      if (existing.pending) {
        return existing.pending.catch(() => startFresh());
      }
    }
    return startFresh();
  }

  /**
   * Bound one capability call host-side. On timeout the caller (the worker) gets an error cap-result,
   * the call's AbortSignal is aborted, and the in-flight slot frees so a plugin whose calls hang can't
   * wedge all maxInFlightCaps slots into a self-DoS. If the underlying verb does not support cancellation,
   * its unsettled promise is counted against unsettledTimedOutCaps (capped at 2 * maxInFlightCaps combined
   * with inFlightCaps) and WARN-logged once it eventually settles. Send verbs (SEND_CAP_VERBS) run on a
   * wider budget that covers normal execution unless bounded by an active webhook deadline.
   */
  private withCapTimeout(
    verb: string,
    work: Promise<unknown>,
    entry: ActiveCapEntry,
    onTeardownCancel?: () => void,
    dispatchDeadlineAt?: number,
  ): Promise<unknown> {
    const configuredTimeoutMs =
      this.capTimeoutMs === undefined
        ? undefined
        : SEND_CAP_VERBS.has(verb)
          ? this.capTimeoutMs * SEND_CAP_TIMEOUT_FACTOR
          : this.capTimeoutMs;
    const remainingMs = dispatchDeadlineAt !== undefined ? Math.max(0, dispatchDeadlineAt - Date.now()) : undefined;
    const timeoutMs =
      configuredTimeoutMs !== undefined && remainingMs !== undefined
        ? Math.min(configuredTimeoutMs, remainingMs)
        : (configuredTimeoutMs ?? remainingMs);
    if (timeoutMs === undefined) return work;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        entry.cancel = undefined;
        this.activeCaps.delete(entry);
        this.unsettledTimedOutCaps++;
        if (!entry.controller.signal.aborted) {
          entry.controller.abort(new Error(`capability '${verb}' timed out after ${timeoutMs}ms`));
        }
        // Late settle: warn exactly once, whichever way the work ends, and release the unsettled slot.
        // These handlers also keep a late rejection from surfacing as an unhandled promise rejection.
        work.then(
          () => {
            this.unsettledTimedOutCaps = Math.max(0, this.unsettledTimedOutCaps - 1);
            if (!this.dead && !this.terminated) {
              this.onLog?.(
                'warn',
                `capability '${verb}' settled after the ${timeoutMs}ms host timeout; its late result was discarded`,
                { action: 'sandbox_cap_late_settle', verb },
              );
            }
          },
          (error: unknown) => {
            this.unsettledTimedOutCaps = Math.max(0, this.unsettledTimedOutCaps - 1);
            if (!this.dead && !this.terminated) {
              this.onLog?.(
                'warn',
                `capability '${verb}' failed after the ${timeoutMs}ms host timeout: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                { action: 'sandbox_cap_late_settle', verb },
              );
            }
          },
        );
        reject(new Error(`capability '${verb}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      entry.cancel = (reason: Error) => {
        if (settled) return;
        settled = true;
        entry.cancel = undefined;
        onTeardownCancel?.();
        clearTimeout(timer);
        // Swallow any late settlement after worker teardown so a hung promise never triggers
        // an unhandled rejection or post-teardown warning.
        work.then(
          () => undefined,
          () => undefined,
        );
        reject(reason);
      };
      work.then(
        result => {
          if (settled) return;
          settled = true;
          entry.cancel = undefined;
          clearTimeout(timer);
          resolve(result);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          entry.cancel = undefined;
          clearTimeout(timer);
          // The worker sees the dispatcher's failure verbatim when it is an Error; wrap anything else
          // (a hostile/buggy dispatcher rejecting with a non-Error must not break the wire shape).
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private handleExit(code: number): void {
    this.dead = true;
    this.stopIdleLivenessMonitor();
    this.abortActiveCaps(new Error(`plugin worker exited (code ${code})`));
    this.inFlightDispatches.clear();
    this.sessionToNetScopeId.clear();
    this.netScopeIdToSession.clear();
    if (this.probe) {
      clearTimeout(this.probe.timer);
      this.probe = undefined;
    }
    const error = new Error(
      `plugin worker exited unexpectedly (code ${code})${this.lastWorkerError ? `: ${this.lastWorkerError}` : ''}`,
    );
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
    // Drain in-flight hooks too (symmetry with the maps above): carry an explicit error reason so
    // fail-closed callers can reject while fail-open callers unblock immediately on a worker crash
    // instead of stalling for the full hook timeout per in-flight hook.
    this.hookPending.forEach(({ resolve, timer }) => {
      clearTimeout(timer);
      resolve({ continue: true, error: 'plugin worker exited during hook dispatch' });
    });
    this.hookPending.clear();
    // Drain in-flight webhooks: a mid-dispatch worker crash returns 502 so the ingress job fails the
    // delivery now. (The per-dispatch timeout would eventually resolve 504, but the job should not
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
    this.onExit?.(code, this.terminated, this.lastWorkerError);
  }

  private drain<T>(waiters: T[], fn: (w: T) => void): void {
    const current = waiters.splice(0, waiters.length);
    current.forEach(fn);
  }
}
