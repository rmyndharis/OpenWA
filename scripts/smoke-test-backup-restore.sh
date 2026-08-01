#!/usr/bin/env bash
# Smoke test: scripts/backup.sh + scripts/restore.sh.
#
# Covers:
#   (a) custom MAIN_DATABASE_NAME / DATABASE_NAME are honored by BOTH scripts
#   (b) a missing source database fails hard (non-zero, clear message, no archive)
#   (c) backup -> restore roundtrip via sqlite3 .backup (skipped with a notice when the host
#       has no sqlite3 — everything else still runs)
#   (d) the cp fallback writes a CONSISTENCY-WARNING marker into the archive, restore warns
#       but continues, and restore --strict refuses
#   (e) the archive min-content check rejects (and deletes) an archive missing a required DB
#
# Usage: ./scripts/smoke-test-backup-restore.sh
# Requires: bash, tar, node (restore.sh path resolution). sqlite3 is optional (see (c)).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP="$REPO_ROOT/scripts/backup.sh"
RESTORE="$REPO_ROOT/scripts/restore.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

HAS_SQLITE3=0
if command -v sqlite3 >/dev/null 2>&1; then
  HAS_SQLITE3=1
fi

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# A fixture database: a real SQLite file with a sentinel row when sqlite3 is available (backup.sh
# uses .backup then, which refuses non-database files), else a plain marker file for the cp path.
make_fixture() {
  if [ "$HAS_SQLITE3" -eq 1 ]; then
    sqlite3 "$1" "CREATE TABLE sentinel(payload TEXT); INSERT INTO sentinel VALUES('$2');"
  else
    printf 'sentinel:%s\n' "$2" >"$1"
  fi
}

# Content fingerprint that works for both fixture kinds above. sqlite3 .backup does NOT guarantee
# a byte-identical copy, so never cmp(1) databases that went through it.
db_fingerprint() {
  if [ "$HAS_SQLITE3" -eq 1 ]; then
    sqlite3 "$1" "SELECT payload FROM sentinel;"
  else
    cat "$1"
  fi
}

# A PATH farm with every tool backup.sh needs. Used to hide sqlite3 (forcing the cp fallback) or
# to shadow tar (simulating an incomplete archive) without touching the real scripts.
populate_shim() {
  shim_dir="$1"
  tools="env bash sh cp tar gzip mktemp date rm sed mkdir ls cat chmod grep printf uname dirname"
  if [ "${2:-}" = "with-sqlite3" ]; then
    tools="$tools sqlite3"
  fi
  for tool in $tools; do
    src="$(command -v "$tool" 2>/dev/null || true)"
    if [ -n "$src" ]; then
      ln -sf "$src" "$shim_dir/$tool"
    fi
  done
}

echo "==> (a) custom MAIN_DATABASE_NAME / DATABASE_NAME are honored"
A="$WORK/a"
mkdir -p "$A/custom" "$A/state" "$A/restore"
make_fixture "$A/custom/auth.sqlite" "alpha-main"
make_fixture "$A/custom/store.sqlite" "alpha-data"
(
  cd "$A"
  MAIN_DATABASE_NAME="$A/custom/auth.sqlite" \
    DATABASE_NAME="$A/custom/store.sqlite" \
    OPENWA_DATA_DIR="$A/state" \
    BACKUP_DIR="$A/out" \
    "$BACKUP" >/dev/null
)
ARCHIVE_A="$(ls "$A"/out/openwa-backup-*.tar.gz)"
if ! tar -tzf "$ARCHIVE_A" | grep -qx './main.sqlite'; then
  fail "(a) archive missing ./main.sqlite"
fi
if ! tar -tzf "$ARCHIVE_A" | grep -qx './openwa.sqlite'; then
  fail "(a) archive missing ./openwa.sqlite"
fi
(
  cd "$A/restore"
  MAIN_DATABASE_NAME="$A/restore/custom-main.sqlite" \
    DATABASE_NAME="$A/restore/custom-data.sqlite" \
    OPENWA_DATA_DIR="$A/restore/state" \
    "$RESTORE" "$ARCHIVE_A" >/dev/null
)
if [ "$(db_fingerprint "$A/restore/custom-main.sqlite")" != "alpha-main" ]; then
  fail "(a) main DB not restored to the MAIN_DATABASE_NAME path"
fi
if [ "$(db_fingerprint "$A/restore/custom-data.sqlite")" != "alpha-data" ]; then
  fail "(a) data DB not restored to the DATABASE_NAME path"
fi
pass "(a) env-resolved DB paths honored by backup.sh and restore.sh"

echo ""
echo "==> (b) missing source database fails hard"
B="$WORK/b"
mkdir -p "$B"
set +e
OUT_B="$(cd "$B" && OPENWA_DATA_DIR="$B/state" BACKUP_DIR="$B/out" "$BACKUP" 2>&1)"
RC_B=$?
set -e
if [ "$RC_B" -eq 0 ]; then
  fail "(b) backup.sh exited 0 with no database present (silent empty backup)"
