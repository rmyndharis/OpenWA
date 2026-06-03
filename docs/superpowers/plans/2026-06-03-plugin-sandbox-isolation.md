# Plugin Sandbox Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Contain the blast radius of buggy (not malicious) plugins and enforce least-privilege capability access, without breaking engine plugins or the synchronous in-process hook pipeline.

**Architecture:** Trusted-author threat model. Wrap every plugin entrypoint (hook handlers + lifecycle methods) in timeouts; a per-plugin circuit breaker auto-removes the hooks of a repeatedly-failing plugin. A manifest `permissions` field gates host-controlled capabilities (`storage`, `services`, raw bus access) injected into `PluginContext`; `net`/`fs` permissions are audit-only. Plugin logs redact secret config values.

**Tech Stack:** NestJS, TypeScript, Jest, Joi (env validation).

**Source spec:** `docs/superpowers/specs/2026-06-03-plugin-sandbox-isolation-design.md`

**Deviation from spec (noted):** `PluginCircuitBreaker` lives in `src/core/hooks/` (not `src/core/plugins/`) so `HookManager` can inject it without a `hooks → plugins` module cycle (`plugins` already depends on `hooks`). The loader imports it from `hooks` for lifecycle failures.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/core/hooks/plugin-circuit-breaker.service.ts` | **new** — consecutive-failure counter + trip state per plugin |
| `src/core/hooks/plugin-circuit-breaker.service.spec.ts` | **new** — breaker unit tests |
| `src/core/hooks/with-timeout.ts` | **new** — `withTimeout(promise, ms, label)` helper |
| `src/core/hooks/with-timeout.spec.ts` | **new** — timeout helper tests |
| `src/core/hooks/hook-manager.service.ts` | inject breaker; timeout + breaker around each handler in `execute()` |
| `src/core/hooks/hook-manager.service.spec.ts` | **new/extend** — execute integration with breaker+timeout |
| `src/core/hooks/hooks.module.ts` | declare + export `PluginCircuitBreaker` |
| `src/core/plugins/exceptions/plugin-permission-denied.error.ts` | **new** — denial error |
| `src/core/plugins/plugin.interfaces.ts` | add `PluginPermission`, `permissions` on manifest; remove `hookManager` from `PluginContext` |
| `src/core/plugins/plugin-loader.service.ts` | lifecycle timeouts + breaker; capability injection; freeze context; secret redaction; audit log |
| `src/core/plugins/plugin-loader.service.spec.ts` | **new/extend** — permission gating, freeze, redaction |
| `src/config/configuration.ts` | `plugins` config block |
| `src/config/env.validation.ts` | `PLUGIN_*` Joi keys |
| `src/config/env.validation.spec.ts` | extend — new keys validate/default |

---

## Task 1: Timeout helper

**Files:**
- Create: `src/core/hooks/with-timeout.ts`
- Test: `src/core/hooks/with-timeout.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/hooks/with-timeout.spec.ts
import { withTimeout, PluginTimeoutError } from './with-timeout';

