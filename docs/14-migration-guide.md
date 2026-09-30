# 14 - Migration Guide

## 14.1 Overview

This document provides a comprehensive guide for migrating OpenWA, including:

- Database migration (SQLite → PostgreSQL)
- Version upgrades within the 0.x line
- Transfer session authentication state
- Rollback procedures

```mermaid
flowchart TB
    subgraph Migration Types
        DB[Database Migration]
        VER[Version Upgrade]
        ENV[Environment Migration]
    end

    subgraph Targets
        DB --> PG[SQLite → PostgreSQL]
        DB --> SCALE[Single → Multi-node]
        VER --> MINOR[Minor Upgrade]
        VER --> MAJOR[Major Upgrade]
        ENV --> DEV[Dev → Staging]
        ENV --> PROD[Staging → Production]
    end
```

## 14.2 Pre-Migration Checklist

### Universal Checklist

```markdown
## Pre-Migration Checklist

### Backup

- [ ] Database backup completed (both connections: ./data/main.sqlite + the data store)
- [ ] Session auth backed up (SESSION_DATA_PATH, default ./data/sessions)
- [ ] Baileys auth backed up, if used (BAILEYS_AUTH_DIR, default ./data/baileys)
- [ ] Environment variables documented
- [ ] Docker volumes backed up (if applicable)

### Documentation

- [ ] Current version documented
- [ ] Active sessions list exported
- [ ] Webhook configurations exported
- [ ] API keys documented

### Communication

- [ ] Maintenance window scheduled
- [ ] Users notified
- [ ] Rollback plan prepared
- [ ] Support team briefed

### Verification

- [ ] Target environment ready
- [ ] Network connectivity tested
- [ ] Disk space sufficient (2x current size)
- [ ] New version tested in staging
```

## 14.3 Database Migration: SQLite → PostgreSQL

### When to Migrate

```mermaid
flowchart TD
    A[Current Setup] --> B{Check Conditions}
    B -->|Sessions > 5| C[Consider PostgreSQL]
    B -->|Messages > 100K| C
    B -->|Need HA| C
    B -->|Concurrent writes high| C
    B -->|Sessions ≤ 5| D[Stay with SQLite]
    B -->|Low volume| D
    C --> E[Plan Migration]
    D --> F[Optimize SQLite]
```

| Condition          | SQLite OK  | Migrate to PostgreSQL |
| ------------------ | ---------- | --------------------- |
| Sessions           | 1-5        | 6+                    |
| Messages/day       | < 10,000   | > 10,000              |
| Concurrent users   | < 10       | > 10                  |
| High Availability  | Not needed | Required              |
| Horizontal scaling | Not needed | Required              |

### API-Based Migration (Recommended for v0.2+)

OpenWA v0.2+ includes built-in migration API endpoints that leverage the **Dual-Database Architecture**:

```bash
# Step 1: Export all Data DB tables
curl -s 'http://localhost:2785/api/infra/export-data' \
  -H 'X-API-Key: YOUR_KEY' > data-backup.json

# Step 2: Change the database configuration
# Dashboard: Infrastructure > PostgreSQL + "Use Built-in PostgreSQL Container"; save, then
#   restart from the dashboard, which starts the container itself (skip Step 3).
# Or in the .env next to docker-compose.yml (compose does not forward POSTGRES_BUILTIN, so
#   name the host and set a real password):
#   DATABASE_TYPE=postgres
#   DATABASE_HOST=postgres
#   DATABASE_USERNAME=openwa
#   DATABASE_PASSWORD=<strong password>

# Step 3: Restart with the new configuration (.env route)
docker compose --profile postgres up -d

# Step 4: Import data to new database
curl -X POST 'http://localhost:2785/api/infra/import-data' \
  -H 'X-API-Key: YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d @data-backup.json
```

> [!IMPORTANT]
> Post the whole exported file, as the `-d @data-backup.json` above does. The import empties all 16
> migration tables before repopulating, so a hand-built body carrying only some keys restores the rest
> **empty**. The export also bounds the inline media it carries
> (`EXPORT_INLINE_MEDIA_BUDGET_BYTES`, 8 MiB by default); for a byte-exact copy including media, use
> `scripts/backup.sh`, which snapshots the database file itself.

> [!IMPORTANT]
> **The import is one request, bounded by the target's `BODY_SIZE_LIMIT`** (default `25mb`); a larger
> file is refused with `413`. Compare `ls -l data-backup.json` with that limit before Step 4. If the
> file is bigger, set `BODY_SIZE_LIMIT` on the target to at least its size (for example `50mb`) and
> restart, since the value is read at boot; put it back afterwards, because it applies to every route.
> An explicit `INFLIGHT_BODY_BUDGET_BYTES` must stay at least twice the file size, because one caller
> may hold only half of it; a body above that share is refused with `503`. `EXPORT_INLINE_MEDIA_BUDGET_BYTES`
> bounds inline media only, so a long text history can still pass the limit and needs the memory to
> parse it on both ends.
>
> **Credentials do not travel.** Webhooks are restored without their `secret` and custom `headers`, so
> deliveries go unsigned until you set them again with `PUT /api/sessions/:sessionId/webhooks/:id`. A
> session `proxyUrl` keeps its host but loses its `user:pass`, so a proxy that needs authentication
> fails the session's next start until you re-enter it with `PATCH /api/sessions/:sessionId/proxy`.

> [!NOTE]
> **Session statuses in the backup describe the source host.** An active status (`ready`,
> `initializing`, ...) is restored as `disconnected` (the import response counts them in a notice),
> so the migrated sessions are immediately startable - via `POST /api/sessions/:id/start`, or by
> the auto-start/takeover paths - without restarting the process. A session held by a live peer
> whose claim the import preserves keeps the backup's status.

