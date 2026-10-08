#!/usr/bin/env bash
#
# OpenWA restore.
#
# Restores the always-SQLite auth/audit database, a SQLite data store, engine authentication, local
# media, installed plugins, and bootstrap configuration from an archive produced by scripts/backup.sh.
# PostgreSQL dumps are staged for the explicit psql import printed at the end of the restore.
#
# Usage:
#   ./scripts/restore.sh <backup-archive.tar.gz> [--strict] [--force]
# Options:
#   --strict          refuse to restore an archive whose CONSISTENCY-WARNING marker reports
#                     plain-copied (possibly torn) database snapshots; without it the restore
#                     continues after a loud warning. An ENGINE-STATE-NOTE (engine auth state that
#                     may have been copied while the app ran) is printed either way and never refused.
#   --force           overwrite databases that already hold a working install's data; without it
#                     the restore refuses to touch a live target before changing anything
# Environment:
#   MAIN_DATABASE_NAME  restore target for the auth/audit DB (default: <data dir>/main.sqlite)
#   DATABASE_NAME       restore target for the SQLite data store (default: <data dir>/openwa.sqlite)
#                       Both resolve EXACTLY like the app: the environment first, then ./.env, then
#                       .env.generated (the archive's copy when it carries one, else the data dir's),
#                       otherwise the app's ./data default (see lib-env.sh).
#   OPENWA_DATA_DIR   the app's ./data directory to restore into, such as a volume's mountpoint on
#                     the host (default: ./data); the ./data defaults, and a ./data/... path read
#                     from ./.env or .env.generated, are taken under it
#   SESSION_DATA_PATH, BAILEYS_AUTH_DIR, STORAGE_LOCAL_PATH, PLUGINS_DIR
#                     override the corresponding state directories
#   PLUGIN_STATE_DIR  root whose plugins/ holds the plugin registry and ctx.storage (default: the
#                     data dir)
#   BOOTSTRAP_KEY_FILE  where the plaintext admin key goes (default: <data dir>/.api-key)
#                     These paths resolve through the same layers as the databases.
#   OPENWA_RESTORE_SNAPSHOT_DIR
#                     where the safety snapshots go (default: next to the data dir, and next to
#                     each target outside it); needed when a parent is read-only, as in the
#                     shipped container
#
# Stop the OpenWA app before restoring. A snapshot of the current data dir, and of every target
# outside it, is taken before anything is written so a bad restore can be undone.
#
set -euo pipefail
# Restored databases, credentials, and snapshots must not inherit a permissive operator umask.
umask 077

STRICT=0
FORCE=0
ARCHIVE=""
for arg in "$@"; do
  case "$arg" in
    --strict)
      STRICT=1
      ;;
    --force)
      FORCE=1
      ;;
    -h | --help)
      echo "Usage: $0 <backup-archive.tar.gz> [--strict] [--force]"
      exit 0
      ;;
    -*)
      echo "Unknown option: $arg" >&2
      echo "Usage: $0 <backup-archive.tar.gz> [--strict] [--force]" >&2
      exit 1
      ;;
    *)
      if [ -n "$ARCHIVE" ]; then
        echo "Unexpected extra argument: $arg" >&2
        echo "Usage: $0 <backup-archive.tar.gz> [--strict] [--force]" >&2
        exit 1
      fi
      ARCHIVE="$arg"
      ;;
  esac
done

DATA_DIR="${OPENWA_DATA_DIR:-./data}"
# shellcheck source=scripts/lib-env.sh
. "$(dirname "$0")/lib-env.sh"
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

