import { ConflictException, HttpStatus } from '@nestjs/common';
import { EngineRegistry } from '../../engine/engine-registry.service';
import { IWhatsAppEngine } from '../../engine/interfaces/whatsapp-engine.interface';
import { type createLogger } from '../../common/services/logger.service';

/**
 * The credential-teardown / initial-status fences extracted from SessionEngineLifecycle. Plain
 * class (NOT a NestJS provider — the lifecycle's constructor signature is frozen by specs), built
 * inside the lifecycle's constructor. The two fence Maps stay lifecycle FIELDS handed over by
 * reference, so this unit and the lifecycle (and every spec poking the maps through the lifecycle)
 * always observe the same instances; method bodies below moved verbatim, which is why they read
 * `this.pendingTeardowns` / `this.pendingInitialStatuses` / `this.engines` / `this.logger` against
 * the same-named fields assigned here. The lifecycle keeps same-named delegates for the four
 * methods its own core still calls — `teardownEngineSafely`, `trackPendingCredentialTeardown`,
 * `awaitPendingTeardown`, `evictAndForceDestroy` (the baileys forwarder precedent) — so every
 * existing call site and spec poke (`trackPendingCredentialTeardown` is invoked by name in
 * logout-teardown-race.spec) stays byte-identical. The other two methods,
 * `destroyEngineSafely` and `awaitInitialStatus`, are reached by the controls unit through this
 * instance directly (`this.fences.…`) and have no lifecycle delegate.
 */
export class SessionLifecycleFences {
  private readonly engines: EngineRegistry;
  private readonly pendingTeardowns: Map<string, Promise<void>>;
  private readonly pendingInitialStatuses: Map<string, { engine: IWhatsAppEngine; promise: Promise<void> }>;
  private readonly logger: ReturnType<typeof createLogger>;

  constructor(deps: {
    engines: EngineRegistry;
    pendingTeardowns: Map<string, Promise<void>>;
    pendingInitialStatuses: Map<string, { engine: IWhatsAppEngine; promise: Promise<void> }>;
    logger: ReturnType<typeof createLogger>;
  }) {
    this.engines = deps.engines;
    this.pendingTeardowns = deps.pendingTeardowns;
    this.pendingInitialStatuses = deps.pendingInitialStatuses;
    this.logger = deps.logger;
  }

  /** Destroy one engine, isolating + time-bounding failures so shutdown can't be stalled or aborted.
   *  Resolves to whether the destroy actually completed (see teardownEngineSafely). */
  async destroyEngineSafely(sessionId: string, engine: IWhatsAppEngine): Promise<boolean> {
    this.logger.log(`Destroying engine for session ${sessionId}`, { sessionId, action: 'shutdown' });
    return this.teardownEngineSafely(sessionId, engine, e => e.destroy(), 'destroy');
  }

