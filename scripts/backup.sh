#!/usr/bin/env bash
#
# OpenWA backup.
#
# Captures EVERYTHING needed to restore a working install:
#   - main.sqlite   — auth (API keys) + audit log, ALWAYS SQLite (see app.module.ts)
#   - data store    — openwa.sqlite (SQLite) OR a pg_dump (when DATABASE_TYPE=postgres)
#   - sessions/     — WhatsApp LocalAuth session data
#   - media/        — locally-stored media (skipped automatically when using S3)
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
#   For postgres: DATABASE_URL, or DATABASE_HOST/PORT/USERNAME/PASSWORD/NAME
#
set -euo pipefail

DATA_DIR="${OPENWA_DATA_DIR:-./data}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
DATABASE_TYPE="${DATABASE_TYPE:-sqlite}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

MAIN_DB="$DATA_DIR/main.sqlite"
DATA_DB="$DATA_DIR/openwa.sqlite"
SESSIONS_DIR="$DATA_DIR/sessions"
MEDIA_DIR="$DATA_DIR/media"

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
  log "Backing up WhatsApp sessions"
  cp -r "$SESSIONS_DIR" "$STAGE/sessions"
else
  log "WARN: $SESSIONS_DIR not found — skipping sessions"
fi

if [ -d "$MEDIA_DIR" ]; then
  log "Backing up local media"
  cp -r "$MEDIA_DIR" "$STAGE/media"
fi

mkdir -p "$BACKUP_DIR"
ARCHIVE="$BACKUP_DIR/openwa-backup-$TIMESTAMP.tar.gz"
tar -czf "$ARCHIVE" -C "$STAGE" .

log "Backup complete: $ARCHIVE"
log "Contents:"
tar -tzf "$ARCHIVE" | sed 's/^/[backup]   /'
