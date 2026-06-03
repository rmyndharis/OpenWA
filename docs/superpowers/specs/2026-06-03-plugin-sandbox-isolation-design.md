# Plugin Sandbox Isolation — Design Spec

**Date:** 2026-06-03
**Status:** Approved (design), pending implementation
**Related:** `docs/ARCHITECTURE_REVIEW.md` Tier 1 C1 ("Later: worker_threads / vm isolation"), Tier 4 hooks note.

## 1. Context & Threat Model

OpenWA loads plugins from `PLUGINS_DIR` via `require(mainPath)`, giving each plugin full
Node.js access (fs, net, `process.env`). Plugins implement `IPlugin` lifecycle methods and
register hook handlers on a central `HookManager` event bus.

**Two architectural facts constrain any isolation design:**

1. **Hooks are a synchronous, in-process transform pipeline.** `HookManager.execute()` awaits
   each handler in priority order; a handler may **mutate** `ctx.data` (e.g. `message:sending`
   rewrites the outgoing body before send) and may **halt** the chain (`continue: false`).
   This is not fire-and-forget — moving it to cross-thread RPC would change semantics and cost.
2. **Engine plugins return live, process-bound objects.** `IEnginePlugin.createEngine()` yields
   Puppeteer-backed WhatsApp sessions that cannot be serialized or migrated to a worker.

**Threat model (chosen): trusted authors, contain accidents.** Plugins are written by the
operator / their team. The risk is *accidental* bugs — a plugin that hangs and blocks the send
pipeline, crashes the host, leaks a secret in logs, or touches more than it should — **not**
deliberately malicious code. Therefore true containment (worker_threads / isolated-vm) is out of
scope: it would break engine plugins and the synchronous hook pipeline for no benefit against
non-hostile code. The goal is **blast-radius containment + least privilege**.

## 2. Goals / Non-Goals

**Goals**
- A hanging or throwing plugin entrypoint cannot block or crash the host.
- A repeatedly-failing plugin is automatically neutralized (hooks removed) without manual ops.
- Plugins receive only the host capabilities they declare needing.
- Secret config values are redacted from plugin logs.
- Declared `net`/`fs` intent is auditable by the operator.

**Non-Goals**
- Defending against malicious/hostile plugin authors (no true sandbox).
- Runtime enforcement of `net`/`fs` access (impossible without a real sandbox; declarative only).
- Moving engine plugins or hook handlers out of process.

## 3. Design

### 3.1 Failure Isolation (blast radius)

**Timeouts on every plugin entrypoint.** Wrap each call in `Promise.race([call, timeout])`:
- Hook handlers (`HookManager.execute`, the `await registration.handler(ctx)` at the loop body).
- Lifecycle methods in the loader: `onLoad`, `onEnable`, `onDisable`, `onUnload`,
  `onConfigChange`, `healthCheck`.
- Two configurable limits: **hook** (default 5000 ms, runs on the hot path) and **lifecycle**
  (default 10000 ms, may legitimately take longer).
- A timeout rejects the call and counts as a failure (feeds the circuit breaker).

**Circuit breaker per plugin.** New service `PluginCircuitBreaker` in `core/plugins`:

```ts
recordSuccess(pluginId: string): void          // resets consecutive-failure counter
recordFailure(pluginId: string): boolean       // returns true if this call just tripped it
isTripped(pluginId: string): boolean
reset(pluginId: string): void
```

- Counts **consecutive** failures (throw or timeout). After threshold N (default 5) the plugin
  is "tripped".
- `HookManager` injects the breaker. In `execute()`: before running a handler, if
  `isTripped(pluginId)` → skip it. After running → `recordSuccess` / `recordFailure`. When a
  call trips the breaker → call `this.unregisterPlugin(pluginId)` (already an internal method)
  to remove its hooks in-flight, and log a warning.
- **No circular dependency:** the breaker lives beside the hook bus and self-cleans via
  `HookManager.unregisterPlugin`. The loader does not need to know about the breaker to neutralize
  a runaway plugin — removing its hooks disables it on the hot path. Lifecycle failures in the
  loader already set `status = ERROR` via existing code; the loader feeds the same breaker so
  lifecycle and hook failures share one counter.

