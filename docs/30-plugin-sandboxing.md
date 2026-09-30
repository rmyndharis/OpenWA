# 30 — Plugin Sandboxing

OpenWA runs **user-installed plugins** (anything loaded from the plugins directory) in an isolated
worker thread, separate from the first-party built-ins (the two engine adapters) which run in-process.
The worker is fault containment for a buggy or runaway plugin, not a security boundary against a
malicious one: installing a plugin is full host trust (see
[SECURITY.md](../SECURITY.md#plugins-are-full-host-trust--by-design)). This
page describes the security model honestly — what the sandbox guarantees and, just as important, what
it does not — and what changes for plugin authors.

## Trust tiers

| Tier                            | Examples                                           | Runs                 | Capabilities                       |
| ------------------------------- | -------------------------------------------------- | -------------------- | ---------------------------------- |
| **Built-in (trusted)**          | the two engine adapters (whatsapp-web.js, baileys) | in-process           | direct, full speed                 |
| **User-installed (full trust)** | anything in the plugins directory                  | in a `worker_thread` | only via the host-validated bridge |

The loader routes by tier automatically: a plugin registered programmatically is built-in; one loaded
from disk is user-installed and sandboxed.

## What the sandbox guarantees

- **No host-object access.** The worker runs in its own V8 context. It receives no reference to the
  loader, the engine, the database, `MessageService`, or any host singleton. Its only channel _to the
  host_ is a `MessagePort` — not its only channel out, see the limits below.
- **Capability mediation.** A plugin's only _sanctioned_ path to WhatsApp / the database / the network
  is the bridged `ctx.*` surface — `ctx.messages.*`, `ctx.engine.*`, `ctx.storage.*`, `ctx.net.fetch`, and
  `ctx.conversations` / `ctx.handover` / `ctx.mappings` — which round-trip to the host. The host runs
  each call through the same permission + session-scope checks an in-process plugin gets
  (`assertPermission` / declared `sessions`), so a sandboxed plugin can never exceed its declared
  manifest permissions on those verbs (the permission model gates the `ctx.*` verbs, not raw Node
  access — see the limits below). Verbs are allowlisted — a worker cannot invoke an arbitrary host
  method — and the router validates the string and mapping-key args before they reach a host service
  (other positional args are passed through as declared types, not re-checked). `ctx.net.fetch` is
  additionally bounded by the host SSRF guard and the manifest `net.allow` host list, so outbound
  HTTP through `ctx.net.fetch` is neither ambient nor unrestricted; a direct Node socket opened by
  the worker is not covered (see the limits below).
- **Host-initiated dispatches are mediated too.** Besides hooks, the host drives two other bridges into
  the worker over the same request/reply channel: inbound webhooks
  (`ctx.registerWebhook`, gated by the `webhook:ingress` permission and dropped for any route the
  manifest does not declare — see [25 — Integration Fabric](./25-integration-fabric.md)) and search
  queries (`ctx.registerSearchProvider` — see
  [27 — Plugin Search Providers](./27-plugin-search-providers.md)). The bridged `ctx.*` surface hands
  the plugin no listening socket and no route of its own — there is no `ctx.api` or `ctx.router`; the
  host terminates, authenticates and enqueues the delivery first.
- **Hook safety.** Hook handlers run in the worker and are dispatched with a **time budget**
  (`SANDBOX_HOOK_TIMEOUT_MS`, a hardcoded 5s). A slow or wedged handler is skipped (`continue: true`)
  once the budget runs out, so each sandboxed subscriber can delay the hook chain by at most 5 s per
  event, never indefinitely.
- **Resource & runaway containment.** Each worker has a heap cap (`maxOldGenerationSizeMb`, a hardcoded
  256 MB). An OOM terminates the worker, not the host. A wedged **lifecycle** call (load/unload) times out
  and tears the worker down, and a crash rejects its in-flight calls — the host survives either way. A
  runaway **hook** handler (e.g. an infinite synchronous loop) is skipped on the hook timeout. After any
  hook, webhook or search dispatch times out, the host sends the worker a liveness ping that the worker
  answers before running plugin code. A slow async handler answers at once and keeps running. A worker
  still working through a backlog of dispatches reads the ping late, but every result it returns counts
  as an answer. A worker whose event loop is blocked answers nothing for 5 s, so the host terminates it
  and sets the plugin to `ERROR` (no automatic restart, the same as a crash); the operator re-enables it
  once fixed.
- **Memory-kind boundary.** The heap cap bounds the V8 heap only. `Buffer`/`ArrayBuffer` allocations
  are native memory outside `maxOldGenerationSizeMb`, and worker threads share the host's address
  space, so a plugin that accumulates Buffers grows host RSS until the container's memory limit
  (the bundled compose `mem_limit`, default 2g) kills the whole container, not just the worker.
  Buffer-heavy plugin workloads need that outer limit sized deliberately.

## What the sandbox does NOT guarantee

> A `worker_thread` is a separate V8 context **in the same OS process, under the same user**. It is
> not an OS-level sandbox.

A worker still has access to Node built-ins — `require('fs')`, `process`, network sockets — and runs
as the same uid as OpenWA. The sandbox therefore does **not**, by itself, stop a malicious plugin
from reading files the OpenWA process can read or making outbound network connections. What it does
provide is narrower: the worker holds no references to host objects, its faults stay contained, and its
`ctx.*` calls are mediated. Against a plugin that abuses Node built-ins deliberately, it protects neither
the integrity nor the confidentiality of the host; see the reach list below.

The bundled compose stack adds **OS-level containment** as defence in depth. It limits what the OpenWA
process can do to the host; it does not confine a plugin away from anything that process can reach:

- **Run OpenWA in a container.** The image's entrypoint already drops to the non-root `openwa` user
  (via `gosu`, after fixing volume ownership), or can be started as that user (uid/gid 997) from the
  first instruction, with no capabilities added (the chart's `podSecurityContext`). The rest of the
  confinement comes from the bundled `docker-compose.yml`, not from the image: `read_only: true`
  rootfs with a tmpfs `/tmp`, `no-new-privileges`, and `cap_drop: ALL` with a minimal re-add
  (`CHOWN`/`DAC_OVERRIDE`/`FOWNER`/`SETGID`/`SETUID`) that only the root entrypoint uses — once `gosu`
  setuids, the Node process keeps no effective capabilities. A plain `docker run` of the image gets
  none of the compose-level settings, so replicate them yourself if you deploy that way.
- **What a loaded plugin can still reach.** Everything the OpenWA process can, including:
  - the process environment through `/proc/self/environ` on Linux, with every secret the deployment
    passes in (`API_MASTER_KEY`, `API_KEY_PEPPER`, `DATABASE_PASSWORD`, `REDIS_PASSWORD`). The worker's
    allowlisted `process.env` keeps those secrets out of the object the plugin is handed, not out of
    reach;
  - the data volume: the SQLite database, session auth state and `data/.env.generated`;
  - in the bundled compose stack, the `docker-proxy` sidecar at `tcp://docker-proxy:2375`, which can
    create a container with a host bind-mount (see
    [SECURITY.md](../SECURITY.md#docker-socket-proxy--scope-and-residual-risk)). If you do not use the
    built-in datastore orchestration, disable the proxy with the `docker-compose.override.yml` recipe
    in the `docker-proxy` comments of `docker-compose.yml`. The Helm chart ships no proxy.
- **Plugins you do not fully trust** do not belong in the OpenWA process: run them in a separate
  container or VM and reach OpenWA over its API like any other client.
- Until a marketplace exists, the standing guidance remains: **install only plugins you trust.**

A stronger isolation variant (child process with Node's permission model, or an `isolated-vm`) is a
possible future enhancement for maximum-hostility deployments; the transport is already abstracted
behind a channel interface so it can slot in without touching plugin code.

## What changes for plugin authors

Sandboxed plugins keep the same `IPlugin` shape (`onLoad`/`onEnable`/`onDisable`/`onUnload`,
`ctx.messages`, `ctx.engine`, `ctx.storage`, `ctx.net`, `ctx.conversations`, `ctx.handover`,
`ctx.mappings`, `ctx.registerHook`). Two entries are sandbox-only in practice:
`ctx.registerWebhook` is declared on the shared context but is functional only in a worker — an
in-process plugin that calls it fails loud rather than silently never firing — and
`ctx.registerSearchProvider` exists only in the worker context. The rules:

1. **Capability calls are remote.** They were already `async`; they now genuinely cross a thread
   boundary. Nothing to change in usage.
2. **Only serializable data crosses.** Hook payloads and capability args/results must be
   structured-clone-safe — plain objects, arrays, primitives, `Date`, typed arrays. **No functions,
   no class instances with methods, no live references.**
3. **No ambient host access.** `require('fs')`/`process` etc. still exist in the worker but must not
   be relied on as a capability — anything the plugin legitimately needs should be a declared
   capability.
4. **Declare your permissions.** A capability call is denied unless the manifest declares it:
   `messages:send` for `ctx.messages`, `engine:read` for `ctx.engine`, `net:fetch` for `ctx.net.fetch`
   (plus a `net.allow` host list), `conversation:send` for `ctx.conversations` / `ctx.handover` /
   `ctx.mappings`, `webhook:ingress` for `ctx.registerWebhook` (enforced at load and again at route
   subscription), `search:provide` for `ctx.registerSearchProvider` (enforced when the declaration
   reaches the host), and `storage:use` for `ctx.storage`. Storage was already confined to a
   per-plugin directory with a byte quota, so its permission is what makes the persistence visible in
   the manifest rather than what confines it. See
   [19 — Plugin Architecture](./19-plugin-architecture.md).

Sandboxing was a **breaking change for third-party plugin authoring** when it shipped in v0.6.0.
Built-in plugins were unaffected and still run in-process.

## Configuration

| Constant                                                   | Value   | Purpose                                                                                                                                    |
| ---------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `SANDBOX_MAX_OLD_GEN_MB` (worker `maxOldGenerationSizeMb`) | 256     | per-plugin V8-heap cap; a heap OOM kills the worker, not the host (native/Buffer memory is outside it, see the memory-kind boundary above) |
| `SANDBOX_HOOK_TIMEOUT_MS`                                  | 5000 ms | budget before a sandboxed hook handler is skipped                                                                                          |

Both are hardcoded constants in the plugin loader — **neither is an environment variable**, so
changing either requires a code change.
