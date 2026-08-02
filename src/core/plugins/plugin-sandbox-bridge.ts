import { ConfigService } from '@nestjs/config';
import { createLogger } from '../../common/services/logger.service';
import { HookManager, HookEvent, KNOWN_HOOK_EVENTS, isKnownHookEvent } from '../hooks';
import { PluginCapabilityPermission, PluginContext, PluginInstance, PluginStatus } from './plugin.interfaces';
import { PluginStorageService } from './plugin-storage.service';
import { PluginHostServices } from './plugin-host-services';
import { PluginCapabilityContext } from './plugin-capability-context';
import { isPluginActiveForSession, resolvePluginConfig } from './plugin-activation';
import { PluginWorkerHost } from './sandbox/plugin-worker-host';
import { dispatchCapabilityVerb } from './sandbox/capability-router';
import { PluginLogLevel } from './sandbox/protocol';
import { shouldDispatchToPlugin } from './handover-gate';
import { makeOnWebhookSubscribe } from './webhook-subscribe.util';
import { registerPluginSearchProvider, unregisterPluginSearchProvider } from './search-provider-registration.util';
import { INGRESS_DISPATCH_TIMEOUT_MS } from '../../modules/integration/integration.constants';
import type { IngressJobData } from '../../modules/queue/processors/ingress.processor';

/** Time budget for a sandboxed plugin's hook handler before the chain proceeds without it. */
const SANDBOX_HOOK_TIMEOUT_MS = 5000;
/** A sandboxed plugin's healthCheck must answer within this, else it's reported unhealthy (not hung). */
const SANDBOX_HEALTH_TIMEOUT_MS = 5000;
/** A sandboxed plugin's search handler must answer within this, else /search fails fast (not hung). */
const SANDBOX_SEARCH_TIMEOUT_MS = 10000;
/**
 * A sandboxed plugin's load()/onLoad/onEnable/onDisable must complete within this, else the worker is
 * torn down and the operation fails — a wedged lifecycle can't hang the enable/disable request (and
 * the ADMIN HTTP call behind it) forever. Generous on purpose: a slow-but-valid onEnable that opens
 * connections should still finish well under it.
 */
const SANDBOX_LIFECYCLE_TIMEOUT_MS = 30000;

/**
 * Rate limit for the structured sandboxed-hook error log: at most one line per event per window so a
 * hook that throws on every message can't flood the host log. Suppressed occurrences are counted and
 * ride the next emitted line.
 */
const SANDBOX_HOOK_ERROR_LOG_INTERVAL_MS = 60000;

/**
 * Worker log-relay bounds (per sandboxed plugin): at most this many lines per window are relayed;
 * excess is dropped, counted, and surfaced as one warn per window. Longer lines are truncated. The
 * worker is not a security boundary — these are robustness bounds against a chatty/buggy plugin
 * flooding the host log, not isolation.
 */
const SANDBOX_LOG_MAX_PER_WINDOW = 200;
const SANDBOX_LOG_WINDOW_MS = 10000;
const SANDBOX_LOG_MAX_MESSAGE_LENGTH = 8192;

/** Per-enable log-relay rate-limit window, shared by the onLog relay and the onWorkerExit final flush. */
interface SandboxLogRelayState {
  windowStart: number;
  count: number;
  dropped: number;
}

/**
 * The loader's protected createSandboxHost signature, as a factory type. The bridge receives it as a
 * closure and calls it exactly where enableSandboxed used to call the method.
 */
type CreateSandboxHostFn = (
  capDispatcher?: (verb: string, args: unknown[]) => Promise<unknown>,
  onHookSubscribe?: (event: string, priority?: number) => void,
  onWebhookSubscribe?: (route: string) => void,
  onLog?: (level: PluginLogLevel, message: string, meta?: Record<string, unknown>) => void,
  runWithHookGuard?: (inFlightEvents: string[], run: () => Promise<unknown>) => Promise<unknown>,
  onSearchProviderRegister?: () => void,
  onWorkerExit?: (code: number, intentional: boolean) => void,
) => PluginWorkerHost;

