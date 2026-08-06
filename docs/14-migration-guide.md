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

# Step 2: Change database configuration in .env or Dashboard
# From: DATABASE_TYPE=sqlite
# To:   DATABASE_TYPE=postgres
#       POSTGRES_BUILTIN=true

# Step 3: Restart with new configuration
docker compose --profile postgres up -d

# Step 4: Import data to new database
curl -X POST 'http://localhost:2785/api/infra/import-data' \
  -H 'X-API-Key: YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d @data-backup.json
```

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
    "pluginInstances": [...],
    "conversationMappings": [...],
    "ingressEvents": [...],
    "webhookDeliveryFailures": [...],
    "integrationDeliveryFailures": [...],
    "statusUpdates": [...]
  },
  "counts": {
    "sessions": 5,
    "webhooks": 12,
    "messages": 1500,
    "messageBatches": 3,
    "templates": 4,
    "baileysStoredMessages": 0,
    "lidMappings": 87,
    "pluginInstances": 2,
    "conversationMappings": 31,
    "ingressEvents": 12,
    "webhookDeliveryFailures": 0,
    "integrationDeliveryFailures": 0,
    "statusUpdates": 19
  },
  "skippedTables": []
}
```

> [!NOTE]
> `skippedTables` lists optional tables absent from an older schema; the import tolerates them.

### Storage Migration (Local ↔ S3/MinIO)

OpenWA v0.2+ supports migrating media files between storage backends:

```bash
# Step 1: Check current storage file count
curl -s 'http://localhost:2785/api/infra/storage/files/count' \
  -H 'X-API-Key: YOUR_KEY'
# Response: { "storageType": "local", "count": 150, "sizeBytes": 15000000 }

# Step 2: Export all files as tar.gz
curl -s 'http://localhost:2785/api/infra/storage/export' \
  -H 'X-API-Key: YOUR_KEY'
# Response: { "message": "Storage export completed", "download": "/app/data/exports/storage-export-xxx.tar.gz" }
# The archive is auto-removed after STORAGE_EXPORT_TTL_MS (default 1h), so re-import it before then.
# It is written under data/ so it survives the restart in Step 4 and stays import-able.

# Step 3: Change storage configuration
# From: STORAGE_TYPE=local
# To:   STORAGE_TYPE=s3
#       MINIO_BUILTIN=true  # or false for external S3

# Step 4: Restart with new configuration
docker compose up -d

# Step 5: Import files to new storage
curl -X POST 'http://localhost:2785/api/infra/storage/import' \
  -H 'X-API-Key: YOUR_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"filePath": "/app/data/exports/storage-export-xxx.tar.gz"}'
```

| Scenario                     | Support | Method                   |
| ---------------------------- | ------- | ------------------------ |
| Local → Built-in MinIO       | ✅      | Export → Config → Import |
| Local → External S3          | ✅      | Export → Config → Import |
| Built-in MinIO → External S3 | ✅      | Export → Config → Import |
| S3 → Local                   | ✅      | Export → Config → Import |

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
# Step 1: Check queue status via Bull Board
# Visit: http://localhost:2785/api/admin/queues

# Step 2: Wait until MESSAGE and WEBHOOK queues are empty
# Or check via API:
curl -s 'http://localhost:2785/api/infra/status' \
  -H 'X-API-Key: YOUR_KEY' | jq '.queue'
# Wait for: pending: 0

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
> **Job Loss Prevention**: Always ensure the MESSAGE and WEBHOOK queues are empty before switching Redis instances. Check the `/api/admin/queues` dashboard.

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
> the export/import API above, which always covers the full table set.
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
    'plugin_instances',
    'conversation_mappings',
    'ingress_events',
    'webhook_delivery_failures',
    'integration_delivery_failures',
    'status_updates',
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

