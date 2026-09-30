#!/usr/bin/env bash
#
# OpenWA backup.
#
# Captures the load-bearing state needed to restore a working install:
#   - main.sqlite   — auth (API keys) + audit log, ALWAYS SQLite (see app.module.ts)
#   - data store    — openwa.sqlite (SQLite) OR a pg_dump (when DATABASE_TYPE=postgres)
#   - sessions/     — whatsapp-web.js LocalAuth session data
#   - baileys/      — Baileys engine authentication state
#   - media/        — the local media dir (STORAGE_LOCAL_PATH), archived whenever it exists. Under
#                     STORAGE_TYPE=s3 it holds only media the app could not write to the bucket
#                     (unreachable, or no credentials); the bucket's contents are not archived and
#                     need a backup of their own
#   - plugin-packages/ — installed plugin packages from PLUGINS_DIR
#   - plugin-state/    — registry and persisted ctx.storage state under PLUGIN_STATE_DIR/plugins
#                        (default: <data dir>/plugins)
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
#   PLUGIN_STATE_DIR  root whose plugins/ holds the plugin registry and ctx.storage (default: the
#                     data dir)
#   BOOTSTRAP_KEY_FILE  the plaintext admin key to archive (default: <data dir>/.api-key)
#                     These paths resolve through the same layers as the databases.
#   For postgres: DATABASE_URL, or DATABASE_HOST/PORT/USERNAME/PASSWORD/NAME
#                     DATABASE_URL is read by this script only (the app uses the DATABASE_* keys)
#                     and wins over them when set. It is passed to pg_dump as an argument, which
#                     other local users can read in the process list, so leave the password out of
#                     it and supply PGPASSWORD or ~/.pgpass instead; the DATABASE_* path already
#                     passes DATABASE_PASSWORD through PGPASSWORD.
#
# Failure policy: a missing source database is FATAL (no silent empty backup), and the finished
# archive must contain every configured database or it is deleted and the run fails. When the
# sqlite3 CLI is unavailable the databases are plain-copied (possibly torn if the app is live) and
# the archive carries a CONSISTENCY-WARNING marker that restore.sh surfaces.
#
# Engine authentication state (sessions/, baileys/) is copied, not snapshotted: the engines rewrite
# it while they run, so an online backup can hold a copy torn mid-write. When a whatsapp-web.js
# profile is open or Baileys state is present, the archive carries an ENGINE-STATE-NOTE that
# restore.sh prints without refusing (--strict gates only the database marker). For a copy that is
# consistent by construction, stop the sessions (or the container) first.
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
MEDIA_DIR="$(openwa_media_dir)"
# Installed plugin code. The app defaults this to <dataDir>/plugins — the same tree as the
# registry and each plugin's ctx.storage below — so an unset PLUGINS_DIR must resolve there
# too, or the archive silently omits the plugin packages.
PLUGIN_PACKAGES_DIR="$(openwa_resolve PLUGINS_DIR "$DATA_DIR/plugins")"
# Plugin registry + every plugin's persisted ctx.storage. The app puts them at <dataDir>/plugins,
# where dataDir is PLUGIN_STATE_DIR when that is set and ./data otherwise, so the knob has to be
# resolved here exactly like PLUGINS_DIR above. Hardcoding $DATA_DIR/plugins meant an operator who
# moved plugin state got an archive with neither the registry nor any plugin's storage in it, and
# a restore that put nothing back. Resolved under its own name because the knob names the ROOT,
# not the plugins directory inside it.
PLUGIN_STATE_ROOT="$(openwa_resolve PLUGIN_STATE_DIR "$DATA_DIR")"
PLUGIN_STATE_DIR="$PLUGIN_STATE_ROOT/plugins"
GENERATED_ENV="$DATA_DIR/.env.generated"
# The app writes the generated admin key to BOOTSTRAP_KEY_FILE when that is set.
ADMIN_KEY_FILE="$(openwa_resolve BOOTSTRAP_KEY_FILE "$DATA_DIR/.api-key")"

log() { echo "[backup] $*"; }

# Check the destination before staging anything. The shipped container's root filesystem is
# read-only, so the default ./backups (/app/backups) cannot be created there; failing only at the
# end would first copy every database, session and media file into the staging directory.
if ! mkdir -p "$BACKUP_DIR" 2>/dev/null || [ ! -w "$BACKUP_DIR" ]; then
  log "ERROR: BACKUP_DIR=$BACKUP_DIR is not writable; point BACKUP_DIR at a writable, persistent directory (inside the container use BACKUP_DIR=/app/data/backups, and under docker compose also TMPDIR=/app/data/backups: its /tmp is a tmpfs charged to the container's memory)"
  exit 1
fi

# The staging copy goes to TMPDIR. Under docker compose that is a tmpfs charged to the container's
# memory limit, so an in-container run there points TMPDIR at the data volume (docs/11); staging the
# data in the tmpfs gets the running gateway OOM-killed once the data outgrows its headroom.
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