fi
if ! printf '%s' "$OUT_B" | grep -q 'main.sqlite'; then
  fail "(b) error message does not name the missing main database"
fi
if [ -n "$(ls "$B/out" 2>/dev/null || true)" ]; then
  fail "(b) an archive was written despite the missing database"
fi
# Only the data store missing (default paths) must also fail, naming openwa.sqlite.
B2="$WORK/b2"
mkdir -p "$B2/data"
make_fixture "$B2/data/main.sqlite" "b2-main"
set +e
OUT_B2="$(cd "$B2" && BACKUP_DIR="$B2/out" "$BACKUP" 2>&1)"
RC_B2=$?
set -e
if [ "$RC_B2" -eq 0 ]; then
  fail "(b) backup.sh exited 0 with the data store missing"
fi
if ! printf '%s' "$OUT_B2" | grep -q 'openwa.sqlite'; then
  fail "(b) error message does not name the missing data store"
fi
pass "(b) missing DB -> non-zero exit, clear message, no archive"

echo ""
if [ "$HAS_SQLITE3" -eq 1 ]; then
  echo "==> (c) backup -> restore roundtrip via sqlite3 .backup (default paths)"
  C="$WORK/c"
  mkdir -p "$C/src/data" "$C/dst"
  sqlite3 "$C/src/data/main.sqlite" "CREATE TABLE sentinel(payload TEXT); INSERT INTO sentinel VALUES('c-main');"
  sqlite3 "$C/src/data/openwa.sqlite" "CREATE TABLE sentinel(payload TEXT); INSERT INTO sentinel VALUES('c-data');"
  (
    cd "$C/src"
    BACKUP_DIR="$C/out" "$BACKUP" >/dev/null
  )
  ARCHIVE_C="$(ls "$C"/out/openwa-backup-*.tar.gz)"
  if tar -tzf "$ARCHIVE_C" | grep -q 'CONSISTENCY-WARNING'; then
    fail "(c) unexpected CONSISTENCY-WARNING marker with sqlite3 present"
  fi
  (
    cd "$C/dst"
    "$RESTORE" "$ARCHIVE_C" >/dev/null
  )
  if [ "$(sqlite3 "$C/dst/data/main.sqlite" 'SELECT payload FROM sentinel;')" != "c-main" ]; then
    fail "(c) main DB contents did not survive the roundtrip"
  fi
  if [ "$(sqlite3 "$C/dst/data/openwa.sqlite" 'SELECT payload FROM sentinel;')" != "c-data" ]; then
    fail "(c) data store contents did not survive the roundtrip"
  fi
  pass "(c) .backup roundtrip preserves database contents"
else
  echo "SKIP: (c) sqlite3 not found on this host — skipping the .backup roundtrip"
fi

echo ""
echo "==> (d) cp fallback marker + restore warning + --strict refusal"
D="$WORK/d"
mkdir -p "$D/src/data" "$D/shim" "$D/dst"
# Plain files are fine here: the shim PATH hides sqlite3, so backup.sh takes the cp branch
# regardless of what the host provides.
printf 'd-main\n' >"$D/src/data/main.sqlite"
printf 'd-data\n' >"$D/src/data/openwa.sqlite"
populate_shim "$D/shim"
(
  cd "$D/src"
  PATH="$D/shim" BACKUP_DIR="$D/out" "$BACKUP" >"$D/backup.log" 2>&1
)
ARCHIVE_D="$(ls "$D"/out/openwa-backup-*.tar.gz)"
if ! tar -tzf "$ARCHIVE_D" | grep -q 'CONSISTENCY-WARNING'; then
  fail "(d) fallback archive does not carry the CONSISTENCY-WARNING marker"
fi
if ! grep -q 'sqlite3' "$D/backup.log"; then
  fail "(d) backup.sh did not print the loud fallback warning"
fi
OUT_D="$(cd "$D/dst" && "$RESTORE" "$ARCHIVE_D" 2>&1)"
if ! printf '%s' "$OUT_D" | grep -q 'CONSISTENCY-WARNING'; then
  fail "(d) restore.sh did not surface the consistency warning"
fi
if [ "$(cat "$D/dst/data/main.sqlite")" != "d-main" ]; then
  fail "(d) fallback archive did not restore the main DB"
fi
set +e
OUT_DS="$(cd "$D/dst" && "$RESTORE" "$ARCHIVE_D" --strict 2>&1)"
RC_DS=$?
set -e
if [ "$RC_DS" -eq 0 ]; then
  fail "(d) restore --strict exited 0 on a marked archive"
fi
if ! printf '%s' "$OUT_DS" | grep -q -- '--strict'; then
  fail "(d) --strict refusal message is not explicit"
fi
pass "(d) fallback marker written, restore warns and continues, --strict refuses"

echo ""
echo "==> (e) archive min-content check rejects an incomplete archive"
E="$WORK/e"
mkdir -p "$E/src/data" "$E/shim"
make_fixture "$E/src/data/main.sqlite" "e-main"
make_fixture "$E/src/data/openwa.sqlite" "e-data"
if [ "$HAS_SQLITE3" -eq 1 ]; then
  populate_shim "$E/shim" with-sqlite3