  /**
   * Run an engine teardown (destroy/disconnect), isolating + time-bounding failures so a stuck
   * Chromium/socket can neither hang nor abort the caller. Always resolves — the caller is then free
   * to reconcile the engines Map and proceed with DB cleanup regardless of teardown outcome.
   * Resolves to whether the teardown actually completed: `false` means it threw or hit the 10s
   * deadline, so the underlying Chromium/socket may still be alive (a caller with an operator-facing
   * outcome, like stopOrphanEngines, must surface that instead of reporting a clean stop).
   *
   * A teardown that loses the deadline race keeps running past the caller's return. For 'logout'
   * that leftover promise ends in an fs.rm of the session's on-disk profile — the same path a
   * later start() re-creates — so the raw promise is registered in pendingTeardowns (keyed by the
   * session NAME, which is the auth-dir key) and start()/delete() wait (bounded, fail-closed) for
   * it to settle before touching that path.
   */
  async teardownEngineSafely(
    sessionId: string,
    engine: IWhatsAppEngine,
    teardown: (e: IWhatsAppEngine) => Promise<void>,
    label: 'destroy' | 'disconnect' | 'force-destroy' | 'logout',
    sessionName?: string,
  ): Promise<boolean> {
    const raw = teardown(engine);
    if (label === 'logout' && sessionName) {
      this.trackPendingCredentialTeardown(sessionName, raw);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        raw,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`engine.${label}() timed out`)), 10_000);
        }),
      ]);
      return true;
    } catch (err) {
      this.logger.error(`Failed to ${label} engine for session ${sessionId}`, String(err), {
        sessionId,
        action: `engine_${label}_failed`,
      });
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Track a destructive credential-teardown promise under the session NAME (the on-disk auth-dir
   * key — NOT the UUID). A logout's `engine.logout()` ends in an `fs.rm` of the same directory a
   * later start() under the same name re-creates, so start()/delete()/executeReconnect consult this
   * map and wait (bounded, fail-closed) before touching that path.
   *
   * Settlement marker only — never rejects, so it can't drive a caller's deadline race to a false
   * "completed". A concurrent teardown for the same name CHAINS onto the previous entry instead of
   * overwriting it (Promise.allSettled), so callers keep waiting until EVERY in-flight teardown for
   * that name has settled — otherwise a second logout's fast settlement would drop the entry while
   * the first teardown's profile rm is still pending. Identity-checked on removal is the ONLY path
   * that evicts the entry, so a newer teardown's entry is never dropped by an older one settling.
   */
  trackPendingCredentialTeardown(sessionName: string, raw: Promise<void>): void {
    const tracked = raw.catch(() => undefined);
    const previous = this.pendingTeardowns.get(sessionName);
    const entry: Promise<void> = previous ? Promise.allSettled([previous, tracked]).then(() => undefined) : tracked;
    this.pendingTeardowns.set(sessionName, entry);
    void entry.finally(() => {
      if (this.pendingTeardowns.get(sessionName) === entry) {
        this.pendingTeardowns.delete(sessionName);
      }
    });
  }

  /**
   * Wait (bounded) for a teardown that lost its deadline race to settle. A losing logout() promise
   * ends in an fs.rm of the on-disk profile — the same deterministic path start() re-creates and
   * delete() purges — so those paths call this before touching disk. The fence is FAIL CLOSED: a
   * teardown still wedged past the bound could still land its rm on credentials a (re)created session
   * under the same name would write, so the operation refuses with a retryable 409
   * (SESSION_NAME_TEARDOWN_PENDING) instead of proceeding. The entry is NOT dropped on timeout — a
   * retry after the rm eventually settles will see it gone and proceed.
   *
   * Keyed by the session NAME: the auth directories are built from `Session.name`, so two sessions
   * sharing a name (a deleted UUID recreated under the same name) share the credential path and must
   * share the fence.
   */
  async awaitPendingTeardown(sessionName: string): Promise<void> {
    const pending = this.pendingTeardowns.get(sessionName);
    if (!pending) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), 10_000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!settled) {
      // Fail closed: do NOT proceed. The stale rm could still hit a fresh profile under this name.
      // Message is operator-facing and retryable, with no internal path leak.
      throw new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        message:
          `A credential teardown for session '${sessionName}' is still in flight. Wait for it to ` +
          'settle and retry.',
        error: 'Conflict',
        code: 'SESSION_NAME_TEARDOWN_PENDING',
      });
    }
  }

  /**
   * Wait for the captured `engine`'s exact in-flight `updateStatus(INITIALIZING)` write to settle.
   * Called by every retiring lifecycle control (stop/logout/delete/forceKill) AFTER the stop mark is
   * set and reconnect cancelled, and BEFORE teardown / the final DISCONNECTED write / parent-row
   * deletion. This keeps the control action the final persisted owner: a delayed INITIALIZING write
   * always settles first, so it can never land after the DISCONNECTED write or the row removal.
   *
   * Identity-checked on the engine object: a control action that captured engine A awaits ONLY A's
   * pending promise, never a replacement B's entry (and never deletes it). A bounded wait mirrors
   * awaitPendingTeardown — the INITIALIZING write is a single DB update, but a wedged DB must not
   * block retirement indefinitely.
   */
  async awaitInitialStatus(id: string, engine: IWhatsAppEngine): Promise<void> {
    const pending = this.pendingInitialStatuses.get(id);
    if (!pending || pending.engine !== engine) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      pending.promise.then(() => true),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), 10_000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!settled) {
      this.logger.warn(`Proceeding to retire session ${id} while its INITIALIZING status write is still wedged`, {
        sessionId: id,
        action: 'pending_initial_status_wait_exhausted',
      });
    }
  }

  /**
   * Evict a terminally-failed or abandoned engine from the map and SIGKILL its browser process
   * (best-effort, time-bounded via teardownEngineSafely). An engine left in the map keeps holding a
   * concurrency slot and makes a later start() see the session as "already started"; forceDestroy()
   * (not the graceful destroy()) is used because such an engine's browser/CDP connection is typically
   * already broken, so a graceful close would only time out before the process is reaped.
   */
  evictAndForceDestroy(id: string, engine: IWhatsAppEngine): void {
    this.engines.delete(id);
    void this.teardownEngineSafely(id, engine, e => e.forceDestroy(), 'force-destroy');
  }
}
