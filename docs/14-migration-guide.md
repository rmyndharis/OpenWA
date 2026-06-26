# 14 - Migration Guide

## 14.1 Overview

This document provides a comprehensive guide for migrating OpenWA, including:

- Database migration (SQLite → PostgreSQL)
- Version upgrades (v0.1 → v0.2 → v1.0)
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

- [ ] Database backup completed
- [ ] Session auth files backed up (.wwebjs_auth/)
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
    "messageBatches": [...]
  },
  "counts": {
    "sessions": 5,
    "webhooks": 12,
    "messages": 1500,
    "messageBatches": 3
  }
}
```

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

Redis in OpenWA is used **only for caching** with TTL-based expiration. Cache data is ephemeral and automatically regenerates from the database.

**No migration API needed** - just change configuration:

```bash
# Switch from built-in to external Redis
REDIS_ENABLED=true
REDIS_BUILTIN=false      # false = external Redis
REDIS_HOST=your-redis-host.com
REDIS_PORT=6379
REDIS_PASSWORD=optional
```

| Scenario                  | Support | Notes                        |
| ------------------------- | ------- | ---------------------------- |
| Built-in → External Redis | ✅      | Config change only           |
| External → Built-in Redis | ✅      | Config change only           |
| Enable → Disable Redis    | ✅      | App uses memory fallback     |
| Disable → Enable Redis    | ✅      | Cache rebuilds automatically |

> [!TIP]
> **Cache Warm-up**: After switching Redis instances, the cache will automatically rebuild as requests come in. No data migration is necessary.

### BullMQ Migration (Queue System)

BullMQ stores job data in Redis. When switching Redis instances, pending jobs may be lost.

**Best Practice - Drain Queue Before Switching:**

```bash
# Step 1: Check queue status via Bull Board
# Visit: http://localhost:2785/admin/queues

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
> **Job Loss Prevention**: Always ensure the MESSAGE and WEBHOOK queues are empty before switching Redis instances. Check `/admin/queues` dashboard.

### Infrastructure Migration Summary

| Component    | Migration Method     | API Endpoint                                             |
| ------------ | -------------------- | -------------------------------------------------------- |
| **Database** | Export/Import JSON   | `/api/infra/export-data`, `/api/infra/import-data`       |
| **Storage**  | Export/Import tar.gz | `/api/infra/storage/export`, `/api/infra/storage/import` |
| **Redis**    | Config change only   | N/A (cache auto-rebuilds)                                |
| **BullMQ**   | Drain then config    | N/A (wait for empty queues)                              |

### Migration Script (Legacy)

```typescript
// scripts/migrate-sqlite-to-postgres.ts

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

  // 3. Migration order (respect foreign keys)
  const migrationOrder = [
    'sessions',
    'api_keys',
    'webhooks',
    'contacts',
    'messages',
    'media_files',
    'webhook_logs',
    'audit_logs',
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
            const columns = Object.keys(row);
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
  sqlitePath: process.env.SQLITE_PATH || './data/openwa.db',
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

# Step 2: Backup current data
cp -r ./data ./data-backup-$(date +%Y%m%d)
docker exec openwa-db pg_dump -U postgres openwa > backup.sql

# Step 3: Setup PostgreSQL (if not exists)
docker compose -f docker-compose.postgres.yml up -d postgres

# Step 4: Run migration script
npx ts-node scripts/migrate-sqlite-to-postgres.ts

# Step 5: Update environment
export DATABASE_ADAPTER=postgresql
export DATABASE_URL=postgresql://user:pass@localhost:5432/openwa

# Step 6: Verify migration
psql $DATABASE_URL -c "SELECT COUNT(*) FROM sessions;"
psql $DATABASE_URL -c "SELECT COUNT(*) FROM messages;"

# Step 7: Start with PostgreSQL
docker compose -f docker-compose.postgres.yml up -d

# Step 8: Verify functionality
curl http://localhost:2785/health
```

### Verification Queries

```sql
-- Compare row counts
-- Run on both SQLite and PostgreSQL

-- Sessions
SELECT 'sessions' as table_name, COUNT(*) as count FROM sessions
UNION ALL
SELECT 'messages', COUNT(*) FROM messages
UNION ALL
SELECT 'contacts', COUNT(*) FROM contacts
UNION ALL
SELECT 'webhooks', COUNT(*) FROM webhooks
UNION ALL
SELECT 'api_keys', COUNT(*) FROM api_keys;

-- Verify foreign key integrity
SELECT m.id, m.session_id
FROM messages m
LEFT JOIN sessions s ON m.session_id = s.id
WHERE s.id IS NULL;

-- Check for data integrity
SELECT session_id, COUNT(*) as msg_count
FROM messages
GROUP BY session_id
ORDER BY msg_count DESC
LIMIT 10;
```