# refuse_unwritable <path> <label>: stop in the snapshot phase, before the first database is replaced.
refuse_unwritable() {
  log "ERROR: cannot write the $2 target: $1"
  log "       nothing has been restored yet; fix its permissions or point the setting at a writable path, then re-run"
  exit 1
}

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
  if [ "$PHASE" = snapshot ]; then
    # An existing directory is emptied before it is refilled, which needs every directory in it.
    openwa_writable "$target_dir" || refuse_unwritable "$target_dir" "$label"
    if [ -d "$target_dir" ]; then
      blocked="$(find "$target_dir/" -type d \
        -exec sh -c 'for d do [ -w "$d" ] || { echo "$d"; exit 1; }; done' sh {} + 2>/dev/null)" || true
      [ -z "$blocked" ] || refuse_unwritable "${blocked%%$'\n'*}" "$label"
    fi
    snapshot_external "$target_dir"
    return
  fi
  log "Restoring $label"
  if [ -d "$target_dir" ]; then
    # Empty the directory and refill it rather than remove it: it may be a mount point (a volume under
    # the container's read-only root), which can be neither removed nor re-created. A symlink to a
    # directory is refilled through the link, so an operator's layout on another disk survives. The
    # trailing slash makes find descend into the link's target instead of stopping at the link.
    find "$target_dir/" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
    cp -pR "$source_dir/." "$target_dir/"
  else
    rm -rf -- "$target_dir"
    mkdir -p "$(dirname "$target_dir")"
    cp -pR "$source_dir" "$target_dir"
  fi
}