ENGINE_STATE_NOTE="$STAGE/ENGINE-STATE-NOTE"

# Marker file shipped INSIDE the archive: engine auth state was copied while an engine may have been
# writing it. Separate from the database marker so restore.sh --strict does not refuse every online
# backup; a torn auth copy costs a re-pair, not data.
record_engine_state_note() {
  if [ ! -f "$ENGINE_STATE_NOTE" ]; then
    cat >"$ENGINE_STATE_NOTE" <<'EOF'
The engine authentication state listed below was copied while the app may have been writing it:
these directories are plain copies. This note does not cover the databases; a CONSISTENCY-WARNING
in the same archive does. If a restored session does not reconnect, pair it again, or re-take the
backup with the sessions (or the container) stopped.
EOF
  fi
  echo "$1" >>"$ENGINE_STATE_NOTE"
  log "WARN: engine auth state may have been written during the copy; a restore may need re-pairing: $1"
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
  DATABASE_URL_RESOLVED="$(openwa_resolve DATABASE_URL '')"
  if [ -n "$DATABASE_URL_RESOLVED" ]; then
    pg_dump "$DATABASE_URL_RESOLVED" >"$STAGE/database.sql"
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

# The state directories below are copied with -H: a directory an operator moved to another disk and
# linked back is archived by its content. Without it the archive held only the link, with no data.
if [ -d "$SESSIONS_DIR" ]; then
  log "Backing up whatsapp-web.js sessions"
  cp -pRH "$SESSIONS_DIR" "$STAGE/sessions"
  # Chromium holds a SingletonLock (a symlink, so not `-e`) in every profile it has open, and the
  # entrypoint clears stale ones at start, so a lock here means a browser was writing that profile.
  OPEN_PROFILES="$(find -H "$SESSIONS_DIR" -mindepth 2 -maxdepth 2 -name SingletonLock -exec dirname {} \; |
    sed 's|.*/||' | sort | tr '\n' ' ')"
  if [ -n "$OPEN_PROFILES" ]; then
    record_engine_state_note "sessions/ (whatsapp-web.js profiles open in a browser: ${OPEN_PROFILES% })"
  fi
else
  log "WARN: $SESSIONS_DIR not found — skipping sessions"
fi

if [ -d "$BAILEYS_DIR" ]; then
  log "Backing up Baileys authentication state"
  cp -pRH "$BAILEYS_DIR" "$STAGE/baileys"
  # Baileys rewrites creds.json and its key files during normal traffic and leaves no sign of being
  # live, so any session's state counts, stopped or not.
  if [ -n "$(find -H "$BAILEYS_DIR" -mindepth 1 -maxdepth 1 -type d -print -quit)" ]; then
    record_engine_state_note "baileys/ (recorded whenever Baileys state exists; it cannot show whether it was live)"
  fi
elif [ "${ENGINE_TYPE:-}" = "baileys" ]; then
  log "WARN: ENGINE_TYPE=baileys but $BAILEYS_DIR was not found — restored sessions will require pairing"
fi

if [ -d "$MEDIA_DIR" ]; then
  log "Backing up local media"
  cp -pRH "$MEDIA_DIR" "$STAGE/media"
else
  log "WARN: $MEDIA_DIR not found; skipping local media"
fi

if [ -d "$PLUGIN_PACKAGES_DIR" ]; then
  log "Backing up installed plugin packages"
  cp -pRH "$PLUGIN_PACKAGES_DIR" "$STAGE/plugin-packages"
fi

# With PLUGINS_DIR unset the app also loads packages from ./plugins, its default up to 0.12.1 (see
# plugin-package-scanner.ts). The archive does not carry that directory, so say so.
if [ -z "$(openwa_resolve PLUGINS_DIR '')" ] &&
  [ -n "$(find -H ./plugins -mindepth 2 -maxdepth 2 -name manifest.json ! -path './plugins/.*' 2>/dev/null)" ]; then
  log "WARN: ./plugins holds plugin packages the app still loads, and this archive does not carry them;"
  log "      move them into $PLUGIN_PACKAGES_DIR, or set PLUGINS_DIR=./plugins, and back up again"
fi

if [ -d "$PLUGIN_STATE_DIR" ]; then
  log "Backing up plugin registry and persisted state"
  cp -pRH "$PLUGIN_STATE_DIR" "$STAGE/plugin-state"
fi

if [ -f "$GENERATED_ENV" ]; then
  log "Backing up dashboard-generated configuration"
  cp -p "$GENERATED_ENV" "$STAGE/.env.generated"
fi

if [ -f "$ADMIN_KEY_FILE" ]; then
  log "Backing up plaintext admin key"
  cp -p "$ADMIN_KEY_FILE" "$STAGE/.api-key"
fi

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