else
  populate_shim "$E/shim"
fi
# Shadow tar: create the archive WITHOUT ./openwa.sqlite to simulate a truncated backup.
# (remove the populate_shim symlink first — writing through it would target the real tar)
rm -f "$E/shim/tar"
REAL_TAR="$(command -v tar)"
cat >"$E/shim/tar" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "-czf" ]; then
  out="\$2"
  shift 2
  exec "$REAL_TAR" -czf "\$out" --exclude='./openwa.sqlite' "\$@"
fi
exec "$REAL_TAR" "\$@"
EOF
chmod +x "$E/shim/tar"
set +e
OUT_E="$(cd "$E/src" && PATH="$E/shim" BACKUP_DIR="$E/out" "$BACKUP" 2>&1)"
RC_E=$?
set -e
if [ "$RC_E" -eq 0 ]; then
  fail "(e) min-content check passed an archive missing openwa.sqlite"
fi
if ! printf '%s' "$OUT_E" | grep -q 'openwa.sqlite'; then
  fail "(e) error message does not name the missing archive member"
fi
if [ -n "$(ls "$E/out" 2>/dev/null || true)" ]; then
  fail "(e) the defective archive was left on disk"
fi
pass "(e) min-content check fails hard and removes the defective archive"

echo ""
echo "==> (f) data/.env.generated supplies paths the environment does not"
# The dangerous shape: the app was pointed elsewhere through the dashboard, and a database from
# before that switch is still sitting at the DEFAULT path. Resolving from the process environment
# alone then archives the abandoned file and exits 0 — a backup that only reveals itself as wrong
# during a restore. A missing default would at least fail loudly; a stale one does not.
F="$WORK/f"
mkdir -p "$F/state" "$F/live" "$F/data" "$F/extract" "$F/restore/state"
make_fixture "$F/live/auth.sqlite" "foxtrot-live-main"
make_fixture "$F/live/store.sqlite" "foxtrot-live-data"
make_fixture "$F/data/main.sqlite" "STALE-main"
make_fixture "$F/data/openwa.sqlite" "STALE-data"
printf 'DATABASE_TYPE=sqlite\nMAIN_DATABASE_NAME=%s\nDATABASE_NAME=%s\n' \
  "$F/live/auth.sqlite" "$F/live/store.sqlite" >"$F/state/.env.generated"
(
  cd "$F"
  OPENWA_DATA_DIR="$F/state" BACKUP_DIR="$F/out" "$BACKUP" >/dev/null
)
ARCHIVE_F="$(ls "$F"/out/openwa-backup-*.tar.gz)"
tar -xzf "$ARCHIVE_F" -C "$F/extract"
if [ "$(db_fingerprint "$F/extract/main.sqlite")" != "foxtrot-live-main" ]; then
  fail "(f) backup archived the stale default main DB instead of the one data/.env.generated names"
fi
if [ "$(db_fingerprint "$F/extract/openwa.sqlite")" != "foxtrot-live-data" ]; then
  fail "(f) backup archived the stale default data DB instead of the one data/.env.generated names"
fi
# restore.sh must read the SAME layer, or it writes the databases somewhere backup.sh never looked.
printf 'DATABASE_TYPE=sqlite\nMAIN_DATABASE_NAME=%s\nDATABASE_NAME=%s\n' \
  "$F/restore/auth.sqlite" "$F/restore/store.sqlite" >"$F/restore/state/.env.generated"
(
  cd "$F/restore"
  OPENWA_DATA_DIR="$F/restore/state" "$RESTORE" "$ARCHIVE_F" >/dev/null
)
if [ "$(db_fingerprint "$F/restore/auth.sqlite")" != "foxtrot-live-main" ]; then
  fail "(f) restore ignored the MAIN_DATABASE_NAME in data/.env.generated"
fi
if [ "$(db_fingerprint "$F/restore/store.sqlite")" != "foxtrot-live-data" ]; then
  fail "(f) restore ignored the DATABASE_NAME in data/.env.generated"
fi
# An explicit environment value must still win — that is the app's precedence, not ours to change.
(
  cd "$F"
  MAIN_DATABASE_NAME="$F/data/main.sqlite" DATABASE_NAME="$F/data/openwa.sqlite" \
    OPENWA_DATA_DIR="$F/state" BACKUP_DIR="$F/out2" "$BACKUP" >/dev/null
)
rm -rf "${F:?}/extract2" && mkdir -p "$F/extract2"
tar -xzf "$(ls "$F"/out2/openwa-backup-*.tar.gz)" -C "$F/extract2"
if [ "$(db_fingerprint "$F/extract2/main.sqlite")" != "STALE-main" ]; then
  fail "(f) an explicit environment path lost to data/.env.generated — precedence is inverted"
fi
pass "(f) data/.env.generated resolves paths for both scripts, and the environment still wins"

echo ""
echo "All smoke tests passed!"
