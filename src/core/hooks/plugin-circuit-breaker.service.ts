import { Injectable } from '@nestjs/common';

interface BreakerState {
  consecutiveFailures: number;
  tripped: boolean;
}

/**
 * Per-plugin circuit breaker. Counts CONSECUTIVE failures (a success resets the
 * count). After `threshold` failures the plugin is "tripped". Callers use the
 * boolean return of recordFailure() to act exactly once at the trip moment
 * (e.g. unregister the plugin's hooks).
 */
@Injectable()
export class PluginCircuitBreaker {
  private threshold = 5;
  private readonly states = new Map<string, BreakerState>();

  /** Set the consecutive-failure threshold (from config at bootstrap). */
  configure(threshold: number): void {
    this.threshold = threshold;
  }

  private stateFor(pluginId: string): BreakerState {
    let s = this.states.get(pluginId);
    if (!s) {
      s = { consecutiveFailures: 0, tripped: false };
      this.states.set(pluginId, s);
    }
    return s;
  }

  recordSuccess(pluginId: string): void {
    const s = this.stateFor(pluginId);
    s.consecutiveFailures = 0;
  }

  /** Returns true only on the call that transitions the plugin into tripped. */
  recordFailure(pluginId: string): boolean {
    const s = this.stateFor(pluginId);
    if (s.tripped) return false;
    s.consecutiveFailures += 1;
    if (s.consecutiveFailures >= this.threshold) {
      s.tripped = true;
      return true;
    }
    return false;
  }

  isTripped(pluginId: string): boolean {
    return this.states.get(pluginId)?.tripped ?? false;
  }

  reset(pluginId: string): void {
    this.states.set(pluginId, { consecutiveFailures: 0, tripped: false });
  }
}
