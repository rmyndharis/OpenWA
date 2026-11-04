# openwa

Helm chart for [OpenWA](https://github.com/rmyndharis/OpenWA) — WhatsApp API.

> **Single instance only.** A session lease stops two pods from launching the same session,
> but API keys and the audit log live in each pod's own `main.sqlite` (a key revoked or
> narrowed on one pod stays valid on the others), and WS rate-limit buckets and in-flight
> bulk batches are process-local. Keep `replicaCount: 1`. See
> [docs/13-horizontal-scaling.md](../../docs/13-horizontal-scaling.md).

## Install

```bash
helm install openwa ./charts/openwa \
  --set secretEnv.API_MASTER_KEY=$(openssl rand -base64 32)
```

With `secretEnv.API_MASTER_KEY` left empty the app bootstraps a key into
`/app/data/.api-key` on the PVC; the post-install NOTES show how to read it.

## Configuration

`env` (→ ConfigMap) and `secretEnv` (→ Secret) are free-form maps: any variable
from the repo's `.env.example` works, e.g.:

```bash
helm install openwa ./charts/openwa \
  --set env.DATABASE_TYPE=postgres \
  --set env.DATABASE_HOST=postgres.default.svc \
  --set secretEnv.DATABASE_USERNAME=openwa \
  --set secretEnv.DATABASE_PASSWORD=...
```

Or bring your own Secret: `--set existingSecret=my-openwa-secret`.

The container port is fixed at 2785; do not set PORT in env (probes and the
Service targetPort are pinned to it) — service.port changes the Service port.

The kubelet startup probe allows `startupProbe.periodSeconds` x (`startupProbe.failureThreshold` - 1)
seconds for a boot, 295 by default. The first boot after an upgrade can build indexes on a large
`messages` table and convert its legacy message types before the port opens: raise
`startupProbe.failureThreshold`, or run the migrations first
([docs/14-migration-guide.md](../../docs/14-migration-guide.md), section 14.5).

Upgrade with `helm upgrade openwa ./charts/openwa --reset-then-reuse-values` (Helm 3.14 or later), or with
`-f values.yaml`. Plain `--reuse-values` renders the new templates with the old release's defaults, which
for a release installed from 0.24.0 keeps a 45 s `terminationGracePeriodSeconds` and a capability list
without `KILL`, so every pod stop ends in `SIGKILL`.

All other values (`persistence`, `resources`, `ingress`, `serviceMonitor`, …) are
documented inline in [values.yaml](values.yaml). The chart does NOT bundle
PostgreSQL/Redis/MinIO — point `env` at your own, or stay on the SQLite default.
