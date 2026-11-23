/**
 * Wire protocol between the host (PluginWorkerHost) and a plugin worker.
 *
 * These messages are the worker's channel to the `ctx.*` capabilities, and the host validates every
 * request against the manifest's permissions before acting on it. They are not the worker's only way
 * out: the worker is a thread in the host process and can use Node built-ins directly, so this is
 * fault containment, not a security boundary (see worker-bootstrap.ts and docs/30).
 *
 * Covers the lifecycle, capability calls, hooks, ingress webhooks, search, health checks and the
 * liveness ping.
 */

import type { SearchQuery, SearchResults } from '../../../modules/search/search.types';
import type { HookEvent } from '../../hooks/hook.interfaces';

export type PluginLifecycleMethod = 'onLoad' | 'onEnable' | 'onDisable' | 'onUnload';

/** Static context fields handed to a sandboxed plugin at load (serializable; no live references). */
export interface SandboxStaticContext {
  pluginId: string;
  config: Record<string, unknown>;
}

/** Host-authoritative dispatch context (firing hook session or ingress instance) for a worker request. */
export interface SandboxDispatchContext {
  sessionId?: string;
  instanceId?: string;
}

export type PluginLogLevel = 'log' | 'debug' | 'warn' | 'error';

/**
 * Bound on the `ctx.logger.*` lines one plugin gets across to the host: the worker sends at most this many per
 * window and drops the rest on its own thread, so a loop that logs without yielding costs the host no more than
 * the lines it writes. The host's log relay keeps the same bound as a backstop.
 */
export const SANDBOX_LOG_MAX_PER_WINDOW = 200;
export const SANDBOX_LOG_WINDOW_MS = 10000;

/**
 * Max worker-initiated capability calls the host runs concurrently per sandboxed plugin. A burst beyond this is
 * rejected (the plugin sees a thrown Error) rather than amplified into unbounded host-side sends/fetches/writes.
 */
export const SANDBOX_MAX_INFLIGHT_CAPS = 32;

/**
 * Capability calls a worker leaves unanswered before it holds the next one back. Twice the host's bound, so the host's
 * own bound is still the one a slow verb meets first. A loop that does not await its calls stops posting here: each
 * message past the host's bound is still read and answered on the host's one thread, so a call past this waits in the
 * worker until a reply frees a slot, in the order the plugin made the calls.
 */
export const SANDBOX_MAX_PENDING_CAPS = SANDBOX_MAX_INFLIGHT_CAPS * 2;

/**
 * Capability calls a worker holds back at once, past SANDBOX_MAX_PENDING_CAPS. A loop that never yields fills this
 * queue in the worker's own heap, and the call past it is refused, so the host is handed no more than
 * SANDBOX_MAX_PENDING_CAPS messages while the loop runs.
 */
export const SANDBOX_MAX_HELD_CAPS = 10000;

/**
 * Capability verbs whose host-side work is an outbound message send. A send fires the hooks of the send (message:sending
 * and the rest), so a hook handler that issues one can cause a dispatch of its own event again, and the host gives these
 * verbs a wider timeout budget than a lookup.
 */
export const SEND_CAP_VERBS: ReadonlySet<string> = new Set([
  'messages.sendText',
  'messages.reply',
  'conversation.send',
]);

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
      dispatchId?: string;
      event: string;
      data: unknown;
      sessionId?: string;
      source: string;
      config?: Record<string, unknown>;
      // The host's in-flight hook chain for this dispatch (this event plus any ancestor event whose
      // handler led to it). The worker echoes it on every capability call the handler makes, so the
      // host re-establishes the re-entrancy guard for that causal chain only.
      inFlight?: string[];
      /** True when the host chain is executing in fail-closed mode for this dispatch. */
      failClosed?: boolean;
    }
  // The plugin's config was updated: refresh ctx.config and invoke onConfigChange (fire-and-forget).
  | { kind: 'config-change'; config: Record<string, unknown> }
  // Ask the worker plugin to run its healthCheck(); it replies with health-result.
  | { kind: 'health-check'; id: number }
  // Dispatch an inbound webhook to the worker for a route it subscribed to (webhook-subscribe).
  // `body`/`rawBody` are buffered host-side to a string, like PluginNetResponse.body. `verified`
  // reflects whether the host authenticated the delivery via the route's signature scheme; it is
  // false for scheme:none, and on hmac-sha256 and standard-webhooks for an empty body with a query
  // string. No scheme signs the query or the method, so neither is authenticated even when it is true.
  // PluginIngressRoute.verify:'self' is reserved and does not trigger a second worker-side verification
  // pass. The worker replies with webhook-result.
  | {
      kind: 'webhook';
      id: number;
      dispatchId?: string;
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
      // Per-instance-resolved config for this delivery (like the `hook` message's config). The worker
      // exposes it as ctx.config for the duration of the handler via hookConfigStore.
      config?: Record<string, unknown>;
    }
  // Host→Worker: dispatch a search query to a plugin that registered as a SearchProvider. The worker
  // runs the plugin's search handler and replies with `search-result` (same `id` correlation as
  // hook/health-check/webhook). No per-session config: search is a global query; session scoping travels
  // inside SearchQuery.sessionIds (scoped by SearchService from the caller's API-key).
  | { kind: 'search'; id: number; query: SearchQuery }
  // Liveness probe, sent after a dispatch times out. The worker bootstrap answers it before any plugin
  // code runs, so a slow async handler still answers and only a blocked event loop stays silent.
  | { kind: 'ping'; id: number };

export type WorkerToHostMessage =
  | { kind: 'ready' }
  | { kind: 'lifecycle-result'; id: number; ok: true }
  | { kind: 'lifecycle-result'; id: number; ok: false; error: string }
  // Worker-initiated capability call (ctx.messages.* / ctx.engine.* / ctx.storage.*). The host
  // validates it (permission + session scope) before running the real verb and replying.
  // `inFlight` is the chain of the hook dispatch whose handler issued the call (absent outside a hook,
  // e.g. an ingress handler or a timer); the host trusts only events it actually dispatched.
  // `dispatchId` echoes the host-generated id of the active hook or webhook dispatch so the host can
  // look up its authoritative session/instance context without trusting worker-supplied identifiers.
  // `originHook` names the hook event whose handler initiated the call; the host verifies it against
  // the active dispatch tracked in inFlightDispatches before re-establishing hook context.
  | {
      kind: 'cap';
      id: number;
      verb: string;
      args: unknown[];
      inFlight?: string[];
      dispatchId?: string;
      originHook?: HookEvent;
    }
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
  // The worker's result for a dispatched webhook; `error` set = the handler threw. The ingress job treats
  // a non-ok result as a failed delivery and retries it.
  | {
      kind: 'webhook-result';
      id: number;
      status: number;
      headers?: Record<string, string>;
      body?: string;
      error?: string;
    }
  // The plugin called ctx.registerSearchProvider → the worker tells the host "I provide search." The host
  // then creates a PluginSearchProvider wrapping this worker and registers it in SearchProviderRegistry.
  | { kind: 'search-provider-register' }
  // The worker's search-handler result for a host `search` request. ok:true carries SearchResults; ok:false
  // carries the handler's error (handler threw / no handler / etc.).
  | { kind: 'search-result'; id: number; ok: true; results: SearchResults }
  | { kind: 'search-result'; id: number; ok: false; error: string }
  | { kind: 'pong'; id: number }
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