### 3.2 Least Privilege (capabilities)

**Manifest declares permissions.** New optional field on `PluginManifest`:

```ts
permissions?: PluginPermission[];
type PluginPermission = 'storage' | 'services' | 'hooks' | 'net' | 'fs:read' | 'fs:write';
```

- **Field absent → permissive (all granted) + a "no declared permissions" warning at load.**
  This keeps existing engine plugins working and nudges authors to declare. Field present → the
  list is honored strictly.

**Host-enforced capabilities** (the host genuinely controls these). The loader injects into
`PluginContext` only what is granted:
- `storage` — without the `'storage'` permission, its methods throw `PluginPermissionDeniedError`
  and log the denial.
- `getService` — without `'services'`, returns `undefined` and logs (today it already returns
  `undefined`; we add an explicit gate + log).
- The raw `hookManager` is **removed** from `PluginContext` (it exposes the whole bus). Only
  `registerHook` remains. **Breaking change** for any plugin using `context.hookManager`
  directly — acceptable under the trusted model; called out here and in the changelog.
- `Object.freeze(context)` so a plugin cannot mutate shared capabilities.

**Declarative-only capabilities.** `net`, `fs:read`, `fs:write` are **not** runtime-enforced —
`require()` grants network/fs access regardless without a real sandbox. They are **audited**: at
load the host logs (and the dashboard can show) "plugin X declares: net, fs:write". This documents
intent and seeds a future real-sandbox effort. The spec states plainly that these are not
contained, to avoid selling false isolation.

**Secret redaction in logs.** `PluginLogger` wraps messages/meta and redacts values of config
keys marked `secret: true` in the plugin's `configSchema`, replacing them with `***` before
emitting.

### 3.3 Configuration

`env.validation.ts` + `configuration.ts`, new `plugins` block:

| Env | Default | Use |
|-----|---------|-----|
| `PLUGIN_HOOK_TIMEOUT_MS` | 5000 | hook handler timeout |
| `PLUGIN_LIFECYCLE_TIMEOUT_MS` | 10000 | lifecycle method timeout |
| `PLUGIN_CIRCUIT_BREAKER_THRESHOLD` | 5 | consecutive failures before tripping |

## 4. Components & Files

| File | Change |
|------|--------|
| `core/plugins/plugin-circuit-breaker.service.ts` | **new** — breaker state machine |
| `core/plugins/exceptions/plugin-permission-denied.error.ts` | **new** — denial error |
| `core/hooks/hook-manager.service.ts` | timeout + breaker in `execute()` |
| `core/plugins/plugin-loader.service.ts` | lifecycle timeouts, capability injection, freeze, redaction, audit log |
| `core/plugins/plugin.interfaces.ts` | add `permissions`; remove `hookManager` from `PluginContext` |
| `config/env.validation.ts`, `config/configuration.ts` | `plugins` config block |
| `*.spec.ts` for the above | tests |

## 5. Testing (TDD — red first)

- **`PluginCircuitBreaker`**: trips after N consecutive failures; `isTripped` causes handler skip;
  `recordSuccess` resets the counter; `reset` clears state.
- **Timeout**: a hanging handler rejects after the configured ms, counts as a failure, and trips
  after N.
- **Permissions**: context without `storage` → denied (throws); without `services` → `undefined`
  + log; with the permission → works; context is frozen (mutation throws in strict mode);
  absent `permissions` → permissive + warning.
- **Redaction**: logger hides values of `secret: true` config keys.
- **`HookManager.execute` integration**: breaker + timeout do not break the existing mutate /
  halt-chain semantics (data still flows through and `continue: false` still stops).

## 6. Risks & Mitigations

- **Breaking change (removed `hookManager` from context).** Mitigate: audit bundled plugins for
  direct `context.hookManager` use before merge; migrate to `registerHook`; note in changelog.
- **Default-permissive on absent `permissions`.** Intentional for back-compat; the load-time
  warning makes it visible. Bundled plugins should declare permissions in the same PR where
  feasible.
- **False sense of security from declarative `net`/`fs`.** Mitigated by explicit documentation
  that these are audit-only, not enforced.
