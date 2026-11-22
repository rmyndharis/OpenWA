import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '../../common/services/logger.service';
import { AsyncLocalStorage } from 'node:async_hooks';
import { types } from 'node:util';
import { HookEvent, HookHandler, HookContext, HookRegistration } from './hook.interfaces';

/** Pre-egress hook events covered by `HOOK_PRE_EGRESS_FAIL_CLOSED`. */
export const PRE_EGRESS_HOOK_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>(['message:sending', 'webhook:before']);

/**
 * Internal symbol attached non-enumerably to `HookContext` during `HookManager.runHandlers` so
 * host-side bridges (such as `PluginSandboxBridge`) observe whether the active chain runs in
 * fail-closed mode without exposing a public field to plugin user code.
 */
export const HOOK_FAIL_CLOSED_SYMBOL: unique symbol = Symbol('openwa.hookFailClosed');

/**
 * Thrown when fail-closed hook execution is active and a plugin handler throws, reports an error,
 * or returns a payload rejected by `options.accept`.
 */
export class HookExecutionError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly event: HookEvent,
    cause?: unknown,
  ) {
    const suffix = cause !== undefined ? `: ${safeFormatHookError(cause)}` : '';
    super(`Hook '${event}' failed in plugin '${pluginId}'${suffix}`, cause !== undefined ? { cause } : undefined);
    this.name = 'HookExecutionError';
  }
}

/**
 * The priority a registration actually runs at: a finite number as given, anything else the default
 * 100. The chain is sorted by `a.priority - b.priority`; one NaN or string in it makes the comparator
 * return NaN and the order of EVERY handler for that event implementation-defined (a veto can land
 * after a rewrite). Sandboxed plugins send their priority over IPC, so no type can be assumed.
 */
