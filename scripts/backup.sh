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
#   OPENWA_DATA_DIR   data directory (default: ./data)
#   BACKUP_DIR        where archives are written (default: ./backups)
#   DATABASE_TYPE     sqlite (default) | postgres
#   SESSION_DATA_PATH, BAILEYS_AUTH_DIR, STORAGE_LOCAL_PATH, PLUGINS_DIR
#                     override the corresponding state directories
#   For postgres: DATABASE_URL, or DATABASE_HOST/PORT/USERNAME/PASSWORD/NAME
#
set -euo pipefail
# The archive now contains bootstrap credentials and generated database secrets. Never inherit a
# permissive operator umask for newly-created backup artifacts.
umask 077

DATA_DIR="${OPENWA_DATA_DIR:-./data}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
DATABASE_TYPE="${DATABASE_TYPE:-sqlite}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

MAIN_DB="$DATA_DIR/main.sqlite"
DATA_DB="$DATA_DIR/openwa.sqlite"
SESSIONS_DIR="${SESSION_DATA_PATH:-$DATA_DIR/sessions}"
BAILEYS_DIR="${BAILEYS_AUTH_DIR:-$DATA_DIR/baileys}"
MEDIA_DIR="${STORAGE_LOCAL_PATH:-$DATA_DIR/media}"
PLUGIN_PACKAGES_DIR="${PLUGINS_DIR:-./plugins}"
PLUGIN_STATE_DIR="$DATA_DIR/plugins"
GENERATED_ENV="$DATA_DIR/.env.generated"
ADMIN_KEY_FILE="$DATA_DIR/.api-key"

log() { echo "[backup] $*"; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Online SQLite backup (consistent without stopping the app) when sqlite3 is present,
# else a plain copy with a warning.
backup_sqlite() {
  src="$1"
  dest="$2"
  if [ ! -f "$src" ]; then
    log "WARN: $src not found — skipping"
    return 0
  fi
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$src" ".backup '$dest'"
  else
    log "WARN: sqlite3 not found — plain-copying $src (stop the app first for a consistent copy)"
    cp "$src" "$dest"
  fi
}

log "Backing up auth/audit DB (main.sqlite) — the API-key + audit store"
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
    PGPASSWORD="${DATABASE_PASSWORD:-}" pg_dump \
      -h "${DATABASE_HOST:-localhost}" \
      -p "${DATABASE_PORT:-5432}" \
      -U "${DATABASE_USERNAME:-openwa}" \
      "${DATABASE_NAME:-openwa}" >"$STAGE/database.sql"
  fi
else
  log "Backing up data store (openwa.sqlite)"
  backup_sqlite "$DATA_DB" "$STAGE/openwa.sqlite"
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

log "Backup complete: $ARCHIVE"
log "SECURITY: this archive can contain database passwords, plugin secrets, and an admin API key; restrict and encrypt it"
log "Contents:"
tar -tzf "$ARCHIVE" | sed 's/^/[backup]   /'