# The data-dir safety snapshot below cannot cover a target that lives OUTSIDE it (a custom
# MAIN_DATABASE_NAME / DATABASE_NAME, SESSION_DATA_PATH, BAILEYS_AUTH_DIR, STORAGE_LOCAL_PATH,
# PLUGINS_DIR or BOOTSTRAP_KEY_FILE). Preserve such a target separately, so a restore pointed at the
# wrong archive remains recoverable. OPENWA_RESTORE_SNAPSHOT_DIR takes these snapshots too when it is
# set: a target on its own mount under a read-only root has no writable place next to it.
snapshot_external() {
  target="$1"
  external_snapshot=""
  case "$(resolve_path "$target")" in
    "$RESOLVED_DATA_DIR"/*) return 0 ;;
  esac
  [ -e "$target" ] || return 0
  snapshot_dir="${OPENWA_RESTORE_SNAPSHOT_DIR:-$(dirname "$target")}"
  external_snapshot="${snapshot_dir%/}/$(basename "$target").pre-restore-$RESTORE_TIMESTAMP"
  # Targets from different parents can share a name in one snapshot dir (a PLUGINS_DIR and a
  # PLUGIN_STATE_DIR both end in plugins); never copy one into the other's snapshot.
  n=1
  while [ -e "$external_snapshot" ]; do
    n=$((n + 1))
    external_snapshot="${snapshot_dir%/}/$(basename "$target").pre-restore-$RESTORE_TIMESTAMP-$n"
  done
  log "Snapshotting current $target -> $external_snapshot"
  mkdir -p "$snapshot_dir"
  # -H copies what a symlinked target points at. The restore writes through such a link, so a copy of
  # the link itself would end up showing the archive instead of the state it replaced.
  cp -pRH "$target" "$external_snapshot"
}

# restore_db <staged file> <target> <label>
# SQLite keeps un-checkpointed transactions in <db>-wal (and a crashed transaction in <db>-journal),
# named after the symlink-resolved file, and replays them over whatever main file it finds next to
# them. Those sidecars belong to the database being replaced: they go into its snapshot and are
# removed before the copy, or the restored file reads back the old install's rows.
restore_db() {
  resolved_db="$(resolve_path "$2")"
  if [ "$PHASE" = snapshot ]; then
    openwa_writable "$2" || refuse_unwritable "$2" "$3"
    for db in "$2" "$resolved_db"; do
      for sfx in -wal -shm -journal; do
        if [ -e "$db$sfx" ] && [ ! -w "$(dirname "$db")" ]; then
          refuse_unwritable "$(dirname "$db")" "$3"
        fi
      done
    done
    snapshot_external "$2"
    # Empty when the target lives in the data dir, whose own snapshot already holds the sidecars.
    if [ -n "$external_snapshot" ]; then
      for sfx in -wal -shm -journal; do
        for db in "$2" "$resolved_db"; do
          if [ -f "$db$sfx" ]; then
            cp -p "$db$sfx" "$external_snapshot$sfx"
          fi
        done
      done
    fi
    return
  fi
  log "Restoring $3 -> $2"
  mkdir -p "$(dirname "$2")"
  rm -f -- "$2-wal" "$2-shm" "$2-journal" "$resolved_db-wal" "$resolved_db-shm" "$resolved_db-journal"
  cp "$1" "$2"
  # Owner-only, matching what the app re-tightens on every boot (sqlite-file-permissions.ts);
  # cp preserves the staged mode, and a foreign-umask extraction may leave it broader.
  chmod 0600 "$2" 2>/dev/null || true
}

# A restore target that already holds a working install's tables is LIVE: overwriting it destroys
# real data, and the pre-restore snapshot is a convenience, not a recovery guarantee. Probe with
# the same sqlite3 CLI backup.sh snapshots with, opened read-only so the guard itself cannot touch
# the target it is guarding; a missing file — or one with no tables yet, as a
# fresh install leaves behind — is safe to restore over. Without the CLI there is no way to prove
# the file empty, so any non-empty target counts as live rather than guessed safe.
# sqlite3 applies the operator's rc file even to a one-shot query, and .headers on or another output
# mode turns the count into text, so the probe loads no rc file. Anything but a bare count still
# means the probe did not answer, which counts as live like a probe that failed outright.
db_appears_live() {
  target="$1"
  [ -f "$target" ] || return 1
  if command -v sqlite3 >/dev/null 2>&1; then
    tables="$(sqlite3 -batch -noheader -list -init /dev/null -readonly "$target" \
      "SELECT count(*) FROM sqlite_master;" 2>/dev/null)" || return 0
    case "$tables" in
      '' | *[!0-9]*)
        return 0
        ;;
    esac
    [ "$tables" -gt 0 ]
  else
    [ -s "$target" ]
  fi
}

if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "Usage: $0 <backup-archive.tar.gz> [--strict] [--force]" >&2
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

# Targets resolve exactly like the app: an explicit environment value, then ./.env, then the
# dashboard's .env.generated, else the app's ./data defaults under OPENWA_DATA_DIR. They may
# legitimately live outside it. The archive's .env.generated replaces the target's further down, so
# when it carries one, that copy is the third layer: the restored app reads its paths, and state
# placed where the replaced file pointed would never be opened. Resolved before anything is
# validated or written.
if [ -f "$STAGE/.env.generated" ]; then
  OPENWA_GENERATED_ENV="$STAGE/.env.generated"
  log "Paths not set in the environment or ./.env come from the archive's .env.generated."
fi
MAIN_DB="$(openwa_resolve MAIN_DATABASE_NAME "${DATA_DIR%/}/main.sqlite" path)"
# DATABASE_NAME is only a target for an archive carrying the SQLite data store; a PostgreSQL dump is
# loaded by hand, so a line for it the scripts cannot parse does not stop that restore.
if [ -f "$STAGE/openwa.sqlite" ]; then
  DATA_DB="$(openwa_resolve DATABASE_NAME "${DATA_DIR%/}/openwa.sqlite" path)"
fi
SESSIONS_DIR="$(openwa_resolve SESSION_DATA_PATH "$DATA_DIR/sessions" path)"
BAILEYS_DIR="$(openwa_resolve BAILEYS_AUTH_DIR "$DATA_DIR/baileys" path)"
MEDIA_DIR="$(openwa_media_dir)"
# Installed plugin code. The app defaults this to <dataDir>/plugins — the same tree as the
# registry and each plugin's ctx.storage below — so an unset PLUGINS_DIR must resolve there
# too, or the archive silently omits the plugin packages.
PLUGIN_PACKAGES_DIR="$(openwa_resolve PLUGINS_DIR "$DATA_DIR/plugins" path)"
# Plugin registry + every plugin's persisted ctx.storage. The app puts them at <dataDir>/plugins,
# where dataDir is PLUGIN_STATE_DIR when that is set and ./data otherwise, so the knob has to be
# resolved here exactly like PLUGINS_DIR above. Hardcoding $DATA_DIR/plugins meant an operator who
# moved plugin state got an archive with neither the registry nor any plugin's storage in it, and
# a restore that put nothing back. Resolved under its own name because the knob names the ROOT,
# not the plugins directory inside it.
PLUGIN_STATE_ROOT="$(openwa_resolve PLUGIN_STATE_DIR "$DATA_DIR" path)"
PLUGIN_STATE_DIR="$PLUGIN_STATE_ROOT/plugins"
# The app reads the plaintext admin key from BOOTSTRAP_KEY_FILE when that is set.
ADMIN_KEY_FILE="$(openwa_resolve BOOTSTRAP_KEY_FILE "$DATA_DIR/.api-key" path)"

# backup.sh archives state directories by content. An archive from before it followed symlinks
# carries a link instead, which on this host may point at the very directory the restore empties
# before refilling it from that link. Refuse it before any existing state is touched.
for member in sessions baileys media plugin-packages plugin-state; do
  if [ -L "$STAGE/$member" ]; then
    log "ERROR: archive member $member/ is a symlink, not a directory: the backup holds no data for it"
    log "       re-take the backup with this version of backup.sh, or extract the archive and restore by hand"
    exit 1
  fi
done

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

# Engine auth state copied while an engine may have been writing it. Informational only: every
# online backup of a running install carries it, and the worst case is a re-pair, not lost data.
if [ -f "$STAGE/ENGINE-STATE-NOTE" ]; then
  log "WARN: archive carries ENGINE-STATE-NOTE; engine auth state may have been copied while the app was running:"
  sed 's/^/[restore]   /' "$STAGE/ENGINE-STATE-NOTE"
fi

# Refuse to overwrite a live database without --force, BEFORE any existing state is touched (the
# same rule the --strict refusal above follows). Only the databases this archive actually carries
# are checked — a target the archive omits is left alone either way.
if [ "$FORCE" -ne 1 ]; then
  LIVE_TARGETS=""
  if [ -f "$STAGE/main.sqlite" ] && db_appears_live "$MAIN_DB"; then
    LIVE_TARGETS="$LIVE_TARGETS $MAIN_DB"
  fi
  if [ -f "$STAGE/openwa.sqlite" ] && db_appears_live "$DATA_DB"; then
    LIVE_TARGETS="$LIVE_TARGETS $DATA_DB"
  fi
  if [ -n "$LIVE_TARGETS" ]; then
    echo "[restore] ERROR: database target(s) appear live:$LIVE_TARGETS" >&2
    echo "[restore]        they already hold a working install's data — stop the app, then re-run with --force to overwrite them" >&2
    exit 1
  fi
fi

# Safety snapshot of whatever is there now, next to the data dir unless OPENWA_RESTORE_SNAPSHOT_DIR
# names another directory. The shipped compose file and Helm chart mount the data dir as a volume
# under a read-only root, where that sibling cannot be written.
if [ -d "$DATA_DIR" ] && [ -n "$(ls -A "$DATA_DIR" 2>/dev/null || true)" ]; then
  SAFETY_DIR="${OPENWA_RESTORE_SNAPSHOT_DIR:-$(dirname "$DATA_DIR")}"
  SAFETY="${SAFETY_DIR%/}/$(basename "$DATA_DIR").pre-restore-$RESTORE_TIMESTAMP"
  log "Snapshotting current data dir -> $SAFETY"
  mkdir -p "$SAFETY_DIR"
  # -H for a symlinked data dir, as in snapshot_external.
  cp -pRH "$DATA_DIR" "$SAFETY"
fi

mkdir -p "$DATA_DIR"

if [ ! -f "$STAGE/main.sqlite" ]; then
  log "WARN: main.sqlite not in archive — API keys / audit log will NOT be restored"
fi

MERGED_PLUGINS_DIR=""
if [ -d "$STAGE/plugin-packages" ] && [ -d "$STAGE/plugin-state" ] &&
  [ "$(resolve_path "$PLUGIN_PACKAGES_DIR")" = "$(resolve_path "$PLUGIN_STATE_DIR")" ]; then
  # Docker deployments deliberately colocate package and state files. Build the complete target in
  # staging and replace it once, so neither half can erase the other during restore.
  MERGED_PLUGINS_DIR="$STAGE/plugin-merged"
  mkdir -p "$MERGED_PLUGINS_DIR"
  cp -pR "$STAGE/plugin-packages/." "$MERGED_PLUGINS_DIR"
  cp -pR "$STAGE/plugin-state/." "$MERGED_PLUGINS_DIR"
fi

# Runs twice: PHASE=snapshot checks every target and snapshots the ones outside the data dir, then
# PHASE=apply writes them. A target that is refused, or cannot be snapshotted or written, stops the
# restore before the first database is written, instead of halfway through with a mixed install left
# behind.
restore_targets() {
  if [ -f "$STAGE/main.sqlite" ]; then
    restore_db "$STAGE/main.sqlite" "$MAIN_DB" "auth/audit DB"
  fi
  if [ -f "$STAGE/openwa.sqlite" ]; then
    restore_db "$STAGE/openwa.sqlite" "$DATA_DB" "data store"
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
  if [ -n "$MERGED_PLUGINS_DIR" ]; then
    replace_tree "$MERGED_PLUGINS_DIR" "$PLUGIN_PACKAGES_DIR" "installed plugins and plugin state"
  else
    if [ -d "$STAGE/plugin-packages" ]; then
      replace_tree "$STAGE/plugin-packages" "$PLUGIN_PACKAGES_DIR" "installed plugin packages"
    fi
    if [ -d "$STAGE/plugin-state" ]; then
      replace_tree "$STAGE/plugin-state" "$PLUGIN_STATE_DIR" "plugin registry and persisted state"
    fi
  fi
  if [ -f "$STAGE/.api-key" ]; then
    restore_admin_key
  fi
}

# The plaintext admin key goes where the app reads it. Checked and, outside the data dir, snapshotted
# with the other targets: it may be the only plaintext copy of a key the replaced main.sqlite accepts.
restore_admin_key() {
  if [ "$PHASE" = snapshot ]; then
    openwa_writable "$ADMIN_KEY_FILE" || refuse_unwritable "$ADMIN_KEY_FILE" "admin key (BOOTSTRAP_KEY_FILE)"
    snapshot_external "$ADMIN_KEY_FILE"
    return
  fi
  log "Restoring plaintext admin key -> $ADMIN_KEY_FILE"
  mkdir -p "$(dirname "$ADMIN_KEY_FILE")"
  cp "$STAGE/.api-key" "$ADMIN_KEY_FILE"
  chmod 0600 "$ADMIN_KEY_FILE"
}

PHASE=snapshot
restore_targets
# Written into the data dir after the targets, so checked with them; the data-dir snapshot holds both.
if [ -f "$STAGE/.env.generated" ]; then
  openwa_writable "$DATA_DIR/.env.generated" ||
    refuse_unwritable "$DATA_DIR/.env.generated" "dashboard-generated configuration"
fi
if [ -f "$STAGE/database.sql" ]; then
  openwa_writable "$DATA_DIR/database.sql" || refuse_unwritable "$DATA_DIR/database.sql" "PostgreSQL dump"
fi
PHASE=apply
restore_targets

if [ -f "$STAGE/.env.generated" ]; then
  log "Restoring dashboard-generated configuration"
  cp "$STAGE/.env.generated" "$DATA_DIR/.env.generated"
  chmod 0600 "$DATA_DIR/.env.generated"
fi

if [ -f "$STAGE/database.sql" ]; then
  cp "$STAGE/database.sql" "$DATA_DIR/database.sql"
  log "Postgres dump present: load it into an EMPTY database, as docs/11-operational-runbooks.md"
  log "(Restore from Backup, step 3) shows for the built-in openwa-postgres container. For an external"
  log "server, with DATABASE_URL set to your own URL for that database:"
  log "  sed '/^SET transaction_timeout = 0;\$/d' $DATA_DIR/database.sql | psql -v ON_ERROR_STOP=1 \"\$DATABASE_URL\""
  log "(sed drops a setting this image's pg_dump 17 writes and PostgreSQL 16 rejects)"
fi

log "Restore complete. Start the app and confirm an existing API key still authenticates."