/**
 * The sandboxed-worker half of the plugin runtime: everything that speaks to an untrusted plugin's
 * worker thread. Spawning the host on enable (and tearing it down on disable), relaying the worker's
 * hook subscriptions, log lines and search-provider declaration back into the host, reacting to a
 * worker exit, and the health + ingress-webhook dispatch that route to a live worker.
 *
 * Split out of PluginLoaderService so the loader reads as registry + lifecycle while this IPC bridge
 * — the boundary an untrusted worker can actually poke — is reviewed on its own. A plain class, not
 * a Nest provider: the loader constructs it in its constructor with everything it needs (the same
 * pattern as PluginCapabilityContext), so the loader's public constructor signature — which specs
 * build directly — is unchanged.
 *
 * Two deliberate seams keep the uneditable specs working:
 *  - `createHost` is a closure over the loader's protected createSandboxHost, so a spec subclass that
 *    overrides that method still injects its fake/real worker host through the bridge.
 *  - `plugins`, `sandboxHosts` and `lastSandboxHookError` are the loader's own Maps, passed by
 *    reference: specs poke them on the loader via casts, and one shared (mutable) Map instance keeps
 *    the loader's view and the bridge's view the same map.
 */
export class PluginSandboxBridge {
  constructor(
    // The LOADER's logger, deliberately — sandbox-bridge lines carry the PluginLoaderService tag,
    // and that context is operator-visible. Creating a second logger here would silently retag every
    // sandbox log line the moment this moved out.
    private readonly logger: ReturnType<typeof createLogger>,
    private readonly hookManager: HookManager,
    private readonly capabilities: PluginCapabilityContext,
    private readonly hostServices: PluginHostServices,
    private readonly configService: ConfigService,
    private readonly pluginStorage: PluginStorageService,
    // The loader's own registry + sandbox state, passed BY REFERENCE (see the class doc): mutations
    // here are visible to the loader and to the specs that poke these Maps on it.
    private readonly plugins: Map<string, PluginInstance>,
    private readonly sandboxHosts: Map<string, PluginWorkerHost>,
    private readonly lastSandboxHookError: Map<string, { event: string; error: string; at: Date }>,
    private readonly pluginsDir: string,
    // Closure over the loader's protected createSandboxHost (see the class doc for the seam).
    private readonly createHost: CreateSandboxHostFn,
    // resolvePluginMainPath stays exported from the loader (specs import it there); passed in so this
    // file never has to import back from the loader, which would close an import cycle.
    private readonly resolvePluginMainPath: (pluginsDir: string, pluginId: string, main: string) => string,
  ) {}

  /**
   * Surface a sandboxed plugin's hook-handler failure host-side: record it for the plugin's health
   * surface and emit one structured warn per event per SANDBOX_HOOK_ERROR_LOG_INTERVAL_MS — a hook
   * that throws on every message must be visible, but must not become a log-flood vector. Suppressed
   * occurrences are counted and ride the next emitted line.
   */
  private recordSandboxHookError(
    pluginId: string,
    event: string,
    error: string,
    rateLimit: Map<string, { lastAt: number; suppressed: number }>,
  ): void {
    this.lastSandboxHookError.set(pluginId, { event, error, at: new Date() });
    const now = Date.now();
    const state = rateLimit.get(event);
    if (state && now - state.lastAt < SANDBOX_HOOK_ERROR_LOG_INTERVAL_MS) {
      state.suppressed++;
      return;
    }
    const suppressed = state?.suppressed ?? 0;
    rateLimit.set(event, { lastAt: now, suppressed: 0 });
    this.logger.warn(`Sandboxed plugin ${pluginId} hook '${event}' handler failed: ${error}`, {
      pluginId,
      event,
      action: 'sandbox_hook_error',
      ...(suppressed > 0 ? { suppressed } : {}),
    });
  }