## 14.4 Session Auth State Transfer

### Understanding Session Auth

```
Session Auth Structure:
.wwebjs_auth/
├── session-{sessionId}/
│   ├── Default/
│   │   ├── IndexedDB/
│   │   ├── Local Storage/
│   │   └── Session Storage/
│   └── ... (Chrome profile data)
```

### Transfer Methods

#### Method 1: Direct File Copy (Same Host)

```bash
#!/bin/bash
# transfer-session.sh

SOURCE_DIR="/old-server/data/.wwebjs_auth"
TARGET_DIR="/new-server/data/.wwebjs_auth"
SESSION_ID=$1

if [ -z "$SESSION_ID" ]; then
    echo "Usage: ./transfer-session.sh <session-id>"
    exit 1
fi

# Stop both instances
echo "⏹️ Stopping services..."
ssh old-server "docker compose down"
ssh new-server "docker compose down"

# Copy session data
echo "📦 Copying session data..."
rsync -avz --progress \
    "old-server:${SOURCE_DIR}/session-${SESSION_ID}/" \
    "${TARGET_DIR}/session-${SESSION_ID}/"

# Copy database record
echo "📄 Exporting session record..."
ssh old-server "sqlite3 /data/openwa.db \
    \"SELECT * FROM sessions WHERE id='${SESSION_ID}'\" \
    -csv" > session_record.csv

# Import to new database
echo "📥 Importing session record..."
ssh new-server "sqlite3 /data/openwa.db \
    \".import session_record.csv sessions\""

# Start new server
echo "▶️ Starting new server..."
ssh new-server "docker compose up -d"

echo "✅ Session ${SESSION_ID} transferred successfully"
```

#### Method 2: Export/Import via API

```typescript
// Export session from old server
// GET /api/sessions/{id}/export

interface SessionExport {
  session: {
    id: string;
    name: string;
    phoneNumber: string;
    status: string;
    config: object;
  };
  authData: string; // Base64 encoded tar.gz of auth folder
  webhooks: WebhookConfig[];
  contacts: Contact[];
}

// api/sessions/export.controller.ts
@Get(':id/export')
@UseGuards(ApiKeyGuard)
async exportSession(@Param('id') id: string): Promise<SessionExport> {
  const session = await this.sessionService.findOne(id);

  // Create tar.gz of auth folder
  const authPath = path.join(this.authDir, `session-${id}`);
  const tarBuffer = await this.createTarGz(authPath);

  return {
    session: {
      id: session.id,
      name: session.name,
      phoneNumber: session.phoneNumber,
      status: 'exported',
      config: session.config,
    },
    authData: tarBuffer.toString('base64'),
    webhooks: await this.webhookService.findBySession(id),
    contacts: await this.contactService.findBySession(id),
  };
}

// Import session to new server
// POST /api/sessions/import

@Post('import')
@UseGuards(ApiKeyGuard)
async importSession(@Body() data: SessionExport): Promise<Session> {
  // 1. Create session record
  const session = await this.sessionService.create({
    id: data.session.id,
    name: data.session.name,
    config: data.session.config,
  });

  // 2. Extract auth data
  const authBuffer = Buffer.from(data.authData, 'base64');
  const authPath = path.join(this.authDir, `session-${session.id}`);
  await this.extractTarGz(authBuffer, authPath);

  // 3. Import webhooks
  for (const webhook of data.webhooks) {
    await this.webhookService.create({
      ...webhook,
      sessionId: session.id,
    });
  }

  // 4. Import contacts
  for (const contact of data.contacts) {
    await this.contactService.create({
      ...contact,
      sessionId: session.id,
    });
  }

  // 5. Initialize session (will use existing auth)
  await this.whatsappService.initSession(session.id);

  return session;
}
```

### Bulk Session Transfer