export function normalizeHookPriority(priority: unknown): number {
  return typeof priority === 'number' && Number.isFinite(priority) ? priority : 100;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

function deepCloneFallback(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) {
      copy.push(deepCloneFallback(item, seen));
    }
    return copy;
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (value instanceof RegExp) {
    return new RegExp(value.source, value.flags);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(copy, key, {
      value: deepCloneFallback(entry, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

/**
 * Format an arbitrary thrown/reported hook error into a non-empty string without throwing.
 * Handles null-prototype objects, throwing `toString()` implementations, empty `Error` messages,
 * and dual-stack `AggregateError` instances whose top-level `message` is empty.
 */
export function safeFormatHookError(
  error: unknown,
  fallback = 'hook handler error',
  seen = new WeakSet<object>(),
): string {
  if (error === undefined) return fallback;
  if (typeof error === 'string') {
    return error.trim().length > 0 ? error : fallback;
  }
  if (error instanceof Error) {
    if (seen.has(error)) return fallback;
    seen.add(error);
    let message = '';
    try {
      if (typeof error.message === 'string') message = error.message;
    } catch {
      message = '';
    }
    if (message.trim().length > 0) return message;
    let name = '';
    try {
      if (typeof error.name === 'string') name = error.name.trim();
    } catch {
      name = '';
    }
    try {
      if (error instanceof AggregateError && Array.isArray(error.errors) && error.errors.length > 0) {
        const parts = error.errors
          .slice(0, 5)
          .map(sub => safeFormatHookError(sub, '', seen))
          .filter(part => part.length > 0);
        if (parts.length > 0) return `${name || 'AggregateError'}: ${parts.join('; ')}`;
      }
    } catch {
      // Fall through to safe name or fallback below when AggregateError getters throw.
    }
    return name.length > 0 ? name : fallback;
  }
  if (
    error === null ||
    typeof error === 'number' ||
    typeof error === 'boolean' ||
    typeof error === 'bigint' ||
    typeof error === 'symbol'
  ) {
    return String(error);
  }
  try {
    const text = `${error as string}`;
    return text.trim().length > 0 ? text : fallback;
  } catch {
    return '[unprintable error]';
  }
}

export function cloneHookData<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return deepCloneFallback(value, new WeakMap()) as T;
  }
}

export interface HookExecuteOptions<T> {
  sessionId?: string;
  source: string;
  /** Adopt a handler's `data` only when this returns true; a rejected result is skipped, or throws in fail-closed mode. */
  accept?: (data: T) => boolean;
  /** Pass a deep clone of `currentData` to each handler so in-place mutations on error or no-data cannot leak. */
  isolateData?: boolean;
  /** Normalize an accepted handler result before passing `currentData` to subsequent handlers. */
  normalizeData?: (data: T) => T;
  /**
   * Override fail-closed execution for this call. When true, a handler throw, `result.error`, or
   * rejected `accept` result stops the chain immediately and throws {@link HookExecutionError}.
   * Defaults to `isPreEgressFailClosed()` for {@link PRE_EGRESS_HOOK_EVENTS} and `false` otherwise.
   */
  failClosed?: boolean;
}

@Injectable()
export class HookManager {
  private readonly logger = createLogger(HookManager.name);
  private readonly hooks = new Map<HookEvent, HookRegistration[]>();
  private readonly pluginHooks = new Map<string, Set<string>>(); // pluginId -> hookIds
  // Events in-flight on the active async context. A handler that re-fires the SAME event
  // (e.g. a message:sending handler that sends) is short-circuited instead of recursing.
  // NOTE: the context does not span the async engine `message_create` echo, so this guards
  // synchronous re-entry only (the async message:sent echo loop is documented, deferred).
  // Each scope is the event set of one execute()/runInFlight() call. It is emptied when that call settles,
  // because the store also reaches every timer and detached promise the call's handlers start.
  private readonly inFlightEvents = new AsyncLocalStorage<ReadonlyArray<Set<HookEvent>>>();
  private nextHookId = 0;

  constructor(@Optional() private readonly configService?: ConfigService) {}

  /**
   * Whether pre-egress hooks (`message:sending`, `webhook:before`) fail closed on handler errors.
   * Reads `hooks.preEgressFailClosed` from ConfigService when defined, falling back to
   * `process.env.HOOK_PRE_EGRESS_FAIL_CLOSED === 'true'`. Defaults to `false`.
   */
  isPreEgressFailClosed(): boolean {
    const configured = this.configService?.get<boolean | string>('hooks.preEgressFailClosed');
    if (typeof configured === 'boolean') return configured;
    if (typeof configured === 'string') return configured.trim().toLowerCase() === 'true';
    return process.env.HOOK_PRE_EGRESS_FAIL_CLOSED?.trim().toLowerCase() === 'true';
  }

  /**
   * Register a hook handler
   */
  register(pluginId: string, event: HookEvent, handler: HookHandler, priority = 100): string {
    const id = `${pluginId}:${event}:${this.nextHookId++}`;
    const registration: HookRegistration = {
      id,
      pluginId,
      event,
      handler,
      priority: normalizeHookPriority(priority),
    };

    // Add to event handlers
    if (!this.hooks.has(event)) {
      this.hooks.set(event, []);
    }
    this.hooks.get(event)!.push(registration);

    // Sort by priority
    this.hooks.get(event)!.sort((a, b) => a.priority - b.priority);

    // Track plugin's hooks for cleanup
    if (!this.pluginHooks.has(pluginId)) {
      this.pluginHooks.set(pluginId, new Set());
    }
    this.pluginHooks.get(pluginId)!.add(id);

    this.logger.debug(`Hook registered: ${event} by ${pluginId} (priority: ${registration.priority})`);
    return id;
  }

  /**
   * Unregister a specific hook by ID
   */
  unregister(hookId: string): void {
    for (const registrations of this.hooks.values()) {
      const index = registrations.findIndex(r => r.id === hookId);
      if (index !== -1) {
        const registration = registrations[index];
        registrations.splice(index, 1);

        // Remove from plugin tracking
        const pluginHookIds = this.pluginHooks.get(registration.pluginId);
        if (pluginHookIds) {
          pluginHookIds.delete(hookId);
        }

        this.logger.debug(`Hook unregistered: ${hookId}`);
        return;
      }
    }
  }

  /** Move an existing registration to `priority` (normalized like {@link register}) and re-sort its chain. */
  setPriority(hookId: string, priority: number): void {
    for (const registrations of this.hooks.values()) {
      const registration = registrations.find(r => r.id === hookId);
      if (!registration) continue;
      registration.priority = normalizeHookPriority(priority);
      registrations.sort((a, b) => a.priority - b.priority);
      return;
    }
  }

  /**
   * Unregister all hooks for a plugin
   */
  unregisterPlugin(pluginId: string): void {
    const hookIds = this.pluginHooks.get(pluginId);
    if (!hookIds) return;

    for (const [eventKey, registrations] of this.hooks.entries()) {
      const filtered = registrations.filter(r => r.pluginId !== pluginId);
      this.hooks.set(eventKey, filtered);
    }

    this.pluginHooks.delete(pluginId);
    this.logger.debug(`Unregistered all hooks for plugin: ${pluginId}`);
  }

  /**
   * Unregister all hooks for a plugin except events in `keepEvents`. Used when a sandboxed worker
   * fails under fail-closed pre-egress mode so pre-egress shims stay registered and keep blocking
   * sends/webhooks until the operator disables, unloads, or re-enables the plugin.
   */
  unregisterPluginExcept(pluginId: string, keepEvents: ReadonlySet<HookEvent>): void {
    const hookIds = this.pluginHooks.get(pluginId);
    if (!hookIds) return;

    const remainingIds = new Set<string>();
    for (const [eventKey, registrations] of this.hooks.entries()) {
      if (keepEvents.has(eventKey)) {
        for (const registration of registrations) {
          if (registration.pluginId === pluginId) remainingIds.add(registration.id);
        }
        continue;
      }
      const filtered = registrations.filter(r => r.pluginId !== pluginId);
      this.hooks.set(eventKey, filtered);
    }

    if (remainingIds.size === 0) {
      this.pluginHooks.delete(pluginId);
    } else {
      this.pluginHooks.set(pluginId, remainingIds);
    }
    this.logger.debug(`Unregistered non-retained hooks for plugin: ${pluginId}`);
  }

  /** Snapshot the hook registration IDs currently registered for `pluginId`. */
  getPluginHookIds(pluginId: string): Set<string> {
    return new Set(this.pluginHooks.get(pluginId) ?? []);
  }

  /** Unregister every hook owned by `pluginId` whose ID is in `hookIds`. */
  unregisterPluginHookIds(pluginId: string, hookIds: ReadonlySet<string>): void {
    if (hookIds.size === 0) return;
    const tracked = this.pluginHooks.get(pluginId);
    if (!tracked) return;

    for (const [eventKey, registrations] of this.hooks.entries()) {
      const filtered = registrations.filter(r => !(r.pluginId === pluginId && hookIds.has(r.id)));
      if (filtered.length !== registrations.length) {
        this.hooks.set(eventKey, filtered);
      }
    }

    for (const id of hookIds) {
      tracked.delete(id);
    }
    if (tracked.size === 0) {
      this.pluginHooks.delete(pluginId);
    }
  }

  /** Unregister every hook owned by `pluginId` whose ID is NOT in `keepHookIds`. */
  unregisterPluginHooksNotIn(pluginId: string, keepHookIds: ReadonlySet<string>): void {
    if (keepHookIds.size === 0) {
      this.unregisterPlugin(pluginId);
      return;
    }
    const tracked = this.pluginHooks.get(pluginId);
    if (!tracked) return;

    const remainingIds = new Set<string>();
    for (const [eventKey, registrations] of this.hooks.entries()) {
      const filtered = registrations.filter(r => {
        if (r.pluginId !== pluginId) return true;
        if (keepHookIds.has(r.id)) {
          remainingIds.add(r.id);
          return true;
        }
        return false;
      });
      if (filtered.length !== registrations.length) {
        this.hooks.set(eventKey, filtered);
      }
    }

    if (remainingIds.size === 0) {
      this.pluginHooks.delete(pluginId);
    } else {
      this.pluginHooks.set(pluginId, remainingIds);
    }
  }

  /**
   * Execute hooks for an event
   * Returns: { continue: boolean, data: T }
   */
  async execute<T>(event: HookEvent, data: T, options: HookExecuteOptions<T>): Promise<{ continue: boolean; data: T }> {
    if (this.isInFlight(event)) {
      this.logger.warn(
        `Hook re-entrancy blocked: ${event} re-fired by a handler of the same event (source: ${options.source})`,
      );
      return { continue: true, data };
    }

    return this.runInFlight([event], () => this.runHandlers(event, data, options));
  }

  /**
   * Run `fn` with `events` marked in-flight on the active async context (merged with anything already
   * in flight). The re-entrancy guard in {@link execute} relies on AsyncLocalStorage, which does not
   * span the sandbox worker IPC boundary: a worker handling a hook can issue a capability call that
   * returns to the host on a fresh async context, where `getStore()` is empty. Wrapping that
   * round-trip in this method re-establishes the in-flight set so a capability that re-fires the same
   * in-flight event is short-circuited exactly as an in-process handler would be.
   * The events stay in flight until `fn` settles (a native Promise) or returns; work it leaves running
   * afterwards is no longer treated as re-entrant.
   */
  runInFlight<T>(events: Iterable<HookEvent>, fn: () => T): T {
    const scope = new Set(events);
    const scopes = [...(this.inFlightEvents.getStore() ?? []).filter(parent => parent.size > 0), scope];
    return this.inFlightEvents.run(scopes, () => {
      let result: T;
      try {
        result = fn();
      } catch (error) {
        scope.clear();
        throw error;
      }
      if (types.isPromise(result)) {
        void Promise.prototype.then.call(
          result,
          () => scope.clear(),
          () => scope.clear(),
        );
      } else {
        scope.clear();
      }
      return result;
    });
  }

  /** True if `event` is already in-flight on the active async context (an ancestor handler is running
   *  it). Lets a caller wrap a capability in {@link runInFlight} ONLY for genuine re-entrancy, instead
   *  of unconditionally seeding the event and suppressing it for unrelated observers on a top-level call. */
  isInFlight(event: HookEvent): boolean {
    return this.inFlightEvents.getStore()?.some(scope => scope.has(event)) ?? false;
  }

  /** Every event in flight on the active async context, for a caller that must carry the chain across a
   *  boundary AsyncLocalStorage does not span (the sandbox worker IPC) and re-establish it with
   *  {@link runInFlight} on the way back. */
  currentInFlight(): HookEvent[] {
    return [...new Set((this.inFlightEvents.getStore() ?? []).flatMap(scope => [...scope]))];
  }

  private async runHandlers<T>(
    event: HookEvent,
    data: T,
    options: HookExecuteOptions<T>,
  ): Promise<{ continue: boolean; data: T }> {
    // A snapshot: a registration added or moved while this chain awaits a handler (a sandboxed plugin
    // re-subscribing at a lower priority) must not make the loop skip or repeat one.
    const registrations = [...(this.hooks.get(event) ?? [])];

    if (registrations.length === 0) {
      return { continue: true, data };
    }

    const failClosed = options.failClosed ?? (this.isPreEgressFailClosed() && PRE_EGRESS_HOOK_EVENTS.has(event));

    let currentData = options.isolateData ? cloneHookData(data) : data;
    const ctx: HookContext<T> = {
      event,
      data: currentData,
      sessionId: options.sessionId,
      timestamp: new Date(),
      source: options.source,
    };
    Object.defineProperty(ctx, HOOK_FAIL_CLOSED_SYMBOL, {
      value: failClosed,
      enumerable: false,
      configurable: false,
      writable: false,
    });

    for (const registration of registrations) {
      let shouldContinue: boolean;
      let resultData: unknown;
      let resultError: unknown;
      try {
        ctx.data = options.isolateData ? cloneHookData(currentData) : currentData;
        const rawResult: unknown = await registration.handler(ctx);
        if (failClosed) {
          if (rawResult === null || typeof rawResult !== 'object') {
            throw new Error('hook handler returned an invalid result: continue must be a boolean');
          }
          const result = rawResult as { continue?: unknown; data?: unknown; error?: unknown };
          resultError = result.error;
          if (resultError !== undefined) {
            shouldContinue = true;
            resultData = undefined;
          } else if (Array.isArray(rawResult) || typeof result.continue !== 'boolean') {
            throw new Error('hook handler returned an invalid result: continue must be a boolean');
          } else {
            shouldContinue = result.continue;
            resultData = result.data;
          }
        } else {
          const result = rawResult as { continue: boolean; data?: unknown; error?: unknown };
          shouldContinue = result.continue;
          resultData = result.data;
          resultError = result.error;
        }
      } catch (error) {
        this.logger.error(`Hook error in ${registration.pluginId} for ${event}: ${safeFormatHookError(error)}`);
        if (failClosed) {
          throw new HookExecutionError(registration.pluginId, event, error);
        }
        // Continue to next handler, don't break the chain on error
        continue;
      }

      if (resultError !== undefined && failClosed) {
        this.logger.error(`Hook error in ${registration.pluginId} for ${event}: ${safeFormatHookError(resultError)}`);
        throw new HookExecutionError(registration.pluginId, event, resultError);
      }

      // A handler that reports an error discards its output: do NOT apply its (possibly partial or
      // corrupted) data mutation, even though HookResult allows returning data and error together.
      // A result the caller cannot use is dropped the same way, so the chain keeps the last usable
      // value (an earlier handler's redaction included) instead of the caller falling back to the input.
      if (resultError === undefined && resultData !== undefined) {
        if (options.accept && !options.accept(resultData as T)) {
          this.logger.warn(
            `Hook result from ${registration.pluginId} for ${event} is not usable; keeping the previous data`,
          );
          if (failClosed) {
            throw new HookExecutionError(
              registration.pluginId,
              event,
              new Error(`Hook result from ${registration.pluginId} for ${event} failed payload validation`),
            );
          }
        } else {
          const adopted = resultData as T;
          currentData = options.normalizeData ? options.normalizeData(adopted) : adopted;
        }
      }

      if (!shouldContinue) {
        this.logger.debug(`Hook chain stopped by ${registration.pluginId} at event ${event}`);
        return { continue: false, data: currentData };
      }

      if (resultError !== undefined) {
        this.logger.error(`Hook error in ${registration.pluginId} for ${event}: ${safeFormatHookError(resultError)}`);
      }
    }

    return { continue: true, data: currentData };
  }

  /**
   * Check if any hooks are registered for an event
   */
  hasHooks(event: HookEvent): boolean {
    const registrations = this.hooks.get(event);
    return registrations !== undefined && registrations.length > 0;
  }

  /**
   * Get count of registered hooks for an event
   */
  getHookCount(event: HookEvent): number {
    return this.hooks.get(event)?.length || 0;
  }

  /**
   * Get registered hooks info (for debugging/dashboard)
   */
  getRegisteredHooks(): Record<HookEvent, { pluginId: string; priority: number }[]> {
    const result: Record<string, { pluginId: string; priority: number }[]> = {};

    for (const [event, registrations] of this.hooks.entries()) {
      result[event] = registrations.map(r => ({
        pluginId: r.pluginId,
        priority: r.priority,
      }));
    }

    return result;
  }

  /**
   * Get all events that a plugin has registered
   */
  getPluginEvents(pluginId: string): HookEvent[] {
    const events: HookEvent[] = [];

    for (const [event, registrations] of this.hooks.entries()) {
      if (registrations.some(r => r.pluginId === pluginId)) {
        events.push(event);
      }
    }

    return events;
  }
}