  /**
   * Run a plugin's healthCheck across both tiers. A sandboxed plugin's healthCheck lives in the worker
   * (plugin.instance is null), so route to the live worker host (time-bounded); built-ins use the
   * in-process instance. Returns the default "healthy" when the plugin implements no health check.
   */
  async checkPluginHealth(pluginId: string): Promise<{ healthy: boolean; message?: string }> {
    const sandboxHost = this.sandboxHosts.get(pluginId);
    if (sandboxHost) {
      const result = await sandboxHost.healthCheck(SANDBOX_HEALTH_TIMEOUT_MS);
      // Attach the last hook-handler error the worker reported: a plugin whose hook throws on every
      // event can still answer healthCheck "healthy" while doing nothing useful. This is operator
      // context, not a verdict override — the worker's own healthCheck stays authoritative.
      const lastError = this.lastSandboxHookError.get(pluginId);
      if (!lastError) return result;
      const note = `last hook error in '${lastError.event}' at ${lastError.at.toISOString()}: ${lastError.error}`;
      return { healthy: result.healthy, message: result.message ? `${result.message}; ${note}` : note };
    }
    const plugin = this.plugins.get(pluginId);
    if (plugin?.instance?.healthCheck) {
      return plugin.instance.healthCheck();
    }
    return { healthy: true, message: 'Plugin does not implement health check' };
  }

  /**
   * Dispatch a queued ingress job into its plugin's live sandbox worker. Called from IngressProcessor,
   * mirroring checkPluginHealth's sandboxHosts lookup. Throws when the plugin has no live
   * worker (disabled/crashed since the job was enqueued) or when the worker's handler itself reports
   * failure (`!result.ok`, e.g. a 502/504/500) — either way BullMQ's retry/DLQ machinery takes over.
   */
  async dispatchWebhookForInstance(d: IngressJobData): Promise<void> {
    const host = this.sandboxHosts.get(d.pluginId);
    if (!host) {
      throw new Error('no live sandbox host for plugin ' + d.pluginId);
    }
    // Resolve this instance's per-session config (the base merged with the sessionScope override that
    // provisioning wrote) so the ingress handler reads it as ctx.config — this is what makes a minted
    // instance multi-tenant. Best-effort: an unresolved plugin just yields undefined (base config only).
    const plugin = this.plugins.get(d.pluginId);
    const route = plugin?.manifest.ingress?.find(candidate => candidate.route === d.route);
    // Reaching dispatch means every authenticating scheme already passed host verification. A route
    // explicitly configured with scheme:none is unauthenticated and must never be labelled verified.
    // Missing/hot-swapped route metadata fails closed.
    const verified = route ? route.signature.scheme !== 'none' : false;
    const instance = await this.hostServices.getPluginInstanceService().resolve(d.pluginId, d.instanceId);
    const config = plugin
      ? resolvePluginConfig(
          plugin.config,
          plugin.sessionConfig,
          instance?.sessionScope ?? undefined,
          plugin.manifest.sessionScoped !== false,
        )
      : undefined;
    const result = await host.dispatchWebhook({
      instanceId: d.instanceId,
      route: d.route,
      method: d.method ?? 'POST',
      headers: d.payload.headers,
      query: d.payload.query,
      body: d.payload.body,
      rawBody: d.payload.rawBody,
      verified,
      deliveryId: d.deliveryId,
      sessionId: d.sessionId,
      config,
      timeoutMs: INGRESS_DISPATCH_TIMEOUT_MS,
    });
    if (!result.ok) {
      throw new Error(result.error ?? 'ingress dispatch failed with status ' + result.status);
    }
  }