```typescript
// scripts/bulk-transfer-sessions.ts

interface TransferConfig {
  sourceUrl: string;
  sourceApiKey: string;
  targetUrl: string;
  targetApiKey: string;
  sessionIds: string[] | 'all';
}

async function bulkTransferSessions(config: TransferConfig): Promise<void> {
  const axios = require('axios');

  // Get session list
  let sessionIds = config.sessionIds;
  if (sessionIds === 'all') {
    const response = await axios.get(`${config.sourceUrl}/api/sessions`, {
      headers: { 'X-API-Key': config.sourceApiKey },
    });
    sessionIds = response.data.map((s: any) => s.id);
  }

  console.log(`📋 Transferring ${sessionIds.length} sessions...`);

  for (const sessionId of sessionIds) {
    try {
      console.log(`\n🔄 Processing session: ${sessionId}`);

      // 1. Stop session on source
      await axios.post(
        `${config.sourceUrl}/api/sessions/${sessionId}/stop`,
        {},
        { headers: { 'X-API-Key': config.sourceApiKey } },
      );

      // 2. Export from source
      const exportResponse = await axios.get(`${config.sourceUrl}/api/sessions/${sessionId}/export`, {
        headers: { 'X-API-Key': config.sourceApiKey },
      });

      // 3. Import to target
      await axios.post(`${config.targetUrl}/api/sessions/import`, exportResponse.data, {
        headers: { 'X-API-Key': config.targetApiKey },
      });

      console.log(`✅ Session ${sessionId} transferred`);
    } catch (error: any) {
      console.error(`❌ Failed to transfer ${sessionId}: ${error.message}`);
    }
  }
}
```

## 14.5 Version Upgrade Guide

### Upgrade Matrix

```mermaid
flowchart LR
    V01[v0.1.x] -->|Direct| V02[v0.2.x]
    V02 -->|Direct| V10[v1.0.x]
    V01 -->|"Via v0.2"| V10
    V10 -->|Direct| V11[v1.1.x]
    V11 -->|Direct| V12[v1.2.x]
```

| From   | To     | Migration Type            | Downtime  |
| ------ | ------ | ------------------------- | --------- |
| v0.1.x | v0.2.x | Schema migration          | 5-10 min  |
| v0.2.x | v1.0.x | Schema + Config migration | 10-15 min |
| v0.1.x | v1.0.x | Must go via v0.2.x        | 15-25 min |
| v1.x   | v1.y   | Usually automatic         | < 5 min   |

### v0.1 → v0.2 Migration

#### Breaking Changes in v0.2

```yaml
breaking_changes:
  api:
    - path: /api/session → /api/sessions (plural)
    - path: /api/send → /api/sessions/{id}/messages
    - auth: Basic Auth → API Key

  config:
    - DATABASE_PATH → DATABASE_URL (for PostgreSQL)
    - WEBHOOK_URL → Managed via API

  database:
    - New tables: api_keys, webhook_logs
    - Modified: sessions (added config JSON column)
    - Modified: messages (added metadata column)
```

#### Migration Steps

```bash
#!/bin/bash
# upgrade-v01-to-v02.sh

set -e

echo "🚀 Upgrading OpenWA v0.1.x → v0.2.x"

# 1. Backup
echo "📦 Creating backup..."
BACKUP_DIR="./backups/v01-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
cp -r ./data "$BACKUP_DIR/"
cp .env "$BACKUP_DIR/"

# 2. Stop current version
echo "⏹️ Stopping v0.1..."
docker compose down

# 3. Run database migrations
echo "🔄 Running migrations..."
docker run --rm \
  -v $(pwd)/data:/app/data \
  -e DATABASE_URL=sqlite:///app/data/openwa.db \
  ghcr.io/rmyndharis/openwa:0.2.0 \
  npm run migration:run:prod   # the prod image strips ts-node/TS source — use :prod

# 4. Migrate configuration
echo "⚙️ Migrating configuration..."
cat > .env.new << 'EOF'
# OpenWA v0.2.x Configuration

# Database (unchanged if using SQLite)
DATABASE_ADAPTER=sqlite
DATABASE_URL=sqlite:./data/openwa.db

# New in v0.2: API Key Authentication
API_KEY_ENABLED=true
# Generate with: openssl rand -hex 32
API_KEY=your-generated-api-key

# Webhook (now managed via API, but can set default)
DEFAULT_WEBHOOK_URL=${WEBHOOK_URL:-}

# Other settings migrated from v0.1
NODE_ENV=${NODE_ENV:-production}
PORT=${PORT:-3000}
LOG_LEVEL=${LOG_LEVEL:-info}
EOF

# Merge with existing .env
source .env
envsubst < .env.new > .env.migrated
mv .env.migrated .env
rm .env.new

# 5. Start new version
echo "▶️ Starting v0.2..."
docker compose pull
docker compose up -d

# 6. Wait for health
echo "⏳ Waiting for health check..."
sleep 10
curl -f http://localhost:2785/health || exit 1

# 7. Create API key for existing integrations
echo "🔑 Creating API key..."
docker exec openwa npm run cli -- create-api-key --name "migrated-key"

echo "✅ Upgrade complete!"
echo ""
echo "⚠️ IMPORTANT: Update your API clients:"
echo "  - Change /api/session to /api/sessions"
echo "  - Change /api/send to /api/sessions/{id}/messages"
echo "  - Add X-API-Key header to all requests"
```