> [!NOTE]
> **Dual-Database Architecture**
>
> OpenWA separates databases:
>
> - **Main DB** (SQLite): API keys, audit logs - never migrated, always local
> - **Data DB** (Pluggable): Sessions, webhooks, messages - this is what gets migrated
>
> See [05 - Database Design: Dual-Database Architecture](./05-database-design.md#dual-database-architecture)

**Export Response Example:**

```json
{
  "exportedAt": "2026-02-05T02:30:00.000Z",
  "dataDbType": "sqlite",
  "tables": {
    "sessions": [...],
    "webhooks": [...],
    "messages": [...],
    "messageBatches": [...],
    "templates": [...],
    "baileysStoredMessages": [...],
    "lidMappings": [...],
    "chatStates": [...],
    "pluginInstances": [...],
    "conversationMappings": [...],
    "ingressEvents": [...],
    "webhookDeliveryFailures": [...],
    "webhookOutboxEvents": [...],
    "integrationDeliveryFailures": [...],
    "statusUpdates": [...],
    "automationRules": [...]
  },
  "counts": {
    "sessions": 5,
    "webhooks": 12,
    "messages": 1500,
    "messageBatches": 3,
    "templates": 4,
    "baileysStoredMessages": 0,
    "lidMappings": 87,
    "chatStates": 24,
    "pluginInstances": 2,
    "conversationMappings": 31,
    "ingressEvents": 12,
    "webhookDeliveryFailures": 0,
    "webhookOutboxEvents": 0,
    "integrationDeliveryFailures": 0,
    "statusUpdates": 19,
    "automationRules": 7
  },
  "skippedTables": []
}
```

> [!NOTE]
> `skippedTables` lists optional tables absent from an older schema; the import tolerates them.

> [!NOTE]
> **Timestamps travel as UTC.** Every stamp in the archive is ISO 8601 with an explicit `Z`, and both
> dialects store it as the same instant, so an archive moves between SQLite and PostgreSQL in either
> direction without shifting and a repeated restore is a no-op. On PostgreSQL that is the connection's
> UTC pin ([05 - Database Design](./05-database-design.md#timestamps-on-postgresql-are-utc)), not a
> property of the host: a gateway restoring under `TZ=Asia/Jakarta` writes the same rows as one on UTC.
> An archive taken by 0.23.5 or earlier from a PostgreSQL gateway that ran off UTC carries that host's
> offset in its `DEFAULT now()` stamps, and one more offset in every stamp for each restore the table
> had been through; read the 0.23.6 upgrade notes in `CHANGELOG.md` before restoring one.

### Storage Migration (Local ↔ S3/MinIO)

OpenWA v0.2+ supports migrating media files between storage backends:

On an S3/MinIO backend, confirm `GET /api/infra/status` reports `storage.s3Available: true` before the
export (S3 to Local) and before the import (Local to S3). Until the bucket has been reachable once since
boot, these routes answer `503` instead of running against the local fallback directory. `s3Available`
does not go back to `false` until a restart, so it shows the bucket came up, not that it is still up: an
outage after that makes the count and the export fail with `500`, and the import answer `imported: false`
with the entries counted in `failed`.

```bash
# Step 1: Check current storage file count
curl -s 'http://localhost:2785/api/infra/storage/files/count' \
  -H 'X-API-Key: YOUR_KEY'
# Response: { "storageType": "local", "count": 150, "sizeBytes": 15000000 }

# Step 2: Export all files as tar.gz
curl -s 'http://localhost:2785/api/infra/storage/export' \
  -H 'X-API-Key: YOUR_KEY'
# Response: { "message": "Storage export completed", "download": "data/exports/storage-export-xxx.tar.gz" }
# The archive is auto-removed after STORAGE_EXPORT_TTL_MS (default 1h), so re-import it before then.
# It is written under data/ so it survives the restart in Step 4 and stays import-able.

# Step 3: Change the storage configuration
# Dashboard: Infrastructure > Amazon S3 + "Use Built-in MinIO Container"; save, then
#   restart from the dashboard, which starts the container itself (skip Step 4).
# Or in the .env next to docker-compose.yml (compose does not forward MINIO_BUILTIN, so
#   name the endpoint and set real keys):
#   STORAGE_TYPE=s3
#   S3_ENDPOINT=http://minio:9000
#   S3_ACCESS_KEY_ID=<user>
#   S3_SECRET_ACCESS_KEY=<strong password>
# For external S3, set STORAGE_TYPE=s3, S3_BUCKET, S3_REGION and that store's keys instead
#   (S3_ENDPOINT only for an S3-compatible store), and drop --profile minio in Step 4.

# Step 4: Restart with the new configuration (.env route)
docker compose --profile minio up -d

# Step 5: Import files to new storage
curl -X POST 'http://localhost:2785/api/infra/storage/import' \
  -H 'X-API-Key: YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"filePath": "data/exports/storage-export-xxx.tar.gz"}'
```

| Scenario                     | Support | Method                   |
| ---------------------------- | ------- | ------------------------ |
| Local → Built-in MinIO       | ✅      | Export → Config → Import |
| Local → External S3          | ✅      | Export → Config → Import |
| Built-in MinIO → External S3 | ✅      | Export → Config → Import |
| S3 → Local                   | ✅      | Export → Config → Import |

The built-in storage (the compose `minio` profile and the dashboard's built-in option) runs
`pgsty/silo`, a maintained MinIO fork, on the same `openwa_minio-data` volume. An `openwa-minio`
container created from the older `minio/minio` image keeps running it until it is recreated: on the
compose route run `docker compose --profile minio pull minio && docker compose --profile minio up -d minio`;
for the dashboard built-in run `docker rm -f openwa-minio`, then restart OpenWA or re-save the
built-in storage. The recreated dashboard built-in container publishes no host ports: the older one
published the S3 API and console on `127.0.0.1:9000` and `127.0.0.1:9001`, and OpenWA reaches the new
one over the Docker network alone. For host access to either, run storage through the compose `minio`
profile, which still publishes both on loopback. The compose `minio` service no longer starts without `S3_ACCESS_KEY_ID` and
`S3_SECRET_ACCESS_KEY` in the `.env` next to `docker-compose.yml`: a container that ran with neither
set used `minioadmin`/`minioadmin`, so set them to the pair OpenWA uses before recreating it. If
OpenWA uses the dashboard built-in storage, drop the `minio`/`full` profile and take the dashboard
route instead. The volume and its media are kept either way.

### Redis Migration (Cache)

Redis in OpenWA holds only **ephemeral** state: TTL-based cache entries, BullMQ jobs (see below), and — when `REDIS_ENABLED` — the rate-limit hit counters. Cache data automatically regenerates from the database.

**No migration API needed** - just change configuration:

```bash
# Switch from built-in to external Redis
REDIS_ENABLED=true
REDIS_BUILTIN=false      # false = external Redis
REDIS_HOST=your-redis-host.com
REDIS_PORT=6379
REDIS_USERNAME=optional
REDIS_PASSWORD=optional
```

> Setting `REDIS_BUILTIN` in `.env` **pins** it: the env value wins, so the dashboard's built-in
> Redis toggle can no longer switch the container back on. That is the right trade for a deployment
> whose configuration lives in `.env` — but if you manage datastores from the dashboard, leave the
> key unset (as the shipped templates do) and set only the connection details above. The same holds
> for `POSTGRES_BUILTIN` and `MINIO_BUILTIN`.

| Scenario                  | Support | Notes                                      |
| ------------------------- | ------- | ------------------------------------------ |
| Built-in → External Redis | ✅      | Config change only                         |
| External → Built-in Redis | ✅      | Config change only                         |
| Enable → Disable Redis    | ✅      | Cache no-ops; reads fall through to the DB |
| Disable → Enable Redis    | ✅      | Cache rebuilds automatically               |

> [!TIP]
> **Cache Warm-up**: After switching Redis instances, the cache will automatically rebuild as requests come in. No data migration is necessary.

### BullMQ Migration (Queue System)

BullMQ stores job data in Redis. When switching Redis instances, pending jobs may be lost.

**Best Practice - Drain Queue Before Switching:**

```bash
# Step 1: Read both queues' depth from Bull Board's JSON route. Bull Board takes an ADMIN key only in
# a request header (X-API-Key or Authorization: Bearer), never in the URL, so a plain browser tab on
# /api/admin/queues gets 401; open the HTML board through a reverse proxy or client that adds one.
curl -s 'http://localhost:2785/api/admin/queues/api/queues' \
  -H 'X-API-Key: ADMIN_KEY' | jq '.queues[] | {name, waiting: .counts.waiting, active: .counts.active, delayed: .counts.delayed}'

# Step 2: Wait until waiting, active and delayed are 0 for both webhook-queue and ingress-queue
# (there is no MESSAGE queue). /api/infra/status is a shortcut for the webhook queue only: it does
# not count ingress-queue, and it reports zeros when Redis is unreachable.
curl -s 'http://localhost:2785/api/infra/status' \
  -H 'X-API-Key: ADMIN_KEY' | jq '.queue.webhooks.pending'
# Wait for: 0

# Step 3: Change Redis configuration
REDIS_HOST=new-redis-host.com

# Step 4: Restart application
docker compose up -d
```

| Scenario                  | Support | Notes             |
| ------------------------- | ------- | ----------------- |
| Queue Disabled → Enabled  | ✅      | Config change     |
| Queue Enabled → Disabled  | ⚠️      | Drain queue first |
| Built-in → External Redis | ⚠️      | Drain queue first |

> [!WARNING]
> **Job Loss Prevention**: Always ensure the `webhook-queue` and `ingress-queue` queues are empty before switching Redis instances (there is no MESSAGE queue). Check both with the header-authenticated Bull Board JSON route in Step 1; the `/api/admin/queues` board needs an ADMIN key in the `X-API-Key` header or as an `Authorization: Bearer` token (never in the URL), so a browser reaches it only through a reverse proxy that adds one.

### Infrastructure Migration Summary

| Component    | Migration Method     | API Endpoint                                             |
| ------------ | -------------------- | -------------------------------------------------------- |
| **Database** | Export/Import JSON   | `/api/infra/export-data`, `/api/infra/import-data`       |
| **Storage**  | Export/Import tar.gz | `/api/infra/storage/export`, `/api/infra/storage/import` |
| **Redis**    | Config change only   | N/A (cache auto-rebuilds)                                |
| **BullMQ**   | Drain then config    | N/A (wait for empty queues)                              |

### Migration Script (Legacy)

> **Note:** This is an illustrative standalone script, not a shipped one — there is no
> `scripts/migrate-sqlite-to-postgres.ts` in the repo. Save it locally before running it, and prefer
> the export/import API above, which always covers the full table set. The script copies only the
> tables named in its `migrationOrder`, which mirrors `EXPORT_TABLES` in
> `src/modules/infra/export-tables.ts` as of this release; a table added later is skipped silently.
>
> It uses the standalone `sqlite3` npm package, which is no longer part of
> OpenWA's dependencies (the app itself uses `better-sqlite3`). Install it ad hoc before running:
> `npm install --no-save sqlite3`.
>
> The `SQLITE_PATH` / `DATABASE_URL` variables below are inputs to this standalone script only —
> they are **not** OpenWA configuration. The application itself reads `DATABASE_TYPE` plus
> `DATABASE_NAME` / `DATABASE_HOST` / `DATABASE_PORT` / `DATABASE_USERNAME` / `DATABASE_PASSWORD`
> (see `src/config/configuration.ts`).

```typescript
// migrate-sqlite-to-postgres.ts — illustrative, not shipped in the repo

import { DataSource } from 'typeorm';
import * as sqlite3 from 'sqlite3';
import { Client } from 'pg';

interface MigrationConfig {
  sqlitePath: string;
  postgresUrl: string;
  batchSize: number;
}

interface MigrationResult {
  table: string;
  rowsMigrated: number;
  duration: number;
  errors: string[];
}

async function migrateSqliteToPostgres(config: MigrationConfig): Promise<MigrationResult[]> {
  const results: MigrationResult[] = [];

  // 1. Connect to both databases
  console.log('🔌 Connecting to databases...');

  const sqliteDb = new sqlite3.Database(config.sqlitePath);
  const pgClient = new Client({ connectionString: config.postgresUrl });
  await pgClient.connect();

  // 2. Get list of tables
  const tables = await getSqliteTables(sqliteDb);
  console.log(`📋 Found ${tables.length} tables to migrate`);

  // 3. Migration order (respect foreign keys). Data-DB tables only — the Main DB
  //    (api_keys, audit_logs) is always local SQLite and is never migrated.
  const migrationOrder = [
    'sessions',
    'webhooks',
    'messages',
    'message_batches',
    'templates',
    'baileys_stored_messages',
    'lid_mappings',
    'chat_states',
    'plugin_instances',
    'conversation_mappings',
    'ingress_events',
    'webhook_delivery_failures',
    'webhook_outbox_events',
    'integration_delivery_failures',
    'status_updates',
    // ON DELETE CASCADE FK to sessions, so it must follow them.
    'automation_rules',
  ];

  // 4. Migrate each table
  for (const table of migrationOrder) {
    if (!tables.includes(table)) continue;

    const startTime = Date.now();
    const result = await migrateTable(sqliteDb, pgClient, table, config.batchSize);
    result.duration = Date.now() - startTime;
    results.push(result);

    console.log(`✅ ${table}: ${result.rowsMigrated} rows in ${result.duration}ms`);
  }

  // 5. Reset sequences
  await resetPostgresSequences(pgClient, migrationOrder);

  // 6. Cleanup
  sqliteDb.close();
  await pgClient.end();

  return results;
}

async function migrateTable(
  sqlite: sqlite3.Database,
  pg: Client,
  table: string,
  batchSize: number,
): Promise<MigrationResult> {
  const result: MigrationResult = {
    table,
    rowsMigrated: 0,
    duration: 0,
    errors: [],
  };

  return new Promise(resolve => {
    let offset = 0;

    const processBatch = () => {
      sqlite.all(`SELECT * FROM ${table} LIMIT ${batchSize} OFFSET ${offset}`, async (err, rows: any[]) => {
        if (err) {
          result.errors.push(err.message);
          resolve(result);
          return;
        }

        if (rows.length === 0) {
          resolve(result);
          return;
        }

        // Insert into PostgreSQL
        for (const row of rows) {
          try {
            // Entity columns are camelCase (e.g. sessionId); PostgreSQL folds unquoted
            // identifiers to lowercase, so they must be quoted or the INSERT fails.
            const columns = Object.keys(row).map(column => `"${column}"`);
            const values = Object.values(row);
            const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

            await pg.query(
              `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})
                 ON CONFLICT DO NOTHING`,
              values,
            );
            result.rowsMigrated++;
          } catch (insertErr: any) {
            result.errors.push(`Row error: ${insertErr.message}`);
          }
        }

        offset += batchSize;
        processBatch();
      });
    };

    processBatch();
  });
}

async function resetPostgresSequences(pg: Client, tables: string[]): Promise<void> {
  for (const table of tables) {
    try {
      await pg.query(`
        SELECT setval(
          pg_get_serial_sequence('${table}', 'id'),
          COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1,
          false
        )
      `);
    } catch (err) {
      // Table might not have serial id
    }
  }
}

function getSqliteTables(db: sqlite3.Database): Promise<string[]> {
  return new Promise((resolve, reject) => {
    db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", (err, rows: any[]) => {
      if (err) reject(err);
      else resolve(rows.map(r => r.name));
    });
  });
}

// CLI Entry point
const config: MigrationConfig = {
  sqlitePath: process.env.SQLITE_PATH || './data/openwa.sqlite',
  postgresUrl: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/openwa',
  batchSize: parseInt(process.env.BATCH_SIZE || '1000'),
};

migrateSqliteToPostgres(config)
  .then(results => {
    console.log('\n📊 Migration Summary:');
    console.table(
      results.map(r => ({
        Table: r.table,
        Rows: r.rowsMigrated,
        'Time (ms)': r.duration,
        Errors: r.errors.length,
      })),
    );
  })
  .catch(console.error);
```

### Step-by-Step Migration

This flow runs the legacy script on the host, so the host must be able to read the SQLite file and
reach the PostgreSQL server. The shipped production compose file allows neither: its SQLite file lives
in the `openwa-data` volume, and the built-in `postgres` service publishes no host port. Use the
API-based migration above there. What follows moves `docker-compose.dev.yml` (which bind-mounts
`./data`) to a PostgreSQL server of your own: add `-f docker-compose.dev.yml` to each `docker compose`
command. On a bare-metal install, stop and start the process where it says `docker compose`.

```bash
# Step 1: Stop OpenWA
docker compose down

# Step 2: Backup current data (both databases + session auth + media)
./scripts/backup.sh

# Step 3: Point OpenWA at PostgreSQL in the project's .env. docker-compose.dev.yml forwards these
#         keys to the app, and a bare-metal start reads the file itself. DATABASE_HOST is the
#         address the APP connects to, so never localhost for a container.
#   DATABASE_TYPE=postgres
#   DATABASE_HOST=db.example.com
#   DATABASE_PORT=5432
#   DATABASE_NAME=openwa
#   DATABASE_USERNAME=openwa
#   DATABASE_PASSWORD=<strong password>
#   DATABASE_SYNCHRONIZE=false   # docker-compose.dev.yml defaults it to true

# Step 4: Start OpenWA once so its migrations create the schema the script writes into, then stop it
docker compose up -d
curl http://localhost:2785/api/health   # repeat until it answers
docker compose down

# Step 5: Copy the rows. Save the "Migration Script (Legacy)" example above as
#         migrate-sqlite-to-postgres.ts first; it is not shipped in the repo. SQLITE_PATH and
#         DATABASE_URL are inputs to the script only.
export DATABASE_URL='postgresql://openwa:<strong password>@db.example.com:5432/openwa'
SQLITE_PATH=./data/openwa.sqlite npx ts-node migrate-sqlite-to-postgres.ts

# Step 6: Verify migration
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM sessions;"
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM messages;"

# Step 7: Start with PostgreSQL
docker compose up -d

# Step 8: Verify functionality
curl http://localhost:2785/api/health
```

### Verification Queries

```sql
-- Compare row counts
-- Run on both SQLite and PostgreSQL. Data DB only — api_keys and audit_logs stay in the local Main DB.

-- Sessions
SELECT 'sessions' as table_name, COUNT(*) as count FROM sessions
UNION ALL
SELECT 'messages', COUNT(*) FROM messages
UNION ALL
SELECT 'message_batches', COUNT(*) FROM message_batches
UNION ALL
SELECT 'webhooks', COUNT(*) FROM webhooks;

-- Verify foreign key integrity (entity columns are camelCase — quote them)
SELECT m.id, m."sessionId"
FROM messages m
LEFT JOIN sessions s ON m."sessionId" = s.id
WHERE s.id IS NULL;

-- Check for data integrity
SELECT "sessionId", COUNT(*) as msg_count
FROM messages
GROUP BY "sessionId"
ORDER BY msg_count DESC
LIMIT 10;
```

## 14.4 Session Auth State Transfer

### Understanding Session Auth

```
whatsapp-web.js (LocalAuth) — SESSION_DATA_PATH, default ./data/sessions
./data/sessions/
├── session-{sessionId}/
│   ├── Default/
│   │   ├── IndexedDB/
│   │   ├── Local Storage/
│   │   └── Session Storage/
│   └── ... (Chrome profile data)

Baileys — BAILEYS_AUTH_DIR, default ./data/baileys
./data/baileys/
└── {sessionId}/            # multi-file auth state
```

> [!IMPORTANT]
> **Directories are keyed by the session id**, the same UUID the API addresses a session by
> (`/api/sessions/{sessionId}`): the on-disk profile is `session-<id>` (whatsapp-web.js) or `<id>`
> (Baileys). Up to 0.23.4 they were keyed by the session NAME; 0.23.5 renames them onto the id at
> first boot, so a directory copied off an older install still carries a name and has to be renamed
> to the target's session id by hand.

### Transfer Methods

#### Method 1: Direct File Copy (Server to Server)

Moves the auth profile only. The session's database record is created separately — either by
`POST /api/sessions` on the target, or with the infra export/import of Method 2. Copying rows
between SQLite files by hand is not supported: the `sessions` table carries columns the copy would
have to reproduce exactly, and a mismatch corrupts the row.

The profile directory is named after the session id, and a session created with `POST /api/sessions`
on the target gets a **new** id, so the copy below renames the directory as it lands. Method 2
carries the ids over unchanged and needs no rename.

Under the shipped compose the data directory lives in a named Docker volume
(`openwa-data:/app/data`), not a host bind mount, so the profile is copied through the container
with `docker compose cp` rather than straight off the host filesystem. `APP_DIR` is the directory
holding `docker-compose.yml` on each server; `OLD_ID` and `NEW_ID` are the session ids on the source
and the target (`GET /api/sessions` on each).

```bash
APP_DIR=/srv/openwa            # docker compose project directory on both hosts
OLD_ID=3f1c...                 # id on the source host
NEW_ID=9a2e...                 # id of the session created on the target host

# 1. Stop the app on both hosts. Use `stop`, not `down`: a running engine holds the profile open,
#    but `down` removes the container that step 2 copies through.
ssh old-server "cd $APP_DIR && docker compose stop openwa-api"
ssh new-server "cd $APP_DIR && docker compose stop openwa-api"

# 2. Copy the auth profile out of the source container, to the target host, and back in.
#    whatsapp-web.js: /app/data/sessions/session-<id>.
#    Baileys:         /app/data/baileys/<id> (no "session-" prefix).
ssh old-server "cd $APP_DIR && docker compose cp \
    openwa-api:/app/data/sessions/session-$OLD_ID ./session-$OLD_ID"
rsync -avz --progress "old-server:$APP_DIR/session-$OLD_ID/" \
    "new-server:$APP_DIR/session-$NEW_ID/"
ssh new-server "cd $APP_DIR && docker compose cp \
    ./session-$NEW_ID openwa-api:/app/data/sessions/session-$NEW_ID"

# 3. Start the target back up.
ssh new-server "cd $APP_DIR && docker compose start openwa-api"
```

Delete the staging copies (`$APP_DIR/session-$OLD_ID` and `$APP_DIR/session-$NEW_ID`) afterwards — they hold
live WhatsApp credentials.

#### Method 2: Records via the Infra API + auth state by file copy

There is **no per-session export/import endpoint** — the session controller exposes only lifecycle and
chat operations. What ships is a whole-Data-DB export at `/api/infra/export-data` and
`/api/infra/import-data` (see [14.3](#143-database-migration-sqlite--postgresql)); it carries the session
_records_, not the on-disk authentication state. A server-to-server move is therefore two steps:

```bash
# 1. Move the Data DB records (sessions, webhooks, messages, …)
curl -s 'http://old-server:2785/api/infra/export-data' \
  -H 'X-API-Key: OLD_KEY' > data-backup.json

curl -X POST 'http://new-server:2785/api/infra/import-data' \
  -H 'X-API-Key: NEW_KEY' \
  -H 'Content-Type: application/json' \
  -d @data-backup.json

# 2. Move the engine auth state with both instances stopped. The import preserves session ids, so
#    the directories transfer as they are, with no rename.
#    OLD_DIR/NEW_DIR are each host's OpenWA working directory; SESSION_DATA_PATH defaults to
#    ./data/sessions and BAILEYS_AUTH_DIR to ./data/baileys, relative to it. The production
#    docker-compose.yml keeps /app/data in the named volume `openwa_openwa-data` rather than on the
#    host, so on that layout copy through the container (`docker cp`) instead of a host path.
rsync -avz "old-server:${OLD_DIR}/data/sessions/" "${NEW_DIR}/data/sessions/"
rsync -avz "old-server:${OLD_DIR}/data/baileys/" "${NEW_DIR}/data/baileys/"   # Baileys sessions only
```

Sessions whose auth directory is not copied arrive as records only and must be re-paired by scanning a
fresh QR code.

## 14.5 Version Upgrade Guide

### Upgrade Matrix

OpenWA is pre-1.0 — every release to date is on the `0.x` line. Under the project's SemVer 0.x policy a
breaking change, or anything the CHANGELOG files under **Upgrade notes (behavior changes)**, bumps the
**minor** (`0.10.x` → `0.11.0`) and everything else is a patch, so a minor bump is the
one that warrants reading the release notes closely. The rule holds from `0.24.0`: earlier patches did not
always follow it (`0.23.3` and `0.23.5` to `0.23.7` carried Upgrade notes; section 15.2 of docs/15 lists
every exception), so an upgrade across one of them needs its CHANGELOG notes read.

| From                  | To                  | Migration Type                                                   | Downtime  |
| --------------------- | ------------------- | ---------------------------------------------------------------- | --------- |
| `0.x.y`               | `0.x.z` (patch)     | Pending migrations only                                          | < 5 min   |
| `0.x.y`               | `0.(x+1).0` (minor) | Pending migrations + review the breaking notes and Upgrade notes | 5-15 min  |
| Several releases back | Current             | Same — the migration chain replays in order                      | 10-15 min |

Upgrades are cumulative: migrations apply in order from wherever the schema currently sits, so jumping
straight to the current release is supported. There is no required intermediate stop — but read every
intervening `CHANGELOG.md` entry, because behavior changes are not replayed by migrations.

Schema migrations run automatically at boot on both connections. The **data** connection always runs
them on PostgreSQL, and on SQLite unless `DATABASE_SYNCHRONIZE=true` puts the data store in synchronize
mode. The Main (auth/audit) connection runs its own `migrations-main/` chain at every boot. The chain is
idempotent, so a `main.sqlite` that an earlier release built with synchronize is adopted in place (rows
kept, missing columns added, the ledger written). `MAIN_DATABASE_SYNCHRONIZE=true` only adds a
synchronize pass after the chain. Run the main chain by hand with `npm run migration:run:main`.

### Upgrade Steps

```bash
#!/bin/bash
# upgrade.sh — same shape for a patch or a minor
set -e

# Started with docker-compose.dev.yml (the README Quick Start)? Add `-f docker-compose.dev.yml` to
# every docker compose command in this script, in the migration block right after it, and in 14.6
# Rollback Procedures, and write `openwa` wherever a command names the `openwa-api` service. Do NOT
# carry the flag up to the `--profile postgres` commands in 14.3: postgres exists only in the
# production compose file.

# 1. Backup: both databases + session auth + media + plugin state. Take it in the running container,
#    where the data is mounted, and copy the archive to ./backups, as 11 - Runbook: Database Backup
#    does. A host run of ./scripts/backup.sh archives ./data in the checkout, which the production
#    compose never reads. docker exec and docker cp name the container, openwa-api under both compose
#    files, so these lines keep that name and take no -f flag. An older image may not be able to run
#    this step: see Known Upgrade Hazards below.
mkdir -p ./backups
docker exec -e BACKUP_DIR=/app/data/backups -e TMPDIR=/app/data/backups openwa-api ./scripts/backup.sh
docker cp openwa-api:/app/data/backups/. ./backups/

# 2. Stop the current version
docker compose down

# 3. Move to the new version
#    The repo's compose file BUILDS the API image from source:
git pull && docker compose up -d --build
#    Deployments pinned to a published image instead (ghcr.io/rmyndharis/openwa:<version>)
#    bump the tag in their compose file, then: docker compose pull openwa-api && docker compose up -d --no-build

# 4. Wait for health — every route lives under the /api prefix
for i in {1..30}; do
  if curl -sf http://localhost:2785/api/health > /dev/null; then
    echo "✅ Health check passed"
    break
  fi
  sleep 2
done

# 5. Confirm the running version (`version` is only included for an authenticated request)
curl -s -H "X-API-Key: $API_KEY" http://localhost:2785/api/health | jq '.version'

# 6. Verify sessions came back
curl -s -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions | jq '.[] | {id, name, status}'
```

> [!NOTE]
> `GET /api/sessions` returns a bare array — responses carry no `{success, data}` envelope, so filter with
> `jq '.[]'`, never `jq '.data[]'`.

Migrations can also be run explicitly against a stopped app — useful when a long index build would
outlast an orchestrator's liveness grace:

```bash
docker compose run --rm openwa-api npm run migration:run:prod
```

> [!WARNING]
> Use `migration:run:prod` inside the production image. Plain `npm run migration:run` needs `ts-node` and
> the TypeScript sources, both stripped by `npm ci --omit=dev` in the released image.

### Known Upgrade Hazards

| Release  | Change                                                                                                                                                                                                                                                                                                                         | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0.24.0` | A live key refused by its `allowedIps` (including an undeterminable client IP) or its `allowedSessions` answers `403` instead of `401`; `401` now means only a missing, unknown, revoked or expired key                                                                                                                        | Handle `403` for these refusals: SDK callers catch the forbidden error (Go `ErrForbidden`) instead of the auth error                                                                                                                                                                                                                                                                                                                                                           |
| `0.24.0` | Every `POST /mcp` request needs a valid API key: `initialize` and `tools/list` without one answer `401`, a tool call with a missing or invalid key gets `401` instead of an `isError` result, and a key with `allowedIps` is refused with `403` on every request                                                               | Configure the API key in every MCP client, including one that only lists tools, and use a key without `allowedIps` for MCP                                                                                                                                                                                                                                                                                                                                                     |
| `0.24.0` | `GET /api/sessions/:sessionId/contacts/check/:number` and the MCP `ContactCheckNumber` tool require an OPERATOR key; a VIEWER key gets `403`                                                                                                                                                                                   | Give number-check integrations an OPERATOR key                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `0.24.0` | Setting or clearing a session proxy, through `PATCH /api/sessions/:sessionId/proxy` or `proxyUrl` on `POST /api/sessions`, requires an unscoped ADMIN key; any other key gets `403`, and a create carrying `proxyUrl` is refused before the session exists                                                                     | Use an ADMIN key for proxy changes; reading the proxy is unchanged                                                                                                                                                                                                                                                                                                                                                                                                             |
| `0.24.0` | `DELETE /api/sessions/:sessionId/chats/:chatId/messages` and `POST /api/sessions/:sessionId/chats/delete` also remove the gateway's stored copies of the chat's messages (rows, inline and archived media, search entries) once the engine reports success                                                                     | Export whatever must be kept from a chat's stored messages and media before clearing or deleting the chat                                                                                                                                                                                                                                                                                                                                                                      |
| `0.24.0` | `main.sqlite` (API keys and audit log) runs its `migrations-main/` chain at every boot instead of defaulting to synchronize, adopting an older file in place; boot stops with a `MainSchemaMismatchError` when the ledger records a migration this release does not ship, or an entity column is still missing after the chain | Back up `main.sqlite` before upgrading. The refusal names the migration or column; [05 - Database Design, section 5.6](./05-database-design.md#56-migration-strategy) gives the recovery for each                                                                                                                                                                                                                                                                              |
| `0.24.0` | The built-in storage runs `pgsty/silo` in place of the withdrawn `minio/minio` image; the compose `minio` service no longer starts without `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, and a recreated dashboard built-in `openwa-minio` publishes no host ports                                                            | Recreate the container and set the credentials as the Storage Migration part of section 14.3 describes                                                                                                                                                                                                                                                                                                                                                                         |
| `0.24.0` | `POST /api/sessions/:sessionId/messages/send-product` passes the `message:sending` plugin gate (type `product`, input `{ chatId, productId, body }`); a rewritten `chatId` is ignored                                                                                                                                          | Branch on `source`/`type` before reading send-DTO fields; a veto now answers `400`                                                                                                                                                                                                                                                                                                                                                                                             |
| `0.23.6` | A media URL passed to a send route or to `POST /media/convert/voice` or `.../convert/video`, and the link preview of a text send, are fetched through the egress proxy of the session named in the request instead of leaving from the gateway's own address                                                                   | Set `SESSION_PROXY_URL_FETCH=false` if a session proxy is a WhatsApp-only route that cannot reach arbitrary media hosts                                                                                                                                                                                                                                                                                                                                                        |
| `0.23.0` | Typed SDK clients: `markRead` and `subscribePresence` each take their own request type instead of the shared `MarkChatRequest`, which now serves `markUnread` alone                                                                                                                                                            | Go and Java: swap the type at both call sites. Typed Python: only at `markRead`, its `subscribePresence` body being structurally identical. JavaScript and PHP need no change; the wire body is unchanged                                                                                                                                                                                                                                                                      |
| `0.22.0` | Baileys refuses a reply whose quoted id, or a forward whose `fromChatId`, does not name the addressed chat, with the `404` whatsapp-web.js already answered; leaving a group, unsubscribing from a channel and labelling a channel surface WhatsApp's refusal; membership requests for an id that is not a group are refused   | Handle a refusal on those six calls, which previously answered `200` whatever happened                                                                                                                                                                                                                                                                                                                                                                                         |
| `0.22.0` | Typed SDK clients narrow their request bodies: 19 Python request types mark the fields the server requires, and Go and Java type the proxy scheme, call kind, membership method, chat state, pin window and status font as enums                                                                                               | Pass the named constants instead of bare strings or numbers and supply every required field; untyped callers are unaffected                                                                                                                                                                                                                                                                                                                                                    |
| `0.22.0` | `isReadOnly` on a group answers for the calling account rather than repeating the group setting, and `isMyContact` reflects whether the contact is actually saved                                                                                                                                                              | Re-read either field wherever logic branched on the old value                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `0.22.0` | Images 0.19.0 to 0.21.x ship `scripts/backup.sh` but no PostgreSQL client, so with `DATABASE_TYPE=postgres` step 1 of the upgrade script fails (`pg_dump is not installed`) before anything is stopped, and writes no archive at all                                                                                           | Dump the data store while the database still runs: `docker exec openwa-postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > backups/database.sql` for the built-in service, or `pg_dump` from the host against `DATABASE_HOST` for an external server. Then stop the app and archive the volume as the `0.19.0` row below does. To roll back, extract that archive into the emptied volume and load `database.sql` as 11 - Runbook: Restore from Backup, step 3 shows |
| `0.21.0` | The ingress route gained a per-client-IP rate bound (`INGRESS_IP_LIMIT`, default 1200 per window) alongside its per-instance one; previously the route had no bound a caller could not walk around by varying the path                                                                                                         | Raise `INGRESS_IP_LIMIT` if one provider IP legitimately drives more than 1200 ingress requests per window                                                                                                                                                                                                                                                                                                                                                                     |
| `0.20.0` | With `WEBHOOK_SSRF_PROTECT=false`, deliveries no longer follow redirects, and `SSRF_ALLOWED_HOSTS` entries pin to their resolved addresses (must resolve at registration)                                                                                                                                                      | Set `WEBHOOK_SSRF_REDIRECTS=true` for a receiver legitimately behind a 3xx; ensure allowlisted hostnames resolve when the webhook is saved                                                                                                                                                                                                                                                                                                                                     |
| `0.20.0` | Plugin installs from a URL require a `#sha256=<64 hex>` pin under `NODE_ENV=production` (the compose default)                                                                                                                                                                                                                  | Pin catalog URLs, or set `PLUGIN_INSTALL_REQUIRE_PIN=false` to lift the requirement                                                                                                                                                                                                                                                                                                                                                                                            |
| `0.19.0` | Older images ship no `scripts/backup.sh`, so step 1 of the upgrade script fails on a 0.18.x or earlier container, before anything is stopped                                                                                                                                                                                   | Stop the app and archive the volume: `docker run --rm -v openwa_openwa-data:/data:ro -v "$PWD/backups:/o" alpine tar czf /o/data.tgz -C /data .`, with a `pg_dump` of a PostgreSQL data store. To roll back, extract it into the emptied volume                                                                                                                                                                                                                                |
| `0.19.0` | Production boot refuses a set `API_MASTER_KEY` shorter than 32 characters                                                                                                                                                                                                                                                      | Strengthen a short key before upgrading; unset stays allowed (first boot generates one)                                                                                                                                                                                                                                                                                                                                                                                        |
| `0.19.0` | `POST /sessions/:id/messages/send-catalog` and `PUT /api/settings` are removed (both always answered `501`)                                                                                                                                                                                                                    | Drop calls to either; catalog reads and `GET /api/settings` are unchanged                                                                                                                                                                                                                                                                                                                                                                                                      |
| `0.18.0` | `NODE_ENV` outside `production`/`development`/`test` fails boot with a named error                                                                                                                                                                                                                                             | Set a legal value or unset it (unset remains valid)                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `0.18.0` | Go SDK: `UpdateWebhookRequest.Secret`/`.Headers` and `UpdateTemplateRequest.Header`/`.Footer` become pointers, plus a `ClearFilters` flag                                                                                                                                                                                      | Take the address of a variable to send a clearing value, or leave nil to keep the stored one                                                                                                                                                                                                                                                                                                                                                                                   |
| `0.18.0` | Two enabled instances of one plugin sharing a session scope no longer collapse onto a single config                                                                                                                                                                                                                            | Move shared keys onto each instance when provisioning a second one on the same session                                                                                                                                                                                                                                                                                                                                                                                         |
| `0.17.0` | `AUDIT_RETENTION_DAYS` is validated at boot as a plain integer                                                                                                                                                                                                                                                                 | Replace `30d`-style values with plain integers (`0`/negatives keep their documented meaning)                                                                                                                                                                                                                                                                                                                                                                                   |
| `0.17.0` | Plugins must declare a `storage:use` permission to reach `ctx.storage`                                                                                                                                                                                                                                                         | Upgrade the official plugins to the floors listed in the 0.17.0 changelog BEFORE upgrading the gateway                                                                                                                                                                                                                                                                                                                                                                         |
| `0.16.0` | `POST /sessions/:id/groups` answers `501` on the whatsapp-web.js engine (the page code it used no longer exists)                                                                                                                                                                                                               | Create groups through the Baileys engine                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `0.15.0` | Engine calls during a WhatsApp Web page reload answer a retryable `409` naming the reload (previously `500`, or `200 {success:false}` on six chat-write routes); typed 4xx no longer latch the send breaker                                                                                                                    | Retry the named-reload `409` after the session re-emits `ready`                                                                                                                                                                                                                                                                                                                                                                                                                |
| `0.14.6` | `POST /groups` returns the summary shape (`participantsCount`, not the detail type), and three SDK response shapes were retyped (`ParticipantsResult`, `ContactRecord.pushName`/fields, `sendProduct` → `{id}`)                                                                                                                | Adjust typed SDK reads; untyped JSON consumers are unaffected                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `0.14.5` | Baileys transport failures (dead socket) propagate as 5xx instead of misclassified `403`/`400`/`404`                                                                                                                                                                                                                           | Treat 5xx as retryable transport failure; keep 4xx handling for genuine refusals                                                                                                                                                                                                                                                                                                                                                                                               |
| `0.14.0` | Eager status backfill on session ready is opt-in (`STATUS_SEED_ON_READY`, default off)                                                                                                                                                                                                                                         | Set the flag only after validating the account; live status events are unaffected                                                                                                                                                                                                                                                                                                                                                                                              |
| `0.14.0` | Link previews are opt-in on the Baileys engine                                                                                                                                                                                                                                                                                 | Pass `linkPreview: true` or a `customLinkPreview` where a card is wanted                                                                                                                                                                                                                                                                                                                                                                                                       |
| `0.12.0` | `PUT /api/plugins/:id/sessions` is a full replacement of the global activation set and now requires an **unrestricted ADMIN** key; a session-scoped key is rejected with `403` whatever it sends                                                                                                                               | Switch any automation that drives global plugin activation from a scoped key to an unrestricted ADMIN key. The per-session config override route `PUT /api/plugins/:id/config/:sessionId` is unaffected and stays scoped to the addressed session                                                                                                                                                                                                                              |
| `0.8.15` | PostgreSQL schemas bootstrapped with `DATABASE_SYNCHRONIZE=true` crash-loop on boot                                                                                                                                                                                                                                            | Self-healing guard migration; see [14.9](#149-troubleshooting-migration-issues) for the large-table window                                                                                                                                                                                                                                                                                                                                                                     |
| `0.9.0`  | `GET /api/settings` no longer returns the always-zero `general.sessionTimeout`                                                                                                                                                                                                                                                 | Remove reads of that field; there is no replacement                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `0.10.3` | Boolean/numeric request fields are parsed strictly (`1`, `yes`, `""` now `400`)                                                                                                                                                                                                                                                | Send canonical JSON values; JSON clients and the SDKs are unaffected                                                                                                                                                                                                                                                                                                                                                                                                           |
| `0.10.3` | Status posts pass the `message:sending` plugin gate, with no `chatId` in the input                                                                                                                                                                                                                                             | Branch on `source`/`type` before reading `input.chatId`                                                                                                                                                                                                                                                                                                                                                                                                                        |

The authoritative list is `CHANGELOG.md`; breaking items are flagged there with ⚠️ **Breaking**.

## 14.6 Rollback Procedures

### Quick Rollback (< 24 hours)

```bash
#!/bin/bash
# rollback.sh

# A DIRECTORY of restored files — not the tar.gz that scripts/backup.sh writes (see the TIP below).
BACKUP_DIR=$1
TARGET_VERSION=$2

if [ -z "$BACKUP_DIR" ] || [ -z "$TARGET_VERSION" ]; then
    echo "Usage: ./rollback.sh <backup-dir> <target-version>"
    echo "Example: ./rollback.sh ./backups/pre-upgrade-20260215-120000 0.2.0"
    exit 1
fi

echo "🔄 Rolling back to v${TARGET_VERSION}..."

# Started with docker-compose.dev.yml (the README Quick Start)? Add `-f docker-compose.dev.yml` to
# every docker compose command below, and write `openwa` wherever one names the `openwa-api` service.

# 1. Stop current
docker compose down

# 2. Restore the databases, both from the same backup. The main DB (API keys, audit log) is always
#    SQLite, whatever the data store is. Stale journal files go first, as scripts/restore.sh does,
#    so SQLite cannot replay them into the restored file.
echo "📥 Restoring database..."
if [ -f "$BACKUP_DIR/database.sql" ]; then
    # PostgreSQL
    psql -h "$DATABASE_HOST" -U "$DATABASE_USERNAME" -d "$DATABASE_NAME" < "$BACKUP_DIR/database.sql"
else
    # SQLite
    rm -f ./data/openwa.sqlite-{wal,shm,journal}
    cp "$BACKUP_DIR/openwa.sqlite" ./data/
fi
rm -f ./data/main.sqlite-{wal,shm,journal}
cp "$BACKUP_DIR/main.sqlite" ./data/
[ -f "$BACKUP_DIR/.api-key" ] && cp "$BACKUP_DIR/.api-key" ./data/

# 3. Restore auth sessions (SESSION_DATA_PATH + BAILEYS_AUTH_DIR)
echo "📥 Restoring auth sessions..."
rm -rf ./data/sessions ./data/baileys
cp -r "$BACKUP_DIR/sessions" ./data/
[ -d "$BACKUP_DIR/baileys" ] && cp -r "$BACKUP_DIR/baileys" ./data/

# 4. Restore configuration
echo "📥 Restoring configuration..."
cp "$BACKUP_DIR/.env" .
cp "$BACKUP_DIR/docker-compose.yml" .

# 5. Start the target version. The repo compose BUILDS the image, so check out the tag and rebuild;
#    a deployment pinned to a published image bumps the tag and runs
#    `docker compose pull openwa-api && docker compose up -d --no-build` instead.
echo "▶️ Starting v${TARGET_VERSION}..."
git checkout "v${TARGET_VERSION}"
docker compose up -d --build

# 6. Verify
sleep 10
curl -f http://localhost:2785/api/health && echo "✅ Rollback successful"
```

The main DB and `.api-key` must come from the same backup as the data store. Restoring `main.sqlite`
returns every API key to its state at backup time: keys created since then are gone, and keys revoked
since then work again, so revoke those again after the rollback.

> [!TIP]
> For an archive produced by `scripts/backup.sh`, follow
> [11 - Runbook: Restore from Backup](./11-operational-runbooks.md#runbook-restore-from-backup)
> instead. It restores the databases, `.api-key`, the auth state, media and plugin state from the
> archive, but not the host `.env` or compose file, which step 4 above covers, and
> it runs `scripts/restore.sh` from the image against the production compose named volume
> (`openwa-data`) or the Helm PVC. A host run of `./scripts/restore.sh`, like the copies into `./data`
> above, reaches only a bare-metal install or `docker-compose.dev.yml`, which bind-mounts `./data`;
> under the production compose file it fills a directory the container never reads.

### Rollback Decision Tree

```mermaid
flowchart TD
    A[Issue Detected] --> B{Severity?}
    B -->|Critical| C[Immediate Rollback]
    B -->|High| D{Fix Available?}
    B -->|Medium| E{Can Wait?}

    D -->|Yes| F[Apply Hotfix]
    D -->|No| C

    E -->|Yes| G[Schedule Fix]
    E -->|No| D

    C --> H{Backup Age?}
    H -->|< 24h| I[Full Rollback]
    H -->|> 24h| J[Partial Rollback + Data Merge]

    F --> K[Monitor]
    I --> K
    J --> K
    G --> K
```

> [!WARNING]
> A rollback across a browser major upgrade (on amd64, 0.23.5 moved Chrome for Testing from 146 to 153;
> arm64 runs the chromium Debian shipped when each image was built) must restore `sessions/` from a backup
> taken before the first start on the newer image, on both the full and the partial branch: a partial
> rollback that merges data but keeps the current `sessions/` loses every whatsapp-web.js login. An older
> Chrome silently deletes the IndexedDB of a profile a newer Chrome has opened, so each previously linked
> whatsapp-web.js session starts at a QR code instead of reconnecting, the log names no cause (0.23.3 and
> 0.23.4 log only a generic `relink_required` warning), and upgrading again does not bring the pairing
> back.
> A session first paired on the newer image is not in that backup and must be paired again either way.
> Baileys sessions are unaffected.

> [!WARNING]
> A rollback to a release older than 0.23.6 loses API key chat scopes. Those images do not know
> `allowedChats`, so while one runs, a chat-scoped key reaches every chat of the sessions it is
> allowed. Restoring `main.sqlite` from a backup taken before the upgrade, as the script above and
> [11 - Runbook: Version Upgrade](./11-operational-runbooks.md#runbook-version-upgrade) do, avoids the
> rest of this. Keeping the current `main.sqlite` (changing only the image tag, or `helm rollback`,
> which keeps the volume) does not: at its first boot the older image's schema sync drops the
> `allowedChats` column. Upgrading again then stops boot with a `MainSchemaMismatchError` naming
> `api_keys.allowedChats`, because the migrations ledger that 0.24.0 and later write still records the
> column's migration. To recover, restore `main.sqlite` from the backup taken before the rollback,
> which brings the chat scopes back with it, or delete that ledger row as
> [05 - Database Design, section 5.6](./05-database-design.md#56-migration-strategy) shows, after which
> the column comes back empty, which means every chat. Before such a rollback, revoke every key that has
> `allowedChats` (`POST /api/auth/api-keys/:id/revoke`) and issue new ones after upgrading again.
> Starting the older image with `MAIN_DATABASE_SYNCHRONIZE=false` keeps the column and its values for
> the next upgrade (the compose file forwards it since 0.14.5), but the older image still does not
> enforce them.

## 14.7 Environment Migration

### Development → Staging

```yaml
# environments/staging.yml
migration:
  source: development
  target: staging

  steps:
    - name: Export the Data DB from development
      command: |
        curl -s 'http://dev-host:2785/api/infra/export-data' \
          -H "X-API-Key: $DEV_API_KEY" > /tmp/dev-data.json

    - name: Start staging on an empty data store
      command: |
        # Schema migrations run at boot, so a removed store is recreated from scratch
        docker compose down
        rm -f ./data/openwa.sqlite
        docker compose up -d

    - name: Import into staging
      command: |
        curl -X POST 'http://staging-host:2785/api/infra/import-data' \
          -H "X-API-Key: $STAGING_API_KEY" \
          -H 'Content-Type: application/json' \
          -d @/tmp/dev-data.json

    - name: Configure staging webhooks
      command: |
        curl -X POST 'http://staging-host:2785/api/sessions/{sessionId}/webhooks' \
          -H "X-API-Key: $STAGING_API_KEY" \
          -H 'Content-Type: application/json' \
          -d '{"url":"https://staging-webhook.example.com/openwa","events":["message.received"]}'

    - name: Set staging rate limits
      note: |
        Rate limits are environment variables, not an API — set RATE_LIMIT_MEDIUM_TTL and
        RATE_LIMIT_MEDIUM_LIMIT (plus the SHORT/LONG pairs) in the staging .env, then restart.
```

> [!NOTE]
> The export covers the Data DB only. API keys live in the Main DB and are never transferred — staging
> issues its own keys.

### Staging → Production

```yaml
# environments/production.yml
migration:
  source: staging
  target: production

  pre_checks:
    - name: Staging tests passed
      command: npm run test:e2e
      required: true

    - name: Security scan
      command: npm audit --omit=dev
      required: true

  steps:
    - name: Blue-green deployment
      type: blue-green
      config:
        health_check: /api/health
        switch_after: 60s
        rollback_on_error: true

    - name: Gradual traffic shift
      type: canary
      config:
        initial_percentage: 10
        increment: 10
        interval: 5m
        success_threshold: 99%
```

## 14.8 Data Export/Import

### Full Export

> [!NOTE]
> This is an illustrative standalone script, not a shipped one. `/api/infra/export-data` already covers
> every Data-DB table (see [14.3](#143-database-migration-sqlite--postgresql)); hand-rolled table lists
> like the one below silently drop whatever they omit.

```typescript
// full-export.ts — illustrative, not shipped in the repo

interface ExportOptions {
  outputDir: string;
  includeMedia: boolean;
  includeLogs: boolean;
  compress: boolean;
}

async function fullExport(options: ExportOptions): Promise<void> {
  const fs = require('fs-extra');
  const archiver = require('archiver');

  const exportDir = path.join(options.outputDir, `export-${Date.now()}`);
  await fs.ensureDir(exportDir);

  // 1. Export database tables (Data DB only — api_keys/audit_logs stay in the local Main DB)
  console.log('📊 Exporting database...');
  const tables = ['sessions', 'webhooks', 'messages', 'message_batches', 'templates'];

  for (const table of tables) {
    const data = await db.query(`SELECT * FROM ${table}`);
    await fs.writeJson(path.join(exportDir, `${table}.json`), data, { spaces: 2 });
  }

  // 2. Export auth sessions (SESSION_DATA_PATH + BAILEYS_AUTH_DIR)
  console.log('🔐 Exporting auth sessions...');
  await fs.copy('./data/sessions', path.join(exportDir, 'sessions'));
  if (await fs.pathExists('./data/baileys')) {
    await fs.copy('./data/baileys', path.join(exportDir, 'baileys'));
  }

  // 3. Export media (optional)
  if (options.includeMedia) {
    console.log('📁 Exporting media files...');
    await fs.copy('./data/media', path.join(exportDir, 'media'));
  }

  // 4. Export logs (optional)
  if (options.includeLogs) {
    console.log('📝 Exporting logs...');
    await fs.copy('./logs', path.join(exportDir, 'logs'));
  }

  // 5. Export configuration (sanitized)
  console.log('⚙️ Exporting configuration...');
  const config = {
    version: process.env.npm_package_version,
    exportedAt: new Date().toISOString(),
    settings: {
      DATABASE_TYPE: process.env.DATABASE_TYPE,
      STORAGE_TYPE: process.env.STORAGE_TYPE,
      ENGINE_TYPE: process.env.ENGINE_TYPE,
    },
  };
  await fs.writeJson(path.join(exportDir, 'config.json'), config, { spaces: 2 });

  // 6. Compress (optional)
  if (options.compress) {
    console.log('🗜️ Compressing export...');
    const output = fs.createWriteStream(`${exportDir}.tar.gz`);
    const archive = archiver('tar', { gzip: true });

    archive.pipe(output);
    archive.directory(exportDir, false);
    await archive.finalize();

    await fs.remove(exportDir);
    console.log(`✅ Export complete: ${exportDir}.tar.gz`);
  } else {
    console.log(`✅ Export complete: ${exportDir}`);
  }
}
```

### Full Import

> [!NOTE]
> Also illustrative, not a shipped script — `/api/infra/import-data` is the supported counterpart to
> the export above.

```typescript
// full-import.ts — illustrative, not shipped in the repo

interface ImportOptions {
  inputPath: string;
  mergeStrategy: 'replace' | 'merge' | 'skip-existing';
  dryRun: boolean;
}

async function fullImport(options: ImportOptions): Promise<void> {
  const fs = require('fs-extra');
  const tar = require('tar');

  let importDir = options.inputPath;

  // Extract if compressed
  if (options.inputPath.endsWith('.tar.gz')) {
    importDir = options.inputPath.replace('.tar.gz', '-extracted');
    await tar.extract({
      file: options.inputPath,
      cwd: importDir,
    });
  }

  // Validate export
  const configPath = path.join(importDir, 'config.json');
  if (!(await fs.pathExists(configPath))) {
    throw new Error('Invalid export: config.json not found');
  }

  const exportConfig = await fs.readJson(configPath);
  console.log(`📦 Importing from v${exportConfig.version}`);
  console.log(`📅 Exported at: ${exportConfig.exportedAt}`);

  if (options.dryRun) {
    console.log('🔍 DRY RUN - No changes will be made');
  }

  // Import order matters (foreign keys)
  const importOrder = ['sessions', 'webhooks', 'messages', 'message_batches', 'templates'];

  for (const table of importOrder) {
    const dataPath = path.join(importDir, `${table}.json`);
    if (!(await fs.pathExists(dataPath))) continue;

    const data = await fs.readJson(dataPath);
    console.log(`📥 Importing ${table}: ${data.length} records`);

    if (!options.dryRun) {
      await importTable(table, data, options.mergeStrategy);
    }
  }

  // Import auth sessions
  for (const [dir, target] of [
    ['sessions', './data/sessions'],
    ['baileys', './data/baileys'],
  ]) {
    const authPath = path.join(importDir, dir);
    if (await fs.pathExists(authPath)) {
      console.log(`🔐 Importing auth state: ${dir}...`);
      if (!options.dryRun) {
        await fs.copy(authPath, target, {
          overwrite: options.mergeStrategy === 'replace',
        });
      }
    }
  }

  console.log('✅ Import complete');
}
```

## 14.9 Troubleshooting Migration Issues

### Common Issues

| Issue                    | Cause                    | Solution                                                                                                                                                                                                |
| ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session not reconnecting | Auth data corrupted      | Re-scan QR code                                                                                                                                                                                         |
| Foreign key errors       | Wrong import order       | Use provided import order                                                                                                                                                                               |
| Duplicate key errors     | Existing data conflict   | Use merge strategy                                                                                                                                                                                      |
| Permission denied        | Data directory ownership | Keep the entrypoint's root start and its `cap_add` entries, and use the named volume; a host `chown` is not a fix (see [12 - Volume Permissions](./12-troubleshooting-faq.md#issue-volume-permissions)) |
| Out of memory            | Large export             | Increase Docker memory limit                                                                                                                                                                            |

### PostgreSQL: boot crash-loop after upgrading a `DATABASE_SYNCHRONIZE=true` deployment

**Symptom:** after upgrade, the container crash-loops on boot. `docker logs` shows one of:

- `column "id" is of type uuid but default expression is of type character varying`
- `foreign key constraint ... cannot be implemented ... incompatible types: character varying and uuid`

**Cause:** a deployment previously bootstrapped with `DATABASE_SYNCHRONIZE=true` on PostgreSQL has native `uuid` `id`/FK columns (TypeORM derives them from `@PrimaryGeneratedColumn('uuid')`), while the migration chain assumes `varchar`. The two are incompatible, and migrations run unconditionally on the Postgres data connection (`migrationsRun: true`), so boot cannot complete (issue #690).

**Fix (automatic for most deployments):** OpenWA ships a guard migration (`NormalizeSynchronizeUuidColumns`, ordered before the first collision) that converts the affected `uuid` columns to `varchar` on the next boot. For small-to-medium databases this is transparent — upgrade and restart.

**Large-database maintenance window:** the conversion rewrites `messages` and `message_batches` in full under an exclusive lock. If either table is large (millions of rows) and your orchestrator's liveness/readiness grace is tight, run the migration against the stopped app during a planned window:

```bash
docker compose down
DATABASE_TYPE=postgres DATABASE_HOST=... DATABASE_USERNAME=... \
  DATABASE_PASSWORD=... DATABASE_NAME=openwa npm run migration:run
docker compose up -d
```

(The CLI runner does not impose a statement timeout; the migration lifts it via `SET LOCAL`.)

`DATABASE_SYNCHRONIZE=true` on PostgreSQL is unsupported for production. Leave it unset (the default `false`) and let migrations manage the schema.

### Debug Commands

```bash
# Check database integrity
sqlite3 ./data/openwa.sqlite "PRAGMA integrity_check;"

# Verify auth session files (directories are named after the session id)
ls -la ./data/sessions/session-*/
ls -la ./data/baileys/          # Baileys engine

# Check file permissions
stat ./data/openwa.sqlite
stat ./data/sessions

# Verify PostgreSQL connection
psql -h "$DATABASE_HOST" -U "$DATABASE_USERNAME" -d "$DATABASE_NAME" -c "SELECT version();"

# Check migration status (add :main for the auth/audit connection)
npm run migration:show

# Re-apply the most recent migration (there is no per-migration re-run —
# migration:run always applies the whole pending chain)
npm run migration:revert && npm run migration:run
```

---

<div align="center">

[← 13 - Horizontal Scaling Guide](./13-horizontal-scaling.md) · [Documentation Index](./README.md) · [Next: 15 - Project Roadmap →](./15-project-roadmap.md)

</div>