  /**
   * Untrusted enable: load the plugin in an isolated worker and drive its lifecycle there. Capability
   * calls and hooks round-trip to the host, which enforces permission + session scope. A failure
   * tears the worker back down.
   */
  async enableSandboxed(pluginId: string, plugin: PluginInstance): Promise<void> {
    // A new worker generation starts from a clean slate. disablePlugin clears this too, but a crash
    // and a failed enable both end a generation WITHOUT going through disable — so clearing only
    // there let the replacement worker inherit a dead one's hook error and report it through
    // checkPluginHealth as current. Enforced here, at the one point every generation begins, rather
    // than repeated on each way a generation can end.
    this.lastSandboxHookError.delete(pluginId);
    // Containment guard: reject a manifest.main that escapes the plugin dir.
    const mainPath = this.resolvePluginMainPath(this.pluginsDir, pluginId, plugin.manifest.main);
    // The capability dispatcher runs a worker request through the SAME context an in-process plugin
    // gets, so permission + session-scope checks (assertPermission / assertSessionActive) apply
    // identically. The worker can only ask; the host is the gatekeeper.
    const context = this.capabilities.createPluginContext(plugin);

    const onHookSubscribe = this.buildHookSubscribeHandler(pluginId, plugin);

    // When the worker claims an ingress route, record it against the manifest-declared routes so the
    // host knows which routes this worker will handle. Same hardening as onHookSubscribe (the wire
    // `route` is an arbitrary untrusted string): drop when the manifest lacks 'webhook:ingress', drop
    // an undeclared route (warn once), dedup, and cap. subscribedRoutes is local to this enable call,
    // so it is dropped on disable exactly as subscribedEvents is.
    const subscribedRoutes = new Set<string>();
    const declaredRoutes = new Set((plugin.manifest.ingress ?? []).map(r => r.route));
    const onWebhookSubscribe = makeOnWebhookSubscribe({
      pluginId,
      declaredRoutes,
      hasPermission: (plugin.manifest.permissions ?? []).includes(PluginCapabilityPermission.WEBHOOK_INGRESS),
      subscribed: subscribedRoutes,
      maxRoutes: declaredRoutes.size,
      warn: (message, meta) => this.logger.warn(message, meta),
    });

    const logRelayState: SandboxLogRelayState = { windowStart: Date.now(), count: 0, dropped: 0 };
    const onLog = this.buildLogRelay(pluginId, context, logRelayState);

    const onSearchProviderRegister = this.buildSearchProviderRegistrar(pluginId, plugin);

    const onWorkerExit = this.buildWorkerExitHandler(pluginId, logRelayState);

    const host = this.createHost(
      (verb, args) => dispatchCapabilityVerb(context, verb, args),
      onHookSubscribe,
      onWebhookSubscribe,
      onLog,
      // Re-establish the in-flight hook context for worker-initiated capability calls, so a sandboxed
      // plugin that sends from within a send hook can't loop the event back into itself unboundedly.
      (events, run) => this.hookManager.runInFlight(events as HookEvent[], run),
      onSearchProviderRegister,
      onWorkerExit,
    );
    this.sandboxHosts.set(pluginId, host);
    try {
      await host.load(mainPath, { pluginId, config: plugin.config }, SANDBOX_LIFECYCLE_TIMEOUT_MS);
      await host.runLifecycle('onLoad', SANDBOX_LIFECYCLE_TIMEOUT_MS);
      await host.runLifecycle('onEnable', SANDBOX_LIFECYCLE_TIMEOUT_MS);
    } catch (error) {
      this.sandboxHosts.delete(pluginId);
      // Drop a search provider registered mid-onEnable before the failure: without this, a plugin that
      // registers then throws leaves a dead provider as the ACTIVE registry entry in auto mode, so every
      // /search routes to a terminated worker → outage. Mirrors disablePlugin's cleanup.
      unregisterPluginSearchProvider(this.hostServices.getSearchRegistry(), pluginId);
      await host.terminate().catch(() => undefined);
      throw error;
    }
  }

