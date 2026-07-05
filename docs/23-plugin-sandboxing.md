# 23 — Plugin Sandboxing

OpenWA runs **untrusted plugins** (anything loaded from the plugins directory) in an isolated worker
thread, separate from first-party built-ins (engines, bundled extensions) which run in-process. This
page describes the security model honestly — what the sandbox guarantees and, just as important, what
it does not — and what changes for plugin authors.

## Trust tiers

| Tier | Examples | Runs | Capabilities |
|------|----------|------|--------------|
| **Built-in (trusted)** | engines (whatsapp-web.js, baileys), bundled extensions (auto-reply, translation) | in-process | direct, full speed |
| **Untrusted** | anything in the plugins directory | in a `worker_thread` | only via the host-validated bridge |

The loader routes by tier automatically: a plugin registered programmatically is built-in; one loaded
from disk is untrusted and sandboxed.

## What the sandbox guarantees

- **No host-object access.** The worker runs in its own V8 context. It receives no reference to the
  loader, the engine, the database, `MessageService`, or any host singleton. Its only channel out is
  a `MessagePort`.
- **Capability mediation.** A plugin can touch WhatsApp / the database **only** through
  `ctx.messages.*` / `ctx.engine.*` / `ctx.storage.*`, which round-trip to the host. The host runs
  each call through the same permission + session-scope checks an in-process plugin gets
  (`assertPermission` / declared `sessions`), so a sandboxed plugin can never exceed its declared
  manifest permissions. Verbs are allowlisted — a worker cannot invoke an arbitrary host method.
- **Hook safety.** Hook handlers run in the worker and are dispatched with a **time budget**
  (`SANDBOX_HOOK_TIMEOUT_MS`, default 5s). A slow or wedged handler is skipped (`continue: true`) so
  it can never stall the host's hook chain.
- **Resource & runaway containment.** Each worker has a heap cap (`maxOldGenerationSizeMb`, default
  256). An OOM terminates the worker, not the host. A wedged **lifecycle** call (load/unload) times out
  and tears the worker down, and a crash rejects its in-flight calls — the host survives either way. A
  runaway **hook** handler (e.g. an infinite synchronous loop) is skipped on the hook timeout so it can't
  stall the host's hook chain, but the worker keeps running it (pegging a core) until the plugin is
  reloaded or hits the heap cap — it is contained to its own thread, not instantly force-killed.

## What the sandbox does NOT guarantee

> A `worker_thread` is a separate V8 context **in the same OS process, under the same user**. It is
> not an OS-level sandbox.

A worker still has access to Node built-ins — `require('fs')`, `process`, network sockets — and runs
as the same uid as OpenWA. The sandbox therefore does **not**, by itself, stop a malicious plugin
from reading files the OpenWA process can read or making outbound network connections. It protects
the *integrity* of the host (no host-object compromise, contained faults, mediated capabilities) — not
the *confidentiality* of the host filesystem against deliberate Node-builtin abuse.

For genuinely untrusted, third-party plugins, combine the sandbox with **OS-level containment**:

- **Run OpenWA in its container** (the shipped Docker image already runs read-only rootfs, non-root,
  and `cap_drop: ALL`), which bounds what any plugin's `fs`/network access can reach.
- Until a marketplace exists, the standing guidance remains: **install only plugins you trust.**

A stronger isolation variant (child process with Node's permission model, or an `isolated-vm`) is a
possible future enhancement for maximum-hostility deployments; the transport is already abstracted
behind a channel interface so it can slot in without touching plugin code.

## What changes for plugin authors

Sandboxed plugins keep the same `IPlugin` shape (`onLoad`/`onEnable`/`onDisable`/`onUnload`,
`ctx.messages`, `ctx.engine`, `ctx.storage`, `ctx.registerHook`), with these rules:

1. **Capability calls are remote.** They were already `async`; they now genuinely cross a thread
   boundary. Nothing to change in usage.
2. **Only serializable data crosses.** Hook payloads and capability args/results must be
   structured-clone-safe — plain objects, arrays, primitives, `Date`, typed arrays. **No functions,
   no class instances with methods, no live references.**
3. **No ambient host access.** `require('fs')`/`process` etc. still exist in the worker but must not
   be relied on as a capability — anything the plugin legitimately needs should be a declared
   capability, and OS containment may block direct access.
4. **Declare your permissions.** A capability call is denied unless the manifest declares it
   (`messages:send`, `engine:read`). See [19 — Plugin Architecture](./19-plugin-architecture.md).

This is a **breaking change for third-party plugin authoring** and ships in a minor release. Built-in
plugins are unaffected (they remain in-process).

## Configuration

| Env / constant | Default | Purpose |
|----------------|---------|---------|
| `maxOldGenerationSizeMb` (worker) | 256 | per-plugin heap cap; OOM kills the worker, not the host |
| hook handler timeout | 5000 ms | budget before a sandboxed hook handler is skipped |
