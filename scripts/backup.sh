#!/usr/bin/env bash
#
# OpenWA backup.
#
# Captures the load-bearing state needed to restore a working install:
#   - main.sqlite   — auth (API keys) + audit log, ALWAYS SQLite (see app.module.ts)
#   - data store    — openwa.sqlite (SQLite) OR a pg_dump (when DATABASE_TYPE=postgres)
#   - sessions/     — whatsapp-web.js LocalAuth session data
#   - baileys/      — Baileys engine authentication state
#   - media/        — locally-stored media (skipped automatically when using S3)
#   - plugin-packages/ — installed plugin packages from PLUGINS_DIR
#   - plugin-state/    — registry and persisted ctx.storage state under OPENWA_DATA_DIR
#   - .env.generated and .api-key — dashboard config and plaintext bootstrap admin key
#
# The previous runbook backed up the wrong file (openwa.db) and omitted main.sqlite,
# so a "successful" backup silently lost every API key and all audit history.
#
# Usage:
#   ./scripts/backup.sh
# Environment:
#   MAIN_DATABASE_NAME  auth/audit SQLite file (default: ./data/main.sqlite)
#   DATABASE_NAME       data-store SQLite file (default: ./data/openwa.sqlite; sqlite only)
#                       Both resolve EXACTLY like the app: the environment first, then ./.env, then
#                       <data dir>/.env.generated, otherwise the fixed ./data default (see
#                       lib-env.sh). They are NOT derived from OPENWA_DATA_DIR — the app never does
#                       that either.
#   OPENWA_DATA_DIR   data directory for the non-DB state below (default: ./data)
#   BACKUP_DIR        where archives are written (default: ./backups)
#   DATABASE_TYPE     sqlite (default) | postgres
#   SESSION_DATA_PATH, BAILEYS_AUTH_DIR, STORAGE_LOCAL_PATH, PLUGINS_DIR
#                     override the corresponding state directories
#   For postgres: DATABASE_URL, or DATABASE_HOST/PORT/USERNAME/PASSWORD/NAME
#
# Failure policy: a missing source database is FATAL (no silent empty backup), and the finished
# archive must contain every configured database or it is deleted and the run fails. When the
# sqlite3 CLI is unavailable the databases are plain-copied (possibly torn if the app is live) and
# the archive carries a CONSISTENCY-WARNING marker that restore.sh surfaces.
#
set -euo pipefail
# The archive now contains bootstrap credentials and generated database secrets. Never inherit a
# permissive operator umask for newly-created backup artifacts.
umask 077

# OPENWA_DATA_DIR and BACKUP_DIR steer the script itself and are never written to an env file, so
# they stay environment-only. Everything below them is application configuration and must be read
# through the same layers the app reads (see lib-env.sh).
DATA_DIR="${OPENWA_DATA_DIR:-./data}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
# shellcheck source=scripts/lib-env.sh
. "$(dirname "$0")/lib-env.sh"
DATABASE_TYPE="$(openwa_resolve DATABASE_TYPE sqlite)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

# Database paths resolve exactly like the app: an explicit environment value wins, then ./.env, then
# the dashboard's <data dir>/.env.generated, otherwise the fixed ./data default. OPENWA_DATA_DIR
# below only bases the non-DB state directories — deriving DB paths from it would back up files the
# app never reads.
MAIN_DB="$(openwa_resolve MAIN_DATABASE_NAME ./data/main.sqlite)"
DATA_DB="$(openwa_resolve DATABASE_NAME ./data/openwa.sqlite)"
SESSIONS_DIR="$(openwa_resolve SESSION_DATA_PATH "$DATA_DIR/sessions")"
BAILEYS_DIR="$(openwa_resolve BAILEYS_AUTH_DIR "$DATA_DIR/baileys")"
MEDIA_DIR="$(openwa_resolve STORAGE_LOCAL_PATH "$DATA_DIR/media")"
# Installed plugin code. The app defaults this to <dataDir>/plugins — the same tree as the
# registry and each plugin's ctx.storage below — so an unset PLUGINS_DIR must resolve there
# too, or the archive silently omits the plugin packages.
PLUGIN_PACKAGES_DIR="$(openwa_resolve PLUGINS_DIR "$DATA_DIR/plugins")"
PLUGIN_STATE_DIR="$DATA_DIR/plugins"
GENERATED_ENV="$DATA_DIR/.env.generated"
ADMIN_KEY_FILE="$DATA_DIR/.api-key"

