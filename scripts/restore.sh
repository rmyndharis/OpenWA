#!/usr/bin/env bash
#
# OpenWA restore.
#
# Restores the always-SQLite auth/audit database, a SQLite data store, engine authentication, local
# media, installed plugins, and bootstrap configuration from an archive produced by scripts/backup.sh.
# PostgreSQL dumps are staged for the explicit psql import printed at the end of the restore.
#
# Usage:
#   ./scripts/restore.sh <backup-archive.tar.gz> [--strict]
# Options:
#   --strict          refuse to restore an archive whose CONSISTENCY-WARNING marker reports
#                     plain-copied (possibly torn) database snapshots; without it the restore
#                     continues after a loud warning
# Environment:
#   MAIN_DATABASE_NAME  restore target for the auth/audit DB (default: ./data/main.sqlite)
#   DATABASE_NAME       restore target for the SQLite data store (default: ./data/openwa.sqlite)
#                       Both resolve EXACTLY like the app (src/config/configuration.ts): the
#                       explicit env path wins, otherwise the fixed ./data default. They are NOT
#                       derived from OPENWA_DATA_DIR — restoring there would write databases the
#                       app never reads (fresh-empty boot + new master key).
#   OPENWA_DATA_DIR   data directory to restore non-DB state into (default: ./data)
#   SESSION_DATA_PATH, BAILEYS_AUTH_DIR, STORAGE_LOCAL_PATH, PLUGINS_DIR
#                     override the corresponding state directories
#
# Stop the OpenWA app before restoring. A snapshot of the current data dir is taken
# first so a bad restore can be undone.
#
set -euo pipefail
# Restored databases, credentials, and snapshots must not inherit a permissive operator umask.
umask 077

STRICT=0
ARCHIVE=""
for arg in "$@"; do
  case "$arg" in
    --strict)
      STRICT=1
      ;;
    -h | --help)
      echo "Usage: $0 <backup-archive.tar.gz> [--strict]"
      exit 0
      ;;
    -*)
      echo "Unknown option: $arg" >&2
      echo "Usage: $0 <backup-archive.tar.gz> [--strict]" >&2
      exit 1
      ;;
    *)
      if [ -n "$ARCHIVE" ]; then
        echo "Unexpected extra argument: $arg" >&2
        echo "Usage: $0 <backup-archive.tar.gz> [--strict]" >&2
        exit 1
      fi
      ARCHIVE="$arg"
      ;;
  esac
done

DATA_DIR="${OPENWA_DATA_DIR:-./data}"
# shellcheck source=scripts/lib-env.sh
. "$(dirname "$0")/lib-env.sh"
# Database targets resolve exactly like the app: an explicit environment value, then ./.env, then the
# dashboard's <data dir>/.env.generated, else the fixed ./data defaults. They may legitimately live
# outside OPENWA_DATA_DIR. This reads the config of the install being restored INTO, which is why it
# happens here rather than after the archive's own .env.generated is written over it further down.
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
RESTORE_TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
RESOLVED_CWD="$(pwd -P)"

# Resolve symlinks in the nearest existing ancestor as well as lexical '..' segments. This matters for
# destructive targets such as /mount-link/sessions: path.resolve alone would not reveal that mount-link
# points at the workspace, home directory, or another broad protected target.
resolve_path() {
  node -e '
    const fs = require("fs");
    const path = require("path");
    let current = path.resolve(process.argv[1]);
    const missing = [];
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) break;
      missing.unshift(path.basename(current));
      current = parent;
    }
    const physical = fs.existsSync(current) ? fs.realpathSync(current) : current;
    console.log(path.join(physical, ...missing));
  ' "$1"
}

RESOLVED_DATA_DIR="$(resolve_path "$DATA_DIR")"
RESOLVED_USER_HOME="$(resolve_path "${HOME:-/nonexistent-openwa-home}")"

log() { echo "[restore] $*"; }

case "$DATA_DIR" in
  '' | / | . | ./ | .. | ../)
    log "ERROR: refusing unsafe OPENWA_DATA_DIR target: ${DATA_DIR:-<empty>}"
    exit 1
    ;;