  /**
   * The sandboxed half of disablePlugin: the loader found a live worker host, so the plugin's
   * onDisable (and, only on the unload path, onUnload) runs in the worker, bounded, before the worker
   * is terminated and dropped from sandboxHosts. The shared tail of disablePlugin — hook
   * unregistration, the search-provider drop, status persistence — stays in the loader because it
   * runs for in-process plugins too.
   */
  async teardownSandboxed(pluginId: string, host: PluginWorkerHost, opts?: { unload?: boolean }): Promise<void> {
    // Disable is a force-teardown: even if the plugin's onDisable hangs (now bounded) or throws,
    // we still kill the worker and drop the reference, so a misbehaving plugin can never block a
    // disable or leak its worker thread.
    try {
      await host.runLifecycle('onDisable', SANDBOX_LIFECYCLE_TIMEOUT_MS);
    } catch (error) {
      this.logger.warn(`Sandboxed plugin ${pluginId} onDisable failed during disable; terminating anyway`, {
        pluginId,
        action: 'sandbox_disable_lifecycle_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (opts?.unload) {
      // The worker is about to be terminated, so this is the ONLY chance onUnload ever gets for
      // a sandboxed plugin — after terminate the hook is unreachable, and unloadPlugin's
      // in-process call can't help (plugin.instance is null). Same bounded, best-effort policy
      // as onDisable above: a wedged/throwing onUnload must never block the teardown.
      try {
        await host.runLifecycle('onUnload', SANDBOX_LIFECYCLE_TIMEOUT_MS);
      } catch (error) {
        this.logger.warn(`Sandboxed plugin ${pluginId} onUnload failed during unload; terminating anyway`, {
          pluginId,
          action: 'sandbox_unload_lifecycle_failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await host.terminate().catch(() => undefined);
    this.sandboxHosts.delete(pluginId);
  }

  // When the worker subscribes to a hook, register a shim with the hook manager that dispatches the
  // event into the worker (time-bounded, so a wedged plugin can't stall the chain). The shim looks
  // the host up at fire time, so disabling the plugin (which removes it + unregisters hooks) stops it.
  // Harden the IPC boundary against an untrusted worker flooding the host hook registry. HookEvent is
  // a type-only union and the wire payload is an arbitrary string, so a hostile/buggy worker can post
  // 'hook-subscribe' with (a) the same event repeatedly and (b) unbounded fabricated event names
  // ('x:0','x:1',…). Without guards each call adds a live host-side registration (unbounded host-heap
  // growth + an O(n log n) re-sort). Three guards, all local to this enableSandboxed call (dropped on
  // disable): reject unknown events (bounds growth to the finite known set + drops events that can
  // never fire), dedup per event, and a belt-and-suspenders size cap.
  private buildHookSubscribeHandler(
    pluginId: string,
    plugin: PluginInstance,
  ): (event: string, priority?: number) => void {
    const subscribedEvents = new Set<HookEvent>();
    let unknownEventWarned = false;
    return (event: string, priority?: number): void => {
      if (!isKnownHookEvent(event)) {
        if (!unknownEventWarned) {
          unknownEventWarned = true; // warn at most once per plugin so a flood isn't a log-flood vector
          this.logger.warn(`Sandboxed plugin ${pluginId} subscribed to an unknown hook event; ignoring`, {
            pluginId,
            event,
            action: 'sandbox_unknown_hook_event',
          });
        }
        return;
      }
      if (subscribedEvents.has(event)) return;
      if (subscribedEvents.size >= KNOWN_HOOK_EVENTS.size) return; // can't exceed the known set
      subscribedEvents.add(event);
      // Per-event rate-limit state for the hook-error log; local to this enable call so it is dropped
      // on disable exactly like subscribedEvents.
      const hookErrorLogState = new Map<string, { lastAt: number; suppressed: number }>();
      this.hookManager.register(
        pluginId,
        event,
        async hookCtx => {
          const liveHost = this.sandboxHosts.get(pluginId);
          if (!liveHost) return { continue: true };
          // Per-session activation gate: a session-scoped plugin only sees events for the sessions
          // it is activated for. Pass-through (don't dispatch into the worker) otherwise.
          if (
            !isPluginActiveForSession(
              plugin.manifest.sessionScoped ?? true,
              plugin.activeSessions ?? ['*'],
              hookCtx.sessionId,
            )
          )
            return { continue: true };
          // Handover gate: once a human has taken over (or closed) a conversation, the bot stops
          // seeing its inbound messages. Scoped to message:received only — every other hook event is
          // unaffected. Best-effort + fail-open: a lookup failure (or an event/mapping shape the gate
          // can't resolve) must never block a normal message from reaching the adapter.
          if (event === 'message:received') {
            try {
              const chatId = (hookCtx.data as { chatId?: string } | undefined)?.chatId;
              if (chatId && hookCtx.sessionId) {
                const handover = await this.hostServices
                  .getConversationMappingService()
                  .findHandoverForChat(hookCtx.sessionId, chatId);
                if (!shouldDispatchToPlugin(handover, pluginId)) return { continue: true };
              }
            } catch (error) {
              this.logger.debug(`Handover gate lookup failed for plugin ${pluginId}; dispatching normally`, {
                pluginId,
                event,
                error: error instanceof Error ? error.message : String(error),
                action: 'handover_gate_fail_open',
              });
            }
          }
          return liveHost
            .dispatchHook({
              event,
              data: hookCtx.data,
              sessionId: hookCtx.sessionId,
              source: hookCtx.source,
              // The host resolves the per-session slice (real secrets — the worker is the plugin's
              // trusted execution context) and ships it; the worker exposes it as ctx.config.
              config: resolvePluginConfig(
                plugin.config,
                plugin.sessionConfig,
                hookCtx.sessionId,
                plugin.manifest.sessionScoped !== false,
              ),
              timeoutMs: SANDBOX_HOOK_TIMEOUT_MS,
              onTimeout: () =>
                this.logger.warn(`Sandboxed plugin ${pluginId} hook '${event}' timed out`, {
                  pluginId,
                  event,
                  action: 'sandbox_hook_timeout',
                }),
            })
            .then(result => {
              // The worker reports (not throws) a hook-handler failure: surface it host-side instead
              // of failing open in silence. The chain itself still proceeds fail-open.
              if (result.error) this.recordSandboxHookError(pluginId, event, result.error, hookErrorLogState);
              return { continue: result.continue, data: result.data };
            });
        },
        priority,
      );
    };
  }

  // Route the worker plugin's ctx.logger.* calls to the same per-plugin logger an in-process plugin
  // uses, so sandboxed plugins log identically (prefixed + structured) instead of bare stdout. The
  // relay is bounded: oversized lines are truncated and throughput is capped per window — a chatty
  // or buggy plugin must not flood the host log. Dropped lines are counted and surfaced as one warn
  // per window (never one line per drop, or the bound itself would be a flood vector), plus a final
  // flush on worker exit so a plugin that goes quiet first doesn't silently lose the count. State is
  // local to this enable call, so it resets on disable.
  private buildLogRelay(
    pluginId: string,
    context: PluginContext,
    state: SandboxLogRelayState,
  ): (level: PluginLogLevel, message: string, meta?: Record<string, unknown>) => void {
    return (level: PluginLogLevel, message: string, meta?: Record<string, unknown>): void => {
      const now = Date.now();
      if (now - state.windowStart >= SANDBOX_LOG_WINDOW_MS) {
        if (state.dropped > 0) {
          this.logger.warn(
            `Dropped ${state.dropped} log messages from sandboxed plugin ${pluginId} (log relay rate limit)`,
            { pluginId, action: 'sandbox_log_relay_dropped', dropped: state.dropped },
          );
        }
        state.windowStart = now;
        state.count = 0;
        state.dropped = 0;
      }
      state.count++;
      if (state.count > SANDBOX_LOG_MAX_PER_WINDOW) {
        state.dropped++;
        return;
      }
      const bounded =
        typeof message === 'string' && message.length > SANDBOX_LOG_MAX_MESSAGE_LENGTH
          ? `${message.slice(0, SANDBOX_LOG_MAX_MESSAGE_LENGTH)}…[truncated]`
          : message;
      if (level === 'error') context.logger.error(bounded, undefined, meta);
      else context.logger[level](bounded, meta);
    };
  }

  // When the worker declares itself a search provider (ctx.registerSearchProvider →
  // search-provider-register), register a PluginSearchProvider in the SearchProviderRegistry. The host
  // is in sandboxHosts by the time registration fires (during onLoad/onEnable), so look it up lazily
  // like onHookSubscribe. Search disabled (no registry, or SEARCH_PROVIDER=none) → the util skips, and
  // a manifest without 'search:provide' is denied there — the wire declaration is untrusted input, and
  // this bridge bypasses the capability router that gates the ctx.* capabilities.
  private buildSearchProviderRegistrar(pluginId: string, plugin: PluginInstance): () => void {
    return (): void => {
      const liveHost = this.sandboxHosts.get(pluginId);
      if (!liveHost) return;
      registerPluginSearchProvider({
        pluginId,
        label: `${plugin.manifest.name} (plugin)`,
        transport: liveHost,
        timeoutMs: SANDBOX_SEARCH_TIMEOUT_MS,
        registry: this.hostServices.getSearchRegistry(),
        mode: this.configService.get<string>('search.provider', 'auto'),
        hasPermission: (plugin.manifest.permissions ?? []).includes(PluginCapabilityPermission.SEARCH_PROVIDE),
        warn: (message, meta) => this.logger.warn(message, meta),
      });
    };
  }

  // A worker that crashes AFTER a successful enable is otherwise invisible to the loader (handleExit only
  // drains in-flight calls). Drop the plugin's search-provider entry so the registry falls back to
  // builtin-fts instead of routing every /search to a dead worker (auto mode would otherwise pin the dead
  // provider ACTIVE). Mirrors the enable-failure cleanup. Broader crash-lifecycle cleanup (status, hooks)
  // is a pre-existing gap for all bridges and out of scope here.
  private buildWorkerExitHandler(
    pluginId: string,
    logRelayState: SandboxLogRelayState,
  ): (code: number, intentional: boolean) => void {
    return (code: number, intentional: boolean): void => {
      // Final log-relay flush: the per-window drop warn above only fires when a new line arrives in a
      // later window, so without this a plugin that goes quiet (or is disabled) before the rollover
      // silently discards its pending count. The worker is gone, so no further lines can arrive.
      if (logRelayState.dropped > 0) {
        this.logger.warn(
          `Dropped ${logRelayState.dropped} log messages from sandboxed plugin ${pluginId} (log relay rate limit)`,
          { pluginId, action: 'sandbox_log_relay_dropped', dropped: logRelayState.dropped },
        );
        logRelayState.dropped = 0;
      }
      // Always release the search-provider slot so the registry can fall back to builtin-fts. On a crash
      // this is the only cleanup; on a deliberate disable/enable-failure the explicit unregister already
      // ran, making this a harmless no-op.
      unregisterPluginSearchProvider(this.hostServices.getSearchRegistry(), pluginId);
      if (intentional) return; // routine disable/enable-failure already logged and expected
      // Unexpected crash after a successful enable: the worker is gone. Drop the dead host +
      // unregister the hook shims (so they don't keep dispatching into the dead worker) + mark the
      // plugin ERROR so the dashboard reflects reality. The dispatchHook/dispatchWebhook dead-checks
      // fail-fast; this cleanup is the root-cause fix (it also makes the shim's !liveHost guard fire).
      const crashed = this.plugins.get(pluginId);
      if (crashed) {
        crashed.status = PluginStatus.ERROR;
        crashed.error = `worker exited unexpectedly (code ${code})`;
        this.pluginStorage.setPluginStatus(pluginId, PluginStatus.ERROR);
      }
      this.hookManager.unregisterPlugin(pluginId);
      this.sandboxHosts.delete(pluginId);
      this.logger.warn(`Sandboxed plugin ${pluginId} worker exited unexpectedly (code ${code})`, {
        pluginId,
        code,
        action: 'sandbox_worker_exit',
      });
    };
  }
}