log() { echo "[backup] $*"; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

CONSISTENCY_WARNING="$STAGE/CONSISTENCY-WARNING"

# Marker file shipped INSIDE the archive so restore.sh can surface that the database snapshot was
# plain-copied from a possibly-live app (rollback-journal mode) and may be torn.
record_consistency_warning() {
  if [ ! -f "$CONSISTENCY_WARNING" ]; then
    cat >"$CONSISTENCY_WARNING" <<'EOF'
This archive was produced WITHOUT sqlite3 .backup (the sqlite3 CLI was not found on the backup
host). The database file(s) listed below were plain-copied while the app may have been writing
(SQLite rollback-journal mode), so the snapshot may be TORN (partially committed). Re-take the
backup with sqlite3 installed — or with the app stopped — before relying on it for recovery.
EOF
  fi
  echo "plain-copied: $1" >>"$CONSISTENCY_WARNING"
}

# Online SQLite backup (consistent without stopping the app) when sqlite3 is present. A missing
# source database is FATAL: an archive without the configured databases is not a backup, and a
# silent skip is how an empty archive gets reported as "Backup complete".
backup_sqlite() {
  src="$1"
  dest="$2"
  if [ ! -f "$src" ]; then
    log "ERROR: database file not found: $src"
    log "       the app reads this exact path — check MAIN_DATABASE_NAME / DATABASE_NAME / cwd, or start the app first"
    exit 1
  fi
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$src" ".backup '$dest'"
  else
    log "WARN: sqlite3 not found — plain-copying live database $src (the snapshot may be torn)"
    cp "$src" "$dest"
    record_consistency_warning "$src"
  fi
}

# Members the finished archive MUST contain (relative tar paths). A run that cannot stage any of
# them has already failed hard above; the post-archive min-content check below is the last gate
# against shipping an archive that would "restore" into a fresh-empty install.
REQUIRED_MEMBERS=("./main.sqlite")

log "Backing up auth/audit DB ($MAIN_DB) — the API-key + audit store"
backup_sqlite "$MAIN_DB" "$STAGE/main.sqlite"

if [ "$DATABASE_TYPE" = "postgres" ]; then
  log "Backing up data store via pg_dump"
  if ! command -v pg_dump >/dev/null 2>&1; then
    log "ERROR: DATABASE_TYPE=postgres but pg_dump is not installed"
    exit 1
  fi
  if [ -n "${DATABASE_URL:-}" ]; then
    pg_dump "$DATABASE_URL" >"$STAGE/database.sql"
  else
    # Same layered resolution as the paths above: a dashboard-provisioned Postgres keeps its
    # connection details in <data dir>/.env.generated, never in the operator's shell.
    PGPASSWORD="$(openwa_resolve DATABASE_PASSWORD '')" pg_dump \
      -h "$(openwa_resolve DATABASE_HOST localhost)" \
      -p "$(openwa_resolve DATABASE_PORT 5432)" \
      -U "$(openwa_resolve DATABASE_USERNAME openwa)" \
      "$(openwa_resolve DATABASE_NAME openwa)" >"$STAGE/database.sql"
  fi
  REQUIRED_MEMBERS+=("./database.sql")
else
  log "Backing up data store ($DATA_DB)"
  backup_sqlite "$DATA_DB" "$STAGE/openwa.sqlite"
  REQUIRED_MEMBERS+=("./openwa.sqlite")
fi

if [ -d "$SESSIONS_DIR" ]; then
  log "Backing up whatsapp-web.js sessions"
  cp -pR "$SESSIONS_DIR" "$STAGE/sessions"
else
  log "WARN: $SESSIONS_DIR not found — skipping sessions"
fi

if [ -d "$BAILEYS_DIR" ]; then
  log "Backing up Baileys authentication state"
  cp -pR "$BAILEYS_DIR" "$STAGE/baileys"
elif [ "${ENGINE_TYPE:-}" = "baileys" ]; then
  log "WARN: ENGINE_TYPE=baileys but $BAILEYS_DIR was not found — restored sessions will require pairing"
fi

if [ -d "$MEDIA_DIR" ]; then
  log "Backing up local media"
  cp -pR "$MEDIA_DIR" "$STAGE/media"
fi

if [ -d "$PLUGIN_PACKAGES_DIR" ]; then
  log "Backing up installed plugin packages"
  cp -pR "$PLUGIN_PACKAGES_DIR" "$STAGE/plugin-packages"
fi

if [ -d "$PLUGIN_STATE_DIR" ]; then
  log "Backing up plugin registry and persisted state"
  cp -pR "$PLUGIN_STATE_DIR" "$STAGE/plugin-state"
fi

if [ -f "$GENERATED_ENV" ]; then
  log "Backing up dashboard-generated configuration"
  cp -p "$GENERATED_ENV" "$STAGE/.env.generated"
fi

if [ -f "$ADMIN_KEY_FILE" ]; then
  log "Backing up plaintext admin key"
  cp -p "$ADMIN_KEY_FILE" "$STAGE/.api-key"
fi

mkdir -p "$BACKUP_DIR"
ARCHIVE="$BACKUP_DIR/openwa-backup-$TIMESTAMP.tar.gz"
tar -czf "$ARCHIVE" -C "$STAGE" .

ARCHIVE_LIST="$(tar -tzf "$ARCHIVE")"

# Min-content check on the finished archive: every configured database must be present. If not,
# delete the defective archive and fail — leaving it on disk invites a restore into a fresh-empty
# install (new API keys, new master key) reported as success.
MISSING_MEMBERS=""
for member in "${REQUIRED_MEMBERS[@]}"; do
  if ! printf '%s\n' "$ARCHIVE_LIST" | grep -qxF "$member"; then
    MISSING_MEMBERS="$MISSING_MEMBERS $member"
  fi
done
if [ -n "$MISSING_MEMBERS" ]; then
  log "ERROR: archive failed the min-content check — missing required member(s):$MISSING_MEMBERS"
  rm -f "$ARCHIVE"
  exit 1
fi

log "Backup complete: $ARCHIVE"
log "SECURITY: this archive can contain database passwords, plugin secrets, and an admin API key; restrict and encrypt it"
log "Contents:"
printf '%s\n' "$ARCHIVE_LIST" | sed 's/^/[backup]   /'