esac
case "$RESOLVED_CWD/" in
  "$RESOLVED_DATA_DIR"/*)
    log "ERROR: OPENWA_DATA_DIR must not be the workspace or one of its parent directories: $DATA_DIR"
    exit 1
    ;;
esac
if [ "$RESOLVED_DATA_DIR" = "$RESOLVED_USER_HOME" ]; then
  log "ERROR: OPENWA_DATA_DIR must not be the user home directory: $DATA_DIR"
  exit 1
fi

replace_tree() {
  source_dir="$1"
  target_dir="$2"
  label="$3"
  case "$target_dir" in
    '' | / | . | ./ | .. | ../)
      log "ERROR: refusing to replace unsafe $label target: ${target_dir:-<empty>}"
      exit 1
      ;;
  esac
  resolved_target="$(resolve_path "$target_dir")"
  if [ "$resolved_target" = "/" ] || [ "$resolved_target" = "$RESOLVED_CWD" ] || [ "$resolved_target" = "$RESOLVED_DATA_DIR" ] || [ "$resolved_target" = "$RESOLVED_USER_HOME" ]; then
    log "ERROR: refusing to replace broad $label target: $target_dir"
    exit 1
  fi
  case "$RESOLVED_CWD/" in
    "$resolved_target"/*)
      log "ERROR: refusing to replace $label target that contains the workspace: $target_dir"
      exit 1
      ;;
  esac
  case "$RESOLVED_DATA_DIR/" in
    "$resolved_target"/*)
      log "ERROR: refusing to replace $label target that contains the data directory: $target_dir"
      exit 1
      ;;
  esac
  # The initial data-dir snapshot already covers normal nested targets. Preserve any custom target
  # outside data/ separately before replacing it, so a custom PLUGINS_DIR/auth path remains recoverable.
  case "$resolved_target" in
    "$RESOLVED_DATA_DIR"/*) ;;
    *)
      if [ -e "$target_dir" ]; then
        external_snapshot="${target_dir%/}.pre-restore-$RESTORE_TIMESTAMP"
        log "Snapshotting current $label -> $external_snapshot"
        cp -pR "$target_dir" "$external_snapshot"
      fi
      ;;
  esac
  log "Restoring $label"
  rm -rf -- "$target_dir"
  mkdir -p "$(dirname "$target_dir")"
  cp -pR "$source_dir" "$target_dir"
}

# The data-dir safety snapshot below cannot cover a database target that lives OUTSIDE it (custom
# MAIN_DATABASE_NAME / DATABASE_NAME). Preserve such a file separately before overwriting it, so a
# restore pointed at the wrong archive remains recoverable.
snapshot_external_db() {
  target="$1"
  resolved_target="$(resolve_path "$target")"
  case "$resolved_target" in
    "$RESOLVED_DATA_DIR"/*) ;;
    *)
      if [ -e "$target" ]; then
        external_snapshot="${target}.pre-restore-$RESTORE_TIMESTAMP"
        log "Snapshotting current $target -> $external_snapshot"
        cp -p "$target" "$external_snapshot"
      fi
      ;;
  esac
}

if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "Usage: $0 <backup-archive.tar.gz> [--strict]" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

log "Extracting $ARCHIVE"
# Refuse archive path names that could escape STAGE. This restore command accepts archives produced by
# backup.sh; path validation is an additional traversal guard, not a general untrusted-tar verifier.
while IFS= read -r entry; do
  case "$entry" in
    /* | ../* | */../* | */..)
      log "ERROR: unsafe path in backup archive: $entry"
      exit 1
      ;;
  esac
done < <(tar -tzf "$ARCHIVE")
tar -xzf "$ARCHIVE" -C "$STAGE"

# A backup taken without sqlite3 .backup carries this marker: the database snapshots were
# plain-copied from a possibly-live app and may be torn. Warn loudly and continue — unless
# --strict makes it fatal. Refuse BEFORE touching any existing state.
if [ -f "$STAGE/CONSISTENCY-WARNING" ]; then
  log "WARN: archive carries CONSISTENCY-WARNING — database snapshot(s) may be torn:"
  sed 's/^/[restore]   /' "$STAGE/CONSISTENCY-WARNING"
  if [ "$STRICT" -eq 1 ]; then
    log "ERROR: --strict given — refusing to restore a possibly-torn database snapshot"
    exit 1
  fi
  log "WARN: continuing anyway; verify data integrity after the restore (re-run with --strict to make this fatal)"
fi

