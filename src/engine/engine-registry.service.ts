import { BadRequestException, Injectable } from '@nestjs/common';
import type { IWhatsAppEngine } from './interfaces/whatsapp-engine.interface';

/**
 * The single source of truth for which engine instance is live for a session.
 *
 * This is the narrow port between session *lifecycle* (SessionEngineLifecycle, which creates,
 * retires and reconnects engines) and the ~10 feature services that only ever need "give me the
 * running engine for this session". Those consumers previously injected the whole SessionService —
 * a 2k-line lifecycle owner — purely to reach its private `engines` map, which coupled every
 * feature module to start/stop/delete/reconnect semantics they never call.
 *
 * Identity, not just presence, is the invariant that matters. Each engine callback captures its own
 * engine instance; once a session is stopped (engine removed) or restarted/reconnected (engine
 * replaced), a late callback from the superseded engine must not mutate the session that now belongs
 * to a different — or no — engine. `isLive`/`deleteIfLive` exist so that check is written once here
 * rather than re-derived at each of its ~20 call sites.
 */
@Injectable()
export class EngineRegistry {
  /** Live engines by session (DB) id. Presence here means "started"; identity means "not superseded". */
  private readonly engines = new Map<string, IWhatsAppEngine>();

  /**
   * Sessions whose engine is being constructed but is not in `engines` yet. Held so concurrency
   * accounting and the infra import pre-flight can see a session that is starting but not yet
   * registered, which would otherwise look idle and be orphaned or double-started.
   *
   * Exposed directly (rather than behind add/remove wrappers) because the lifecycle owner needs the
   * full Set surface — including `clear()` — and this is a reservation ledger, not an invariant that
   * benefits from being funnelled through methods the way engine identity is.
   */
  readonly initializing = new Set<string>();

  // ── Map-compatible surface (used by the lifecycle owner) ──────────────

  get(id: string): IWhatsAppEngine | undefined {
    return this.engines.get(id);
  }

  set(id: string, engine: IWhatsAppEngine): void {
    this.engines.set(id, engine);
  }

  has(id: string): boolean {
    return this.engines.has(id);
  }

  delete(id: string): boolean {
    return this.engines.delete(id);
  }

  clear(): void {
    this.engines.clear();
  }

  get size(): number {
    return this.engines.size;
  }

  keys(): IterableIterator<string> {
    return this.engines.keys();
  }

  entries(): Array<[string, IWhatsAppEngine]> {
    return [...this.engines];
  }

  /**
   * Iterates a *snapshot* of the live entries. Every caller here tears engines down while iterating,
   * which would otherwise mutate the map mid-iteration.
   */
  [Symbol.iterator](): IterableIterator<[string, IWhatsAppEngine]> {
    return this.entries()[Symbol.iterator]();
  }

  // ── Liveness (identity) ───────────────────────────────────────────────

  /**
   * True only while `engine` is still the live engine registered for `id`. Identity comparison closes
   * both the post-stop and the stale-generation (stop→start / reconnect-replace) windows that a bare
   * presence check does not cover.
   */
  isLive(id: string, engine: IWhatsAppEngine): boolean {
    return this.engines.get(id) === engine;
  }

  /**
   * Reconcile the map only if `engine` is still the registered one. Guards against a teardown of a
   * superseded engine evicting its live replacement — the single most repeated invariant in the
   * lifecycle paths.
   */
  deleteIfLive(id: string, engine: IWhatsAppEngine): boolean {
    if (!this.isLive(id, engine)) {
      return false;
    }
    return this.engines.delete(id);
  }

  // ── Consumer-facing accessor ──────────────────────────────────────────

  /**
   * The running engine for `id`, or throw. Callers pass their own error so each API surface keeps the
   * exact status/message it already documented (some report 400 "not started", others 404 "not
   * connected"); the default matches the most common existing guard.
   */
  require(
    id: string,
    onMissing: () => Error = () => new BadRequestException('Session is not started'),
  ): IWhatsAppEngine {
    const engine = this.engines.get(id);
    if (!engine) {
      throw onMissing();
    }
    return engine;
  }

  // ── Initialization reservations ───────────────────────────────────────

  /**
   * Ids of every session with a live engine — including ones mid-initialization (their engine is not
   * in `engines` yet but will register when start() completes). The infra import pre-flight uses this
   * to refuse a full-replace restore that would orphan a running engine.
   */
  activeIds(): string[] {
    return [...new Set([...this.engines.keys(), ...this.initializing])];
  }
}