describe('withTimeout', () => {
  it('resolves when the promise settles before the deadline', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50, 'test')).resolves.toBe('ok');
  });

  it('rejects with PluginTimeoutError when the promise exceeds the deadline', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 1000));
    await expect(withTimeout(slow, 20, 'slow-op')).rejects.toBeInstanceOf(PluginTimeoutError);
  });

  it('includes the label in the error message', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 1000));
    await expect(withTimeout(slow, 10, 'my-hook')).rejects.toThrow('my-hook');
  });

  it('clears the timer when the promise resolves (no open handles)', async () => {
    // If the timer is not cleared, Jest warns about open handles.
    await withTimeout(Promise.resolve(1), 10_000, 'fast');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/core/hooks/with-timeout.spec.ts`
Expected: FAIL — cannot find module `./with-timeout`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/hooks/with-timeout.ts
export class PluginTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`Plugin operation "${label}" exceeded ${ms}ms timeout`);
    this.name = 'PluginTimeoutError';
  }
}

/**
 * Race a promise against a timeout. The timer is always cleared so it never
 * keeps the event loop alive. On timeout the returned promise rejects with
 * PluginTimeoutError; the underlying promise is left to settle on its own.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PluginTimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/core/hooks/with-timeout.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/hooks/with-timeout.ts src/core/hooks/with-timeout.spec.ts
git commit -m "feat(plugins): add withTimeout helper for plugin entrypoint deadlines"
```

---

## Task 2: PluginCircuitBreaker service

**Files:**
- Create: `src/core/hooks/plugin-circuit-breaker.service.ts`
- Test: `src/core/hooks/plugin-circuit-breaker.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/hooks/plugin-circuit-breaker.service.spec.ts
import { PluginCircuitBreaker } from './plugin-circuit-breaker.service';

describe('PluginCircuitBreaker', () => {
  let breaker: PluginCircuitBreaker;

  beforeEach(() => {
    breaker = new PluginCircuitBreaker();
    breaker.configure(3); // threshold = 3
  });

  it('does not trip before the threshold', () => {
    expect(breaker.recordFailure('p1')).toBe(false);
    expect(breaker.recordFailure('p1')).toBe(false);
    expect(breaker.isTripped('p1')).toBe(false);
  });

  it('trips exactly on the Nth consecutive failure', () => {
    breaker.recordFailure('p1');
    breaker.recordFailure('p1');
    expect(breaker.recordFailure('p1')).toBe(true); // 3rd
    expect(breaker.isTripped('p1')).toBe(true);
  });

  it('returns false on subsequent failures after already tripped', () => {
    breaker.recordFailure('p1');
    breaker.recordFailure('p1');
    breaker.recordFailure('p1'); // trips
    expect(breaker.recordFailure('p1')).toBe(false); // already tripped, not "just tripped"
  });

  it('resets the counter on success', () => {
    breaker.recordFailure('p1');
    breaker.recordFailure('p1');
    breaker.recordSuccess('p1');
    expect(breaker.recordFailure('p1')).toBe(false); // counter restarted
    expect(breaker.isTripped('p1')).toBe(false);
  });

  it('tracks plugins independently', () => {
    breaker.recordFailure('p1');
    breaker.recordFailure('p1');
    breaker.recordFailure('p1'); // p1 trips
    expect(breaker.isTripped('p1')).toBe(true);
    expect(breaker.isTripped('p2')).toBe(false);
  });

  it('reset() clears tripped state and counter', () => {
    breaker.recordFailure('p1');
    breaker.recordFailure('p1');
    breaker.recordFailure('p1');
    breaker.reset('p1');
    expect(breaker.isTripped('p1')).toBe(false);
    expect(breaker.recordFailure('p1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/core/hooks/plugin-circuit-breaker.service.spec.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/hooks/plugin-circuit-breaker.service.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/core/hooks/plugin-circuit-breaker.service.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/hooks/plugin-circuit-breaker.service.ts src/core/hooks/plugin-circuit-breaker.service.spec.ts
git commit -m "feat(plugins): add PluginCircuitBreaker for consecutive-failure tripping"
```

---

## Task 3: Register breaker in HooksModule

**Files:**
- Modify: `src/core/hooks/hooks.module.ts`

- [ ] **Step 1: Update the module**

```ts
// src/core/hooks/hooks.module.ts
import { Global, Module } from '@nestjs/common';
import { HookManager } from './hook-manager.service';
import { PluginCircuitBreaker } from './plugin-circuit-breaker.service';

@Global() // Make HookManager available everywhere without importing
@Module({
  providers: [HookManager, PluginCircuitBreaker],
  exports: [HookManager, PluginCircuitBreaker],
})
export class HooksModule {}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `npm run build`
Expected: success (HookManager does not yet inject the breaker — that's Task 4).

- [ ] **Step 3: Commit**

```bash
git add src/core/hooks/hooks.module.ts
git commit -m "feat(plugins): provide PluginCircuitBreaker from HooksModule"
```

---

## Task 4: Timeout + breaker inside HookManager.execute

**Files:**
- Modify: `src/core/hooks/hook-manager.service.ts`
- Test: `src/core/hooks/hook-manager.service.spec.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// src/core/hooks/hook-manager.service.spec.ts
import { HookManager } from './hook-manager.service';
import { PluginCircuitBreaker } from './plugin-circuit-breaker.service';
import { HookContext, HookResult } from './hook.interfaces';

describe('HookManager execute with isolation', () => {
  let manager: HookManager;
  let breaker: PluginCircuitBreaker;

  beforeEach(() => {
    breaker = new PluginCircuitBreaker();
    breaker.configure(2);
    manager = new HookManager(breaker);
    manager.configure(50); // hook timeout 50ms
  });

  it('still runs the mutate/halt pipeline normally', async () => {
    manager.register('p1', 'message:sending', async (ctx: HookContext<{ body: string }>) => {
      return { continue: true, data: { body: ctx.data.body + '!' } } as HookResult;
    });
    const out = await manager.execute('message:sending', { body: 'hi' }, { source: 'test' });
    expect(out.continue).toBe(true);
    expect((out.data as { body: string }).body).toBe('hi!');
  });

  it('halts the chain when a handler returns continue:false', async () => {
    manager.register('p1', 'message:sending', async () => ({ continue: false }) as HookResult);
    manager.register('p2', 'message:sending', async (ctx) => ({ continue: true, data: ctx.data }) as HookResult);
    const out = await manager.execute('message:sending', { body: 'x' }, { source: 'test' });
    expect(out.continue).toBe(false);
  });

  it('counts a hanging handler as a failure and trips after threshold', async () => {
    manager.register('slow', 'message:received', () => new Promise(() => {})); // never resolves
    await manager.execute('message:received', {}, { source: 'test' });
    expect(breaker.isTripped('slow')).toBe(false); // 1 failure, threshold 2
    await manager.execute('message:received', {}, { source: 'test' });
    expect(breaker.isTripped('slow')).toBe(true); // 2nd failure trips
  });

  it('skips handlers of a tripped plugin and removes its hooks on trip', async () => {
    let calls = 0;
    manager.register('bad', 'message:received', async () => {
      calls += 1;
      throw new Error('boom');
    });
    await manager.execute('message:received', {}, { source: 'test' }); // fail 1
    await manager.execute('message:received', {}, { source: 'test' }); // fail 2 -> trips + unregister
    const callsAtTrip = calls;
    await manager.execute('message:received', {}, { source: 'test' }); // hooks gone, no further call
    expect(calls).toBe(callsAtTrip);
    expect(manager.getHookCount('message:received')).toBe(0);
  });

  it('records success and keeps the counter from tripping on intermittent failures', async () => {
    let n = 0;
    manager.register('flaky', 'message:received', async (ctx) => {
      n += 1;
      if (n === 1) throw new Error('once');
      return { continue: true, data: ctx.data } as HookResult;
    });
    await manager.execute('message:received', {}, { source: 'test' }); // fail 1
    await manager.execute('message:received', {}, { source: 'test' }); // success resets
    await manager.execute('message:received', {}, { source: 'test' }); // fail-free
    expect(breaker.isTripped('flaky')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/core/hooks/hook-manager.service.spec.ts`
Expected: FAIL — `HookManager` constructor takes no args / `configure` undefined.

- [ ] **Step 3: Modify HookManager**

Add the import, a constructor, a `configure`, and wrap the handler call. Replace the top of the class and the `execute` loop body.

Top of class (`src/core/hooks/hook-manager.service.ts`), after existing field declarations add:

```ts
import { withTimeout } from './with-timeout';
import { PluginCircuitBreaker } from './plugin-circuit-breaker.service';
// ... existing imports remain

@Injectable()
export class HookManager {
  private readonly logger = new Logger(HookManager.name);
  private readonly hooks = new Map<HookEvent, HookRegistration[]>();
  private readonly pluginHooks = new Map<string, Set<string>>();
  private hookTimeoutMs = 5000;

  constructor(private readonly breaker: PluginCircuitBreaker) {}

  /** Set the per-handler timeout (from config at bootstrap). */
  configure(hookTimeoutMs: number): void {
    this.hookTimeoutMs = hookTimeoutMs;
  }
```

Then replace the `for (const registration of registrations) { ... }` body in `execute()` with:

```ts
    for (const registration of registrations) {
      // Skip plugins the breaker has already tripped.
      if (this.breaker.isTripped(registration.pluginId)) {
        continue;
      }
      try {
        ctx.data = currentData;
        const result = await withTimeout(
          registration.handler(ctx),
          this.hookTimeoutMs,
          `${registration.pluginId}:${event}`,
        );
        this.breaker.recordSuccess(registration.pluginId);

        if (result.data !== undefined) {
          currentData = result.data as T;
        }
        if (!result.continue) {
          this.logger.debug(`Hook chain stopped by ${registration.pluginId} at event ${event}`);
          return { continue: false, data: currentData };
        }
        if (result.error) {
          throw result.error;
        }
      } catch (error) {
        this.logger.error(`Hook error in ${registration.pluginId} for ${event}: ${error}`);
        const justTripped = this.breaker.recordFailure(registration.pluginId);
        if (justTripped) {
          this.logger.warn(
            `Plugin ${registration.pluginId} tripped the circuit breaker; removing its hooks`,
          );
          this.unregisterPlugin(registration.pluginId);
        }
        // Continue to next handler; do not break the chain on a single failure.
      }
    }
```

Note: a `result.error` throw is caught locally and therefore also counts toward the breaker — intended (a handler signalling an error repeatedly is still misbehaving).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/core/hooks/hook-manager.service.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full hooks suite for regressions**

Run: `npx jest src/core/hooks`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/hooks/hook-manager.service.ts src/core/hooks/hook-manager.service.spec.ts
git commit -m "feat(plugins): timeout + circuit-breaker around hook handler execution"
```

---

## Task 5: Permission types, denial error, and PluginContext change

**Files:**
- Create: `src/core/plugins/exceptions/plugin-permission-denied.error.ts`
- Modify: `src/core/plugins/plugin.interfaces.ts`

- [ ] **Step 1: Create the denial error**

```ts
// src/core/plugins/exceptions/plugin-permission-denied.error.ts
import type { PluginPermission } from '../plugin.interfaces';

export class PluginPermissionDeniedError extends Error {
  constructor(pluginId: string, permission: PluginPermission) {
    super(`Plugin "${pluginId}" attempted to use "${permission}" without declaring it`);
    this.name = 'PluginPermissionDeniedError';
  }
}
```

- [ ] **Step 2: Edit plugin.interfaces.ts**

Add the permission type and manifest field, and remove `hookManager` from `PluginContext`.

Add near the top type declarations:

```ts
export type PluginPermission = 'storage' | 'services' | 'hooks' | 'net' | 'fs:read' | 'fs:write';
```

In `PluginManifest`, after `hooks?: HookEvent[];` add:

```ts
  // Capabilities this plugin needs. Absent = permissive (all granted) with a
  // load-time warning. Present = honored strictly. 'net' and 'fs:*' are
  // audit-only (not runtime-enforced under the trusted-author model).
  permissions?: PluginPermission[];
```

In `PluginContext`, REMOVE the line `hookManager: HookManager;` (keep `registerHook`). Also remove the now-unused `HookManager` from the import on line 6 if nothing else uses it — leave `HookEvent, HookHandler`:

```ts
import { HookEvent, HookHandler } from '../hooks';
```

- [ ] **Step 3: Build to find any direct context.hookManager consumers**

Run: `npm run build`
Expected: success. (A repo-wide grep `context\.hookManager` returns no hits, so no bundled plugin breaks. If the build reports an error in a bundled plugin, migrate that plugin to `context.registerHook` before continuing.)

- [ ] **Step 4: Commit**

```bash
git add src/core/plugins/exceptions/plugin-permission-denied.error.ts src/core/plugins/plugin.interfaces.ts
git commit -m "feat(plugins): add permission model types; drop raw hookManager from PluginContext"
```

---

## Task 6: Capability injection, freeze, secret redaction, lifecycle timeouts in the loader

**Files:**
- Modify: `src/core/plugins/plugin-loader.service.ts`
- Test: `src/core/plugins/plugin-loader.service.spec.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// src/core/plugins/plugin-loader.service.spec.ts
import { PluginLoaderService } from './plugin-loader.service';
import { PluginCircuitBreaker } from '../hooks/plugin-circuit-breaker.service';
import { HookManager } from '../hooks';
import { PluginPermissionDeniedError } from './exceptions/plugin-permission-denied.error';
import { PluginInstance, PluginStatus, PluginType } from './plugin.interfaces';

function makeLoader() {
  const config = {
    get: (key: string) => {
      const map: Record<string, unknown> = {
        'plugins.dir': './plugins',
        'plugins.hookTimeoutMs': 5000,
        'plugins.lifecycleTimeoutMs': 10000,
        'plugins.circuitBreakerThreshold': 5,
        'cluster.enabled': false,
      };
      return map[key];
    },
  } as any;
  const breaker = new PluginCircuitBreaker();
  const hookManager = new HookManager(breaker);
  const storage = {
    getPluginConfig: () => ({}),
    setPluginStatus: () => {},
    setPluginConfig: () => {},
    createPluginStorage: () => ({
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    }),
  } as any;
  return new PluginLoaderService(config, hookManager, storage, breaker);
}

function instance(permissions?: string[], secretKeys: string[] = []): PluginInstance {
  return {
    manifest: {
      id: 'p1',
      name: 'P1',
      version: '1.0.0',
      type: PluginType.EXTENSION,
      main: 'index.js',
      permissions: permissions as any,
      configSchema: secretKeys.length
        ? {
            type: 'object',
            properties: Object.fromEntries(
              secretKeys.map((k) => [k, { type: 'string', secret: true }]),
            ),
          }
        : undefined,
    },
    status: PluginStatus.INSTALLED,
    config: { token: 'super-secret', name: 'visible' },
    instance: null,
    loadedAt: new Date(),
  };
}

describe('PluginLoaderService capabilities', () => {
  it('denies storage when not granted', async () => {
    const loader = makeLoader();
    const ctx = (loader as any).createPluginContext(instance([])); // empty permissions
    await expect(ctx.storage.get('k')).rejects.toBeInstanceOf(PluginPermissionDeniedError);
  });

  it('allows storage when granted', async () => {
    const loader = makeLoader();
    const ctx = (loader as any).createPluginContext(instance(['storage']));
    await expect(ctx.storage.get('k')).resolves.toBeNull();
  });

  it('returns undefined from getService when services not granted', () => {
    const loader = makeLoader();
    const ctx = (loader as any).createPluginContext(instance([]));
    expect(ctx.getService('anything')).toBeUndefined();
  });

  it('is permissive when permissions are absent (storage works)', async () => {
    const loader = makeLoader();
    const ctx = (loader as any).createPluginContext(instance(undefined));
    await expect(ctx.storage.get('k')).resolves.toBeNull();
  });

  it('freezes the context', () => {
    const loader = makeLoader();
    const ctx = (loader as any).createPluginContext(instance(['storage']));
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it('redacts secret config values in the plugin logger', () => {
    const loader = makeLoader();
    const logs: string[] = [];
    (loader as any).logger = {
      log: (m: string) => logs.push(m),
      debug: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
    };
    const ctx = (loader as any).createPluginContext(instance(['storage'], ['token']));
    ctx.logger.log('value is super-secret here');
    expect(logs.join('\n')).not.toContain('super-secret');
    expect(logs.join('\n')).toContain('***');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/core/plugins/plugin-loader.service.spec.ts`
Expected: FAIL — constructor arity (no breaker param) and behavior not implemented.

- [ ] **Step 3: Modify the loader**

3a. Imports + constructor. Add to imports:

```ts
import { PluginCircuitBreaker } from '../hooks/plugin-circuit-breaker.service';
import { PluginPermissionDeniedError } from './exceptions/plugin-permission-denied.error';
import { PluginPermission } from './plugin.interfaces';
import { withTimeout } from '../hooks/with-timeout';
```

Add new fields and extend the constructor:

```ts
  private readonly pluginsDir: string;
  private readonly lifecycleTimeoutMs: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly hookManager: HookManager,
    private readonly pluginStorage: PluginStorageService,
    private readonly breaker: PluginCircuitBreaker,
  ) {
    this.pluginsDir = this.configService.get<string>('plugins.dir') ?? './plugins';
    this.lifecycleTimeoutMs = this.configService.get<number>('plugins.lifecycleTimeoutMs') ?? 10000;
    // Wire the shared breaker + hook timeout from config.
    this.breaker.configure(this.configService.get<number>('plugins.circuitBreakerThreshold') ?? 5);
    this.hookManager.configure(this.configService.get<number>('plugins.hookTimeoutMs') ?? 5000);
  }
```

3b. Add a private helper to run lifecycle methods with a timeout + breaker, near the bottom of the class:

```ts
  /** Run a plugin lifecycle method under a timeout, feeding the breaker. */
  private async runLifecycle(pluginId: string, label: string, fn: () => Promise<void>): Promise<void> {
    if (this.breaker.isTripped(pluginId)) {
      throw new Error(`Plugin ${pluginId} is disabled by the circuit breaker`);
    }
    try {
      await withTimeout(fn(), this.lifecycleTimeoutMs, `${pluginId}:${label}`);
      this.breaker.recordSuccess(pluginId);
    } catch (error) {
      const justTripped = this.breaker.recordFailure(pluginId);
      if (justTripped) {
        this.logger.warn(`Plugin ${pluginId} tripped the circuit breaker; removing its hooks`);
        this.hookManager.unregisterPlugin(pluginId);
      }
      throw error;
    }
  }
```

In `enablePlugin`, replace the direct lifecycle awaits:

```ts
      if (plugin.instance.onLoad) {
        await this.runLifecycle(pluginId, 'onLoad', () => plugin.instance!.onLoad!(context));
      }
      if (plugin.instance.onEnable) {
        await this.runLifecycle(pluginId, 'onEnable', () => plugin.instance!.onEnable!(context));
      }
```

(Leave the surrounding try/catch that sets `status = ERROR` intact.)

3c. Replace `createPluginContext` with permission-gated capability injection, freeze, and redaction:

```ts
  private createPluginContext(plugin: PluginInstance): PluginContext {
    const pluginId = plugin.manifest.id;
    const declared = plugin.manifest.permissions;
    // Absent permissions => permissive (all granted) + warning. Present => strict.
    const has = (p: PluginPermission): boolean => declared === undefined || declared.includes(p);
    if (declared === undefined) {
      this.logger.warn(`Plugin ${pluginId} declares no permissions; granting all (declare 'permissions' in manifest)`, {
        pluginId,
        action: 'plugin_permissions_absent',
      });
    }
    // Audit-only capabilities (not runtime-enforced).
    const auditOnly = (['net', 'fs:read', 'fs:write'] as PluginPermission[]).filter(
      (p) => declared?.includes(p),
    );
    if (auditOnly.length) {
      this.logger.log(`Plugin ${pluginId} declares audit-only capabilities: ${auditOnly.join(', ')}`, {
        pluginId,
        action: 'plugin_permissions_audit',
      });
    }

    // Secret redaction: collect config values for keys marked secret.
    const secretValues = Object.entries(plugin.manifest.configSchema?.properties ?? {})
      .filter(([, schema]) => schema.secret)
      .map(([key]) => plugin.config[key])
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    const redact = (msg: string): string =>
      secretValues.reduce((acc, secret) => acc.split(secret).join('***'), msg);

    const pluginLogger: PluginLogger = {
      log: (message, meta) => this.logger.log(`[${pluginId}] ${redact(message)}`, { ...meta, pluginId }),
      debug: (message, meta) => this.logger.debug(`[${pluginId}] ${redact(message)}`, { ...meta, pluginId }),
      warn: (message, meta) => this.logger.warn(`[${pluginId}] ${redact(message)}`, { ...meta, pluginId }),
      error: (message, error, meta) =>
        this.logger.error(
          `[${pluginId}] ${redact(message)}`,
          error instanceof Error ? error.message : String(error),
          { ...meta, pluginId },
        ),
    };

    // Storage gated by 'storage' permission.
    const realStorage = this.pluginStorage.createPluginStorage(pluginId);
    const storage = has('storage')
      ? realStorage
      : {
          get: () => Promise.reject(new PluginPermissionDeniedError(pluginId, 'storage')),
          set: () => Promise.reject(new PluginPermissionDeniedError(pluginId, 'storage')),
          delete: () => Promise.reject(new PluginPermissionDeniedError(pluginId, 'storage')),
          list: () => Promise.reject(new PluginPermissionDeniedError(pluginId, 'storage')),
        };

    const context: PluginContext = {
      pluginId,
      manifest: plugin.manifest,
      config: plugin.config,
      logger: pluginLogger,
      storage,
      registerHook: (event, handler, priority) => {
        this.hookManager.register(pluginId, event, handler, priority);
      },
      getService: <T>(): T | undefined => {
        if (!has('services')) {
          this.logger.warn(`Plugin ${pluginId} requested a service without 'services' permission`, {
            pluginId,
            action: 'plugin_service_denied',
          });
          return undefined;
        }
        return undefined; // service exposure still intentionally limited
      },
    };

    return Object.freeze(context);
  }
```

(Removes the `hookManager` property from the returned object — matches the interface change from Task 5.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/core/plugins/plugin-loader.service.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the build**

Run: `npm run build`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add src/core/plugins/plugin-loader.service.ts src/core/plugins/plugin-loader.service.spec.ts
git commit -m "feat(plugins): capability injection, context freeze, secret redaction, lifecycle timeouts"
```

---

## Task 7: Register breaker dependency in PluginsModule

**Files:**
- Modify: `src/core/plugins/plugins.module.ts`

- [ ] **Step 1: Verify injection resolves**

`PluginCircuitBreaker` is exported by the `@Global` `HooksModule`, so Nest can inject it into `PluginLoaderService` without changing `PluginsModule` providers. Confirm by building and booting.

Run: `npm run build`
Expected: success.

- [ ] **Step 2: Boot smoke test**

Run: `node -e "require('./dist/main.js')" &` then check logs start without DI errors, then kill. (Or rely on the existing app e2e/boot test if present: `npx jest --testPathPattern=app`.)
Expected: no `Nest can't resolve dependencies of the PluginLoaderService` error.

- [ ] **Step 3: Commit (only if a change was needed)**

If no change was needed, skip. Otherwise:

```bash
git add src/core/plugins/plugins.module.ts
git commit -m "chore(plugins): ensure circuit breaker resolves in PluginsModule"
```

---

## Task 8: Configuration block + env validation

**Files:**
- Modify: `src/config/configuration.ts`
- Modify: `src/config/env.validation.ts`
- Test: `src/config/env.validation.spec.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `src/config/env.validation.spec.ts`:

```ts
describe('plugin isolation env', () => {
  it('defaults plugin timeouts and breaker threshold', () => {
    const { value, error } = envValidationSchema.validate({});
    expect(error).toBeUndefined();
    expect(value.PLUGIN_HOOK_TIMEOUT_MS).toBe(5000);
    expect(value.PLUGIN_LIFECYCLE_TIMEOUT_MS).toBe(10000);
    expect(value.PLUGIN_CIRCUIT_BREAKER_THRESHOLD).toBe(5);
  });

  it('rejects a circuit breaker threshold below 1', () => {
    const { error } = envValidationSchema.validate({ PLUGIN_CIRCUIT_BREAKER_THRESHOLD: '0' });
    expect(error).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/config/env.validation.spec.ts -t "plugin isolation env"`
Expected: FAIL — values are `undefined`.

- [ ] **Step 3: Add Joi keys**

In `src/config/env.validation.ts`, before the closing `}).unknown(true);` add:

```ts
  // Plugin isolation (blast-radius containment). Timeouts wrap plugin
  // entrypoints; the breaker disables a plugin after N consecutive failures.
  PLUGIN_HOOK_TIMEOUT_MS: Joi.number().integer().min(1).default(5000),
  PLUGIN_LIFECYCLE_TIMEOUT_MS: Joi.number().integer().min(1).default(10000),
  PLUGIN_CIRCUIT_BREAKER_THRESHOLD: Joi.number().integer().min(1).default(5),
```

- [ ] **Step 4: Add config block**

In `src/config/configuration.ts`, before the closing `});` add:

```ts
  // Plugin isolation (Tier 1 C1 follow-up).
  plugins: {
    dir: process.env.PLUGINS_DIR || './plugins',
    hookTimeoutMs: parseInt(process.env.PLUGIN_HOOK_TIMEOUT_MS || '5000', 10),
    lifecycleTimeoutMs: parseInt(process.env.PLUGIN_LIFECYCLE_TIMEOUT_MS || '10000', 10),
    circuitBreakerThreshold: parseInt(process.env.PLUGIN_CIRCUIT_BREAKER_THRESHOLD || '5', 10),
  },
```

Note: `plugins.dir` is added here because the loader already reads `plugins.dir` (previously unset, falling back to `./plugins`). Adding it makes the source of truth explicit; behavior is unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/config/env.validation.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config/configuration.ts src/config/env.validation.ts src/config/env.validation.spec.ts
git commit -m "feat(plugins): add PLUGIN_* isolation config (timeouts, breaker threshold)"
```

---

## Task 9: Full suite + docs

**Files:**
- Modify: `docs/ARCHITECTURE_REVIEW.md` (mark C1 isolation follow-up)

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: all suites pass (existing 159 + the new specs).

- [ ] **Step 2: Run the build**

Run: `npm run build`
Expected: success.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: clean (fix any `no-explicit-any`/type issues introduced).

- [ ] **Step 4: Update the architecture review**

In `docs/ARCHITECTURE_REVIEW.md`, under Tier 1 item **C1**, append a line:

```markdown
   - **Plugin isolation follow-up (2026-06-03).** Trusted-author model: per-plugin timeouts + circuit breaker (blast radius) and a manifest `permissions` capability model (least privilege). `net`/`fs` permissions are audit-only — true sandboxing (worker_threads/isolated-vm) remains out of scope as it would break engine plugins and the synchronous hook pipeline. See `docs/superpowers/specs/2026-06-03-plugin-sandbox-isolation-design.md`.
```

- [ ] **Step 5: Commit**

```bash
git add docs/ARCHITECTURE_REVIEW.md
git commit -m "docs(plugins): record plugin isolation follow-up under Tier 1 C1"
```

---

## Self-Review Notes

- **Spec coverage:** failure isolation (Tasks 1–4, 6), circuit breaker (Task 2, 4), permission model (Tasks 5–6), declarative net/fs audit (Task 6), secret redaction (Task 6), config (Task 8), tests (every task), docs (Task 9). All spec sections mapped.
- **Type consistency:** `PluginPermission` defined in Task 5 used in Tasks 5/6; `PluginCircuitBreaker` API (`configure/recordSuccess/recordFailure/isTripped/reset`) consistent across Tasks 2/4/6; `withTimeout(promise, ms, label)` consistent across Tasks 1/4/6; `HookManager.configure(hookTimeoutMs)` defined Task 4, called Task 6.
- **Breaking change:** removing `hookManager` from `PluginContext` (Task 5) — repo grep shows no `context.hookManager` consumers; Step 3 of Task 5 verifies via build.