### v0.2 → v1.0 Migration

#### Breaking Changes in v1.0

```yaml
breaking_changes:
  api:
    - Groups API restructured
    - Webhook payload format v2
    - Rate limiting enforced

  config:
    - ENGINE_TYPE required (default: whatsapp-web.js; also accepts: baileys)
    - STORAGE_ADAPTER required (default: local)

  database:
    - New tables: groups, group_participants, channels
    - sessions.status enum expanded
```

#### Migration Steps

```bash
#!/bin/bash
# upgrade-v02-to-v10.sh

set -e

echo "🚀 Upgrading OpenWA v0.2.x → v1.0.0"

# Pre-flight checks
CURRENT_VERSION=$(docker inspect ghcr.io/rmyndharis/openwa --format '{{.Config.Labels.version}}' 2>/dev/null || echo "unknown")
echo "Current version: $CURRENT_VERSION"

# 1. Comprehensive backup
echo "📦 Creating comprehensive backup..."
BACKUP_DIR="./backups/v02-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

# Backup database
if [ "$DATABASE_ADAPTER" = "postgresql" ]; then
  pg_dump $DATABASE_URL > "$BACKUP_DIR/database.sql"
else
  cp ./data/openwa.db "$BACKUP_DIR/"
fi

# Backup auth sessions
cp -r ./data/.wwebjs_auth "$BACKUP_DIR/"

# Backup config
cp .env "$BACKUP_DIR/"
cp docker-compose.yml "$BACKUP_DIR/"

# 2. Export webhook configurations (per session, new format in v1.0)
echo "📤 Exporting webhooks..."
for sessionId in $(curl -s -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions | jq -r '.data[].id'); do
  curl -s -H "X-API-Key: $API_KEY" \
    "http://localhost:2785/api/sessions/${sessionId}/webhooks" \
    > "$BACKUP_DIR/webhooks_${sessionId}.json"
done

# 3. Stop services
echo "⏹️ Stopping v0.2..."
docker compose down

# 4. Update configuration
echo "⚙️ Updating configuration..."
cat >> .env << 'EOF'

# New in v1.0
ENGINE_TYPE=whatsapp-web.js  # default (Chromium-based); set to "baileys" for browser-free engine
STORAGE_ADAPTER=local
CACHE_ADAPTER=memory

# Webhook v2 format (recommended)
WEBHOOK_VERSION=2
EOF

# 5. Run database migrations
echo "🔄 Running migrations..."
docker run --rm \
  -v $(pwd)/data:/app/data \
  --env-file .env \
  ghcr.io/rmyndharis/openwa:1.0.0 \
  npm run migration:run

# 6. Migrate webhooks to new format
echo "🔄 Migrating webhooks..."
docker run --rm \
  -v $(pwd)/data:/app/data \
  -v "$BACKUP_DIR/webhooks.json:/tmp/webhooks.json" \
  --env-file .env \
  ghcr.io/rmyndharis/openwa:1.0.0 \
  npm run cli -- migrate-webhooks /tmp/webhooks.json

# 7. Start new version
echo "▶️ Starting v1.0..."
sed -i 's/:0.2./:1.0./g' docker-compose.yml
docker compose pull
docker compose up -d

# 8. Health check
echo "⏳ Waiting for health check..."
for i in {1..30}; do
  if curl -sf http://localhost:2785/health > /dev/null; then
    echo "✅ Health check passed"
    break
  fi
  sleep 2
done

# 9. Verify sessions
echo "🔍 Verifying sessions..."
curl -s -H "X-API-Key: $API_KEY" \
  http://localhost:2785/api/sessions | jq '.[] | {id, status}'

echo ""
echo "✅ Upgrade to v1.0.0 complete!"
echo ""
echo "📝 Post-upgrade tasks:"
echo "  1. Update webhook consumers for v2 payload format"
echo "  2. Test all active sessions"
echo "  3. Review new rate limits"
echo "  4. Check Groups API if used"
```

## 14.6 Rollback Procedures

### Quick Rollback (< 24 hours)