# Safety snapshot of whatever is there now.
if [ -d "$DATA_DIR" ] && [ -n "$(ls -A "$DATA_DIR" 2>/dev/null || true)" ]; then
  SAFETY="${DATA_DIR%/}.pre-restore-$RESTORE_TIMESTAMP"
  log "Snapshotting current data dir -> $SAFETY"
  cp -pR "$DATA_DIR" "$SAFETY"
fi

mkdir -p "$DATA_DIR"

if [ -f "$STAGE/main.sqlite" ]; then
  log "Restoring auth/audit DB -> $MAIN_DB"
  snapshot_external_db "$MAIN_DB"
  mkdir -p "$(dirname "$MAIN_DB")"
  cp "$STAGE/main.sqlite" "$MAIN_DB"
else
  log "WARN: main.sqlite not in archive — API keys / audit log will NOT be restored"
fi

if [ -f "$STAGE/openwa.sqlite" ]; then
  log "Restoring data store -> $DATA_DB"
  snapshot_external_db "$DATA_DB"
  mkdir -p "$(dirname "$DATA_DB")"
  cp "$STAGE/openwa.sqlite" "$DATA_DB"
fi

if [ -d "$STAGE/sessions" ]; then
  replace_tree "$STAGE/sessions" "$SESSIONS_DIR" "whatsapp-web.js sessions"
fi

if [ -d "$STAGE/baileys" ]; then
  replace_tree "$STAGE/baileys" "$BAILEYS_DIR" "Baileys authentication state"
fi

if [ -d "$STAGE/media" ]; then
  replace_tree "$STAGE/media" "$MEDIA_DIR" "local media"
fi

if [ -d "$STAGE/plugin-packages" ] && [ -d "$STAGE/plugin-state" ]; then
  RESOLVED_PLUGIN_PACKAGES_DIR="$(resolve_path "$PLUGIN_PACKAGES_DIR")"
  RESOLVED_PLUGIN_STATE_DIR="$(resolve_path "$PLUGIN_STATE_DIR")"
  if [ "$RESOLVED_PLUGIN_PACKAGES_DIR" = "$RESOLVED_PLUGIN_STATE_DIR" ]; then
    # Docker deployments deliberately colocate package and state files. Build the complete target in
    # staging and replace it once, so neither half can erase the other during restore.
    MERGED_PLUGINS_DIR="$STAGE/plugin-merged"
    mkdir -p "$MERGED_PLUGINS_DIR"
    cp -pR "$STAGE/plugin-packages/." "$MERGED_PLUGINS_DIR"
    cp -pR "$STAGE/plugin-state/." "$MERGED_PLUGINS_DIR"
    replace_tree "$MERGED_PLUGINS_DIR" "$PLUGIN_PACKAGES_DIR" "installed plugins and plugin state"
  else
    replace_tree "$STAGE/plugin-packages" "$PLUGIN_PACKAGES_DIR" "installed plugin packages"
    replace_tree "$STAGE/plugin-state" "$PLUGIN_STATE_DIR" "plugin registry and persisted state"
  fi
elif [ -d "$STAGE/plugin-packages" ]; then
  replace_tree "$STAGE/plugin-packages" "$PLUGIN_PACKAGES_DIR" "installed plugin packages"
elif [ -d "$STAGE/plugin-state" ]; then
  replace_tree "$STAGE/plugin-state" "$PLUGIN_STATE_DIR" "plugin registry and persisted state"
fi

if [ -f "$STAGE/.env.generated" ]; then
  log "Restoring dashboard-generated configuration"
  cp "$STAGE/.env.generated" "$DATA_DIR/.env.generated"
  chmod 0600 "$DATA_DIR/.env.generated"
fi

if [ -f "$STAGE/.api-key" ]; then
  log "Restoring plaintext admin key"
  cp "$STAGE/.api-key" "$DATA_DIR/.api-key"
  chmod 0600 "$DATA_DIR/.api-key"
fi

if [ -f "$STAGE/database.sql" ]; then
  cp "$STAGE/database.sql" "$DATA_DIR/database.sql"
  log "Postgres dump present — import it manually into your Postgres instance:"
  log "  psql \"\$DATABASE_URL\" < $DATA_DIR/database.sql"
fi

log "Restore complete. Start the app and confirm an existing API key still authenticates."
