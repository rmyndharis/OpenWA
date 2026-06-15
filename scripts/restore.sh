#!/usr/bin/env bash
#
# OpenWA restore.
#
# Restores BOTH databases (auth/audit + data) and the WhatsApp sessions from an
# archive produced by scripts/backup.sh, so API keys and audit history survive.
#
# Usage:
#   ./scripts/restore.sh <backup-archive.tar.gz>
# Environment:
#   OPENWA_DATA_DIR   data directory to restore into (default: ./data)
#
# Stop the OpenWA app before restoring. A snapshot of the current data dir is taken
# first so a bad restore can be undone.
#
set -euo pipefail

ARCHIVE="${1:-}"
DATA_DIR="${OPENWA_DATA_DIR:-./data}"

log() { echo "[restore] $*"; }

if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "Usage: $0 <backup-archive.tar.gz>" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

log "Extracting $ARCHIVE"
tar -xzf "$ARCHIVE" -C "$STAGE"

# Safety snapshot of whatever is there now.
if [ -d "$DATA_DIR" ] && [ -n "$(ls -A "$DATA_DIR" 2>/dev/null || true)" ]; then
  SAFETY="${DATA_DIR%/}.pre-restore-$(date +%Y%m%d-%H%M%S)"
  log "Snapshotting current data dir -> $SAFETY"
  cp -r "$DATA_DIR" "$SAFETY"
fi

mkdir -p "$DATA_DIR"

if [ -f "$STAGE/main.sqlite" ]; then
  log "Restoring auth/audit DB (main.sqlite)"
  cp "$STAGE/main.sqlite" "$DATA_DIR/main.sqlite"
else
  log "WARN: main.sqlite not in archive — API keys / audit log will NOT be restored"
fi

if [ -f "$STAGE/openwa.sqlite" ]; then
  log "Restoring data store (openwa.sqlite)"
  cp "$STAGE/openwa.sqlite" "$DATA_DIR/openwa.sqlite"
fi

if [ -d "$STAGE/sessions" ]; then
  log "Restoring WhatsApp sessions"
  rm -rf "$DATA_DIR/sessions"
  cp -r "$STAGE/sessions" "$DATA_DIR/sessions"
fi

if [ -d "$STAGE/media" ]; then
  log "Restoring local media"
  rm -rf "$DATA_DIR/media"
  cp -r "$STAGE/media" "$DATA_DIR/media"
fi

if [ -f "$STAGE/database.sql" ]; then
  cp "$STAGE/database.sql" "$DATA_DIR/database.sql"
  log "Postgres dump present — import it manually into your Postgres instance:"
  log "  psql \"\$DATABASE_URL\" < $DATA_DIR/database.sql"
fi

log "Restore complete. Start the app and confirm an existing API key still authenticates."