```bash
# Step 1: Stop OpenWA
docker compose down

# Step 2: Backup current data (both databases + session auth + media)
./scripts/backup.sh

# Step 3: Setup PostgreSQL (if not exists) — the built-in service lives behind a compose profile
docker compose --profile postgres up -d postgres

# Step 4: Run the migration — save the "Migration Script (Legacy)" example above as
#         migrate-sqlite-to-postgres.ts first; it is not shipped in the repo
npx ts-node migrate-sqlite-to-postgres.ts

# Step 5: Update environment
export DATABASE_TYPE=postgres
export DATABASE_HOST=localhost
export DATABASE_PORT=5432
export DATABASE_NAME=openwa
export DATABASE_USERNAME=user
export DATABASE_PASSWORD=pass

# Step 6: Verify migration
psql -h "$DATABASE_HOST" -U "$DATABASE_USERNAME" -d "$DATABASE_NAME" -c "SELECT COUNT(*) FROM sessions;"
psql -h "$DATABASE_HOST" -U "$DATABASE_USERNAME" -d "$DATABASE_NAME" -c "SELECT COUNT(*) FROM messages;"

# Step 7: Start with PostgreSQL
docker compose --profile postgres up -d

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
├── session-{sessionName}/
│   ├── Default/
│   │   ├── IndexedDB/
│   │   ├── Local Storage/
│   │   └── Session Storage/
│   └── ... (Chrome profile data)

Baileys — BAILEYS_AUTH_DIR, default ./data/baileys
./data/baileys/
└── {sessionName}/          # multi-file auth state
```

> [!IMPORTANT]
> **Directories are keyed by session NAME, not by the REST id.** The API addresses a session by its
> UUID (`/api/sessions/{id}`), but the engine receives `session.name` as its client id, so the on-disk
> profile is `session-<name>` (whatsapp-web.js) or `<name>` (Baileys). Resolve the name via
> `GET /api/sessions/{id}` before copying anything.

### Transfer Methods

#### Method 1: Direct File Copy (Server to Server)

Moves the auth profile only. The session's database record is created separately — either by
`POST /api/sessions` on the target with the same `name`, or with the infra export/import of
Method 2. Copying rows between SQLite files by hand is not supported: the `sessions` table carries
columns the copy would have to reproduce exactly, and a mismatch corrupts the row.

Under the shipped compose the data directory lives in a named Docker volume
(`openwa-data:/app/data`), not a host bind mount, so the profile is copied through the container
with `docker compose cp` rather than straight off the host filesystem. `APP_DIR` is the directory
holding `docker-compose.yml` on each server; `SESSION_NAME` is the session `name` (resolve it via
`GET /api/sessions/{id}` — the on-disk directory is keyed by name, not by the REST id).

```bash
APP_DIR=/srv/openwa            # docker compose project directory on both hosts
SESSION_NAME=my-session

# 1. Stop the app on both hosts. Use `stop`, not `down`: a running engine holds the profile open,
#    but `down` removes the container that step 2 copies through.
ssh old-server "cd $APP_DIR && docker compose stop openwa-api"
ssh new-server "cd $APP_DIR && docker compose stop openwa-api"

# 2. Copy the auth profile out of the source container, to the target host, and back in.
#    whatsapp-web.js: /app/data/sessions/session-<name>.
#    Baileys:         /app/data/baileys/<name> (no "session-" prefix).
ssh old-server "cd $APP_DIR && docker compose cp \
    openwa-api:/app/data/sessions/session-$SESSION_NAME ./session-$SESSION_NAME"
rsync -avz --progress "old-server:$APP_DIR/session-$SESSION_NAME/" \
    "new-server:$APP_DIR/session-$SESSION_NAME/"
ssh new-server "cd $APP_DIR && docker compose cp \
    ./session-$SESSION_NAME openwa-api:/app/data/sessions/session-$SESSION_NAME"

# 3. Start the target back up.
ssh new-server "cd $APP_DIR && docker compose start openwa-api"
```

Delete the staging copies (`$APP_DIR/session-$SESSION_NAME` on both hosts) afterwards — they hold
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

# 2. Move the engine auth state with both instances stopped (Method 1), keyed by session NAME.
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
breaking change bumps the **minor** (`0.10.x` → `0.11.0`) and everything else is a patch, so a minor bump
is the one that warrants reading the release notes closely.

| From                  | To                  | Migration Type                                 | Downtime  |
| --------------------- | ------------------- | ---------------------------------------------- | --------- |
| `0.x.y`               | `0.x.z` (patch)     | Pending migrations only                        | < 5 min   |
| `0.x.y`               | `0.(x+1).0` (minor) | Pending migrations + review the breaking notes | 5-15 min  |
| Several releases back | Current             | Same — the migration chain replays in order    | 10-15 min |

Upgrades are cumulative: migrations apply in order from wherever the schema currently sits, so jumping
straight to the current release is supported. There is no required intermediate stop — but read every
intervening `CHANGELOG.md` entry, because behavior changes are not replayed by migrations.

