# openwa

Helm chart for [OpenWA](https://github.com/rmyndharis/OpenWA) — WhatsApp API.

> **Single instance only.** OpenWA is single-process with in-memory engine state.
> Keep `replicaCount: 1`; scaling out corrupts WhatsApp session auth. See
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

The container port is fixed at 2785; do not set PORT in env (probes and the
Service targetPort are pinned to it) — service.port changes the Service port.

```bash
helm install openwa ./charts/openwa \
  --set env.DATABASE_TYPE=postgres \
  --set env.DATABASE_HOST=postgres.default.svc \
  --set secretEnv.DATABASE_USERNAME=openwa \
  --set secretEnv.DATABASE_PASSWORD=...
```

Or bring your own Secret: `--set existingSecret=my-openwa-secret`.

All other values (`persistence`, `resources`, `ingress`, `serviceMonitor`, …) are
documented inline in [values.yaml](values.yaml). The chart does NOT bundle
PostgreSQL/Redis/MinIO — point `env` at your own, or stay on the SQLite default.
