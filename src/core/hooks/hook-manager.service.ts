import { Injectable, Logger } from '@nestjs/common';
import { HookEvent, HookHandler, HookContext, HookRegistration } from './hook.interfaces';

@Injectable()
export class HookManager {
  private readonly logger = new Logger(HookManager.name);
  private readonly hooks = new Map<HookEvent, HookRegistration[]>();
  private readonly pluginHooks = new Map<string, Set<string>>(); // pluginId -> hookIds

  /**
   * Register a hook handler
   */
  register(pluginId: string, event: HookEvent, handler: HookHandler, priority = 100): string {
    const id = `${pluginId}:${event}:${Date.now()}`;
    const registration: HookRegistration = {
      id,
      pluginId,
      event,
      handler,
      priority,
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

    this.logger.debug(`Hook registered: ${event} by ${pluginId} (priority: ${priority})`);
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
   * Execute hooks for an event
   * Returns: { continue: boolean, data: T }
   */
  async execute<T>(
    event: HookEvent,
    data: T,
    options: { sessionId?: string; source: string },
  ): Promise<{ continue: boolean; data: T }> {
    const registrations = this.hooks.get(event) || [];

    if (registrations.length === 0) {
      return { continue: true, data };
    }

    let currentData = data;
    const ctx: HookContext<T> = {
      event,
      data: currentData,
      sessionId: options.sessionId,
      timestamp: new Date(),
      source: options.source,
    };

    for (const registration of registrations) {
      try {
        ctx.data = currentData;
        const result = await registration.handler(ctx);

        // Update data if modified
        if (result.data !== undefined) {
          currentData = result.data as T;
        }

        // Stop chain if continue is false
        if (!result.continue) {
          this.logger.debug(`Hook chain stopped by ${registration.pluginId} at event ${event}`);
          return { continue: false, data: currentData };
        }

        // Propagate error
        if (result.error) {
          throw result.error;
        }
      } catch (error) {
        this.logger.error(`Hook error in ${registration.pluginId} for ${event}: ${error}`);
        // Continue to next handler, don't break the chain on error
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