Schema migrations run automatically at boot on the **data** connection only — always on PostgreSQL,
and on SQLite unless `DATABASE_SYNCHRONIZE=true` puts the data store in synchronize mode. The Main
(auth/audit) connection defaults to synchronize instead, and under that default runs no migrations at
boot. Setting `MAIN_DATABASE_SYNCHRONIZE=false` switches it to its own migration chain, which then
also runs at boot (`migrationsRun` is the inverse of `synchronize` on both connections); run that
chain by hand with `npm run migration:run:main`.

### Upgrade Steps

```bash
#!/bin/bash
# upgrade.sh — same shape for a patch or a minor
set -e

# 1. Backup: both databases + session auth + media + plugin state
./scripts/backup.sh

# 2. Stop the current version
docker compose down

# 3. Move to the new version
#    The repo's compose file BUILDS the API image from source:
git pull && docker compose up -d --build
#    Deployments pinned to a published image instead (ghcr.io/rmyndharis/openwa:<version>)
#    bump the tag in their compose file, then: docker compose pull && docker compose up -d

# 4. Wait for health — every route lives under the /api prefix
for i in {1..30}; do
  if curl -sf http://localhost:2785/api/health > /dev/null; then
    echo "✅ Health check passed"
    break
  fi
  sleep 2
done

# 5. Confirm the running version
curl -s http://localhost:2785/api/health | jq '.version'

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

| Release  | Change                                                                                                                                                                                           | Action                                                                                                                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0.12.0` | `PUT /api/plugins/:id/sessions` is a full replacement of the global activation set and now requires an **unrestricted ADMIN** key; a session-scoped key is rejected with `403` whatever it sends | Switch any automation that drives global plugin activation from a scoped key to an unrestricted ADMIN key. The per-session config override route `PUT /api/plugins/:id/config/:sessionId` is unaffected and stays scoped to the addressed session |
| `0.8.15` | PostgreSQL schemas bootstrapped with `DATABASE_SYNCHRONIZE=true` crash-loop on boot                                                                                                              | Self-healing guard migration; see [14.9](#149-troubleshooting-migration-issues) for the large-table window                                                                                                                                        |
| `0.9.0`  | `GET /api/settings` no longer returns the always-zero `general.sessionTimeout`                                                                                                                   | Remove reads of that field — there is no replacement                                                                                                                                                                                              |
| `0.10.3` | Boolean/numeric request fields are parsed strictly (`1`, `yes`, `""` now `400`)                                                                                                                  | Send canonical JSON values; JSON clients and the SDKs are unaffected                                                                                                                                                                              |
| `0.10.3` | Status posts pass the `message:sending` plugin gate, with no `chatId` in the input                                                                                                               | Branch on `source`/`type` before reading `input.chatId`                                                                                                                                                                                           |

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

# 1. Stop current
docker compose down

# 2. Restore database
echo "📥 Restoring database..."
if [ -f "$BACKUP_DIR/database.sql" ]; then
    # PostgreSQL
    psql -h "$DATABASE_HOST" -U "$DATABASE_USERNAME" -d "$DATABASE_NAME" < "$BACKUP_DIR/database.sql"
else
    # SQLite
    cp "$BACKUP_DIR/openwa.sqlite" ./data/
fi

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
#    a deployment pinned to a published image bumps the tag and runs `docker compose pull` instead.
echo "▶️ Starting v${TARGET_VERSION}..."
git checkout "v${TARGET_VERSION}"
docker compose up -d --build

# 6. Verify
sleep 10
curl -f http://localhost:2785/api/health && echo "✅ Rollback successful"
```

> [!TIP]
> `./scripts/restore.sh <backup-archive.tar.gz>` performs the same restore from an archive produced by
> `scripts/backup.sh` — including the Main DB (`./data/main.sqlite`), which the script above does not touch.

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

| Issue                    | Cause                  | Solution                     |
| ------------------------ | ---------------------- | ---------------------------- |
| Session not reconnecting | Auth data corrupted    | Re-scan QR code              |
| Foreign key errors       | Wrong import order     | Use provided import order    |
| Duplicate key errors     | Existing data conflict | Use merge strategy           |
| Permission denied        | File ownership         | `chown -R 1000:1000 ./data`  |
| Out of memory            | Large export           | Increase Docker memory limit |

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

# Verify auth session files (directories are named after the session NAME)
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