```bash
#!/bin/bash
# rollback.sh

BACKUP_DIR=$1
TARGET_VERSION=$2

if [ -z "$BACKUP_DIR" ] || [ -z "$TARGET_VERSION" ]; then
    echo "Usage: ./rollback.sh <backup-dir> <target-version>"
    echo "Example: ./rollback.sh ./backups/v02-20260215-120000 0.2.0"
    exit 1
fi

echo "🔄 Rolling back to v${TARGET_VERSION}..."

# 1. Stop current
docker compose down

# 2. Restore database
echo "📥 Restoring database..."
if [ -f "$BACKUP_DIR/database.sql" ]; then
    # PostgreSQL
    psql $DATABASE_URL < "$BACKUP_DIR/database.sql"
else
    # SQLite
    cp "$BACKUP_DIR/openwa.db" ./data/
fi

# 3. Restore auth sessions
echo "📥 Restoring auth sessions..."
rm -rf ./data/.wwebjs_auth
cp -r "$BACKUP_DIR/.wwebjs_auth" ./data/

# 4. Restore configuration
echo "📥 Restoring configuration..."
cp "$BACKUP_DIR/.env" .
cp "$BACKUP_DIR/docker-compose.yml" .

# 5. Start old version
echo "▶️ Starting v${TARGET_VERSION}..."
docker compose pull
docker compose up -d

# 6. Verify
sleep 10
curl -f http://localhost:2785/health && echo "✅ Rollback successful"
```

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
    - name: Export sessions (anonymized)
      command: |
        npm run cli -- export-sessions \
          --anonymize \
          --output /tmp/sessions-staging.json

    - name: Reset database
      command: |
        npm run migration:fresh

    - name: Import test sessions
      command: |
        npm run cli -- import-sessions /tmp/sessions-staging.json

    - name: Configure staging webhooks
      command: |
        npm run cli -- set-webhook \
          --url https://staging-webhook.example.com/openwa \
          --events message,status

    - name: Set staging limits
      command: |
        npm run cli -- set-limits \
          --max-sessions 10 \
          --rate-limit 100/min
```

### Staging → Production

```yaml
# environments/production.yml
migration:
  source: staging
  target: production

  pre_checks:
    - name: Staging tests passed
      command: npm run test:e2e -- --tag staging
      required: true

    - name: Performance benchmarks
      command: npm run benchmark
      threshold: 'p99 < 500ms'

    - name: Security scan
      command: npm audit --production
      required: true

  steps:
    - name: Blue-green deployment
      type: blue-green
      config:
        health_check: /health
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

```typescript
// scripts/full-export.ts

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

  // 1. Export database tables
  console.log('📊 Exporting database...');
  const tables = ['sessions', 'messages', 'contacts', 'webhooks', 'api_keys'];

  for (const table of tables) {
    const data = await db.query(`SELECT * FROM ${table}`);
    await fs.writeJson(path.join(exportDir, `${table}.json`), data, { spaces: 2 });
  }

  // 2. Export auth sessions
  console.log('🔐 Exporting auth sessions...');
  await fs.copy('./data/.wwebjs_auth', path.join(exportDir, 'auth'));

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
      DATABASE_ADAPTER: process.env.DATABASE_ADAPTER,
      STORAGE_ADAPTER: process.env.STORAGE_ADAPTER,
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

```typescript
// scripts/full-import.ts

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
  const importOrder = ['sessions', 'api_keys', 'webhooks', 'contacts', 'messages'];

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
  const authPath = path.join(importDir, 'auth');
  if (await fs.pathExists(authPath)) {
    console.log('🔐 Importing auth sessions...');
    if (!options.dryRun) {
      await fs.copy(authPath, './data/.wwebjs_auth', {
        overwrite: options.mergeStrategy === 'replace',
      });
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

### Debug Commands

```bash
# Check database integrity
sqlite3 ./data/openwa.db "PRAGMA integrity_check;"

# Verify auth session files
ls -la ./data/.wwebjs_auth/session-*/

# Check file permissions
stat ./data/openwa.db
stat ./data/.wwebjs_auth

# Verify PostgreSQL connection
psql $DATABASE_URL -c "SELECT version();"

# Check migration status
npm run migration:status

# Force re-run specific migration
npm run migration:run -- --name CreateApiKeysTable
```

---

<div align="center">

[← 13 - Horizontal Scaling Guide](./13-horizontal-scaling.md) · [Documentation Index](./README.md) · [Next: 15 - Project Roadmap →](./15-project-roadmap.md)

</div>
