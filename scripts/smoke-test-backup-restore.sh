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
#   (f) data/.env.generated supplies paths the environment does not, and restore reads the archive's copy
#   (g) PLUGIN_STATE_DIR plugin state is archived and restored at the configured root
#   (h) restore refuses a live target without --force, before touching anything
#   (i) the data-store half of that guard refuses on its own
#   (j) a probe that fails or prints no usable count leaves the target counted as live
#   (k) an operator's sqlite3 rc file changes neither answer of the guard (skipped without sqlite3)
#   (l) an unwritable BACKUP_DIR fails before anything is staged (skipped as root)
#   (m) OPENWA_RESTORE_SNAPSHOT_DIR takes the data-dir snapshot off a read-only parent (skipped as root)
#   (n) a state dir outside the data dir is snapshotted before any database is written, and under
#       OPENWA_RESTORE_SNAPSHOT_DIR when that is set (skipped as root)
#   (o) such a state dir under a read-only parent, a mount point in the container, is restored in
#       place (skipped as root)
#   (p) a symlinked database target or data dir is snapshotted as a copy of what the link points at
#   (q) a leftover -wal is cleared before a database is restored and kept in its snapshot (skipped
#       without sqlite3)
#   (r) a symlinked state dir is archived by content and restored through the link, and an archive
#       member that is itself a symlink is refused
#   (s) restored state lands where the restored data/.env.generated points, below ./.env
#   (t) ./.env lines with CRLF endings, blanks around = or trailing blanks resolve as dotenv reads them
#   (u) a state, database or data-dir file target the restore cannot write stops it before any database
#       is written (skipped as root)
#   (v) a leftover STORAGE_LOCAL_PATH=./uploads the app cannot create falls back to ./data/media in
#       both scripts, and a missing media dir is reported (skipped as root)
#   (w) the default colocated plugins dir is rebuilt from both archive members, even when they differ
#   (x) a relocated BOOTSTRAP_KEY_FILE is archived and restored there, and an unwritable one is refused
#       before any database is written (that half skipped as root)
#   (y) plugin packages in the legacy ./plugins, which the archive does not carry, are reported
#   (z) a leftover ./uploads that was never created, beside an existing ./data/media, resolves there in
#       both scripts whatever the uid
#   (aa) engine auth state copied from a running app (an open whatsapp-web.js profile, Baileys state)
#       is noted in the archive and printed by restore, which does not refuse it even with --strict
#   (ab) a blank ./.env line keeps data/.env.generated from supplying the key, so the default applies
#   (ac) a missing Baileys auth dir is reported when data/.env.generated selects the Baileys engine
#   (ad) a file an engine deletes during the sessions/ or baileys/ copy is noted instead of failing the
#       backup, a file the app deletes during the media or plugin copies is logged, and any other cp
#       error still fails it, however long its output and whatever the host's locale
#   (ae) the min-content check passes an archive whose listing outgrows a pipe buffer
#   (af) the online SQLite backup waits out a writer holding the database lock (skipped without sqlite3)
#   (ag) quoted values, inline comments and `KEY=""` in ./.env resolve as dotenv reads them, a NUL on
#       another line does not hide the key, and a line the scripts cannot parse fails the lookup, so
#       backup and restore stop before archiving or writing anything instead of using a default the app
#       may not read
#   (ah) pg_dump makes the app's TLS check when DATABASE_SSL=true (falling back to the system CA store
#       without node), connects as before when it is not, and never starts past a DATABASE_SSL or
#       DATABASE_SSL_REJECT_UNAUTHORIZED line the scripts cannot parse
#   (ai) the ./data defaults and ./data paths in ./.env and .env.generated follow OPENWA_DATA_DIR in a
#       run on the host, in both scripts, while non-path settings and a ./data path from the environment
#       are read as written
#
# Usage: ./scripts/smoke-test-backup-restore.sh
# Requires: bash, tar, node (restore.sh path resolution). sqlite3 is optional (see (c) and (k)).
set -euo pipefail

# backup.sh and restore.sh take these from the environment before anything else. An exported value
# would aim a case at a real install, and restore replaces the state directories wholesale, so every
# case starts from none of them and sets exactly the paths it uses.
unset OPENWA_DATA_DIR BACKUP_DIR DATABASE_TYPE MAIN_DATABASE_NAME DATABASE_NAME SESSION_DATA_PATH \
  BAILEYS_AUTH_DIR STORAGE_LOCAL_PATH PLUGINS_DIR PLUGIN_STATE_DIR OPENWA_RESTORE_SNAPSHOT_DIR BOOTSTRAP_KEY_FILE \
  ENGINE_TYPE DATABASE_URL DATABASE_HOST DATABASE_PORT DATABASE_USERNAME DATABASE_PASSWORD \
  DATABASE_SSL DATABASE_SSL_REJECT_UNAUTHORIZED PGSSLMODE PGSSLROOTCERT

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
    sed 's/^sentinel://' "$1"
  fi
}

# A PATH farm with every tool backup.sh needs. Used to hide sqlite3 (forcing the cp fallback) or
# to shadow tar (simulating an incomplete archive) without touching the real scripts.
populate_shim() {
  shim_dir="$1"
  tools="env bash sh cp tar gzip mktemp date rm sed mkdir ls cat chmod grep printf uname dirname tr tail"
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
# restore.sh must read the same layer, from the file in effect AFTER the restore: the archive's
# .env.generated replaces the target's, so databases placed where the target's old file pointed
# would be ones the restored app never opens. Here the live databases are gone, as in a disaster
# recovery, and the target's own file still names other paths.
rm -f "$F/live/auth.sqlite" "$F/live/store.sqlite"
printf 'DATABASE_TYPE=sqlite\nMAIN_DATABASE_NAME=%s\nDATABASE_NAME=%s\n' \
  "$F/restore/auth.sqlite" "$F/restore/store.sqlite" >"$F/restore/state/.env.generated"
(
  cd "$F/restore"
  OPENWA_DATA_DIR="$F/restore/state" "$RESTORE" "$ARCHIVE_F" >/dev/null
)
if [ "$(db_fingerprint "$F/live/auth.sqlite")" != "foxtrot-live-main" ]; then
  fail "(f) restore ignored the MAIN_DATABASE_NAME in the archive's data/.env.generated"
fi
if [ "$(db_fingerprint "$F/live/store.sqlite")" != "foxtrot-live-data" ]; then
  fail "(f) restore ignored the DATABASE_NAME in the archive's data/.env.generated"
fi
if [ -e "$F/restore/auth.sqlite" ] || [ -e "$F/restore/store.sqlite" ]; then
  fail "(f) restore wrote the databases where the replaced data/.env.generated pointed"
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
echo "==> (g) PLUGIN_STATE_DIR moves the registry and ctx.storage, and both scripts follow it"
# The knob names the ROOT; the app keeps plugin state at <root>/plugins. Both scripts hardcoded
# $OPENWA_DATA_DIR/plugins, so with the knob set the archive carried neither the registry nor any
# plugin's persisted storage, and the restore put nothing back. Silent both ways: an empty source
# directory simply produces no plugin-state entry.
G="$WORK/g"
mkdir -p "$G/state" "$G/elsewhere/plugins/chatwoot" "$G/extract" "$G/restore/state"
make_fixture "$G/state/main.sqlite" "golf-main"
make_fixture "$G/state/openwa.sqlite" "golf-data"
printf '{"plugins":[{"id":"chatwoot"}]}' >"$G/elsewhere/plugins/registry.json"
printf 'mapped-conversation' >"$G/elsewhere/plugins/chatwoot/key-Zm9v.json"
(
  cd "$G"
  OPENWA_DATA_DIR="$G/state" PLUGIN_STATE_DIR="$G/elsewhere" BACKUP_DIR="$G/out" \
    MAIN_DATABASE_NAME="$G/state/main.sqlite" DATABASE_NAME="$G/state/openwa.sqlite" "$BACKUP" >/dev/null
)
ARCHIVE_G="$(ls "$G"/out/openwa-backup-*.tar.gz)"
tar -xzf "$ARCHIVE_G" -C "$G/extract"
if [ ! -f "$G/extract/plugin-state/registry.json" ]; then
  fail "(g) backup ignored PLUGIN_STATE_DIR: the plugin registry is missing from the archive"
fi
if [ ! -f "$G/extract/plugin-state/chatwoot/key-Zm9v.json" ]; then
  fail "(g) backup ignored PLUGIN_STATE_DIR: a plugin's persisted ctx.storage is missing"
fi
# And the restore has to put them back where the knob points, not under the default data dir.
(
  cd "$G"
  OPENWA_DATA_DIR="$G/restore/state" PLUGIN_STATE_DIR="$G/restored-elsewhere" \
    MAIN_DATABASE_NAME="$G/restore/state/main.sqlite" DATABASE_NAME="$G/restore/state/openwa.sqlite" \
    "$RESTORE" "$ARCHIVE_G" --force >/dev/null
)
if [ ! -f "$G/restored-elsewhere/plugins/registry.json" ]; then
  fail "(g) restore ignored PLUGIN_STATE_DIR: the registry did not land under the configured root"
fi
pass "(g) PLUGIN_STATE_DIR is honoured by backup and by restore"

echo ""
echo "==> (h) restore refuses a live target without --force, before touching anything"
# The data-loss guard: both target databases hold a working install's data, so a plain restore
# must refuse (non-zero, clear message) before ANY state changes, and --force must be the exact
# switch that changes the answer.
H="$WORK/h"
mkdir -p "$H/src/data" "$H/live" "$H/out"
make_fixture "$H/src/data/main.sqlite" "hotel-archive-main"
make_fixture "$H/src/data/openwa.sqlite" "hotel-archive-data"
(
  cd "$H/src"
  BACKUP_DIR="$H/out" "$BACKUP" >/dev/null
)
ARCHIVE_H="$(ls "$H"/out/openwa-backup-*.tar.gz)"
make_fixture "$H/live/main.sqlite" "hotel-live-main"
make_fixture "$H/live/openwa.sqlite" "hotel-live-data"
set +e
OUT_H="$(cd "$H" && MAIN_DATABASE_NAME="$H/live/main.sqlite" \
  DATABASE_NAME="$H/live/openwa.sqlite" OPENWA_DATA_DIR="$H/live" \
  "$RESTORE" "$ARCHIVE_H" 2>&1)"
RC_H=$?
set -e
if [ "$RC_H" -eq 0 ]; then
  fail "(h) restore exited 0 on a live target without --force"
fi
# ASCII anchors only: the second refusal line carries a UTF-8 dash that must not be grep'd.
if ! printf '%s' "$OUT_H" | grep -q 'appear live'; then
  fail "(h) refusal message does not say the target appears live"
fi
if ! printf '%s' "$OUT_H" | grep -q -- '--force'; then
  fail "(h) refusal message does not point at --force"
fi
if ! printf '%s' "$OUT_H" | grep -qF "$H/live/main.sqlite"; then
  fail "(h) refusal message does not name the live target"
fi
if [ "$(db_fingerprint "$H/live/main.sqlite")" != "hotel-live-main" ]; then
  fail "(h) the refused restore modified the live main DB"
fi
if [ "$(db_fingerprint "$H/live/openwa.sqlite")" != "hotel-live-data" ]; then
  fail "(h) the refused restore modified the live data DB"
fi
# $H/live is non-empty, so an execution that reached the safety-snapshot step would have left a
# $H/live.pre-restore-* sibling; its absence proves the guard fired before any state was touched.
if [ -n "$(ls -d "$H"/live.pre-restore-* 2>/dev/null || true)" ]; then
  fail "(h) the refused restore left a pre-restore snapshot behind"
fi
(
  cd "$H"
  MAIN_DATABASE_NAME="$H/live/main.sqlite" DATABASE_NAME="$H/live/openwa.sqlite" \
    OPENWA_DATA_DIR="$H/live" "$RESTORE" "$ARCHIVE_H" --force >/dev/null
)
if [ "$(db_fingerprint "$H/live/main.sqlite")" != "hotel-archive-main" ]; then
  fail "(h) --force did not overwrite the live main DB after the refusal"
fi
if [ "$(db_fingerprint "$H/live/openwa.sqlite")" != "hotel-archive-data" ]; then
  fail "(h) --force did not overwrite the live data DB after the refusal"
fi
pass "(h) live target refused before any state was touched; --force overwrites"

echo ""
echo "==> (i) the data-store half of the guard refuses on its own"
# (h) makes both databases live, so its main-DB check alone satisfies every assertion there. Here the
# data store is the only database present.
I="$WORK/i"
mkdir -p "$I/bin" "$I/live"
make_fixture "$I/live/openwa.sqlite" "india-live-data"

# guarded_restore <target dir>: restore ARCHIVE_H without --force over <dir>/main.sqlite and
# <dir>/openwa.sqlite, with $I/bin first on PATH. Output lands in OUT, the exit code in RC.
guarded_restore() {
  set +e
  OUT="$(cd "$WORK" && PATH="$I/bin:$PATH" MAIN_DATABASE_NAME="$1/main.sqlite" \
    DATABASE_NAME="$1/openwa.sqlite" OPENWA_DATA_DIR="$1" "$RESTORE" "$ARCHIVE_H" 2>&1)"
  RC=$?
  set -e
}

# expect_refused <label>: a restore over $I/live must refuse, name its data store, and leave it intact.
expect_refused() {
  guarded_restore "$I/live"
  if [ "$RC" -eq 0 ]; then
    fail "($1) restore exited 0 over a live data store without --force"
  fi
  if ! printf '%s' "$OUT" | grep -qF "$I/live/openwa.sqlite"; then
    fail "($1) refusal message does not name the live data store"
  fi
  if [ "$(db_fingerprint "$I/live/openwa.sqlite")" != "india-live-data" ]; then
    fail "($1) the refused restore modified the live data store"
  fi
}

expect_refused i
pass "(i) a live data store is refused with the main DB target absent"

echo ""
echo "==> (j) a probe that fails or prints no usable count leaves the target counted as live"
# A locked, corrupt or unreadable database makes sqlite3 exit non-zero, and output that is not a bare
# count did not answer the question. Neither may be read as an empty database.
for probe in 'exit 26' 'exit 0' 'printf "count(*)\n1\n"'; do
  printf '#!/usr/bin/env bash\n%s\n' "$probe" >"$I/bin/sqlite3"
  chmod +x "$I/bin/sqlite3"
  expect_refused "j: $probe"
done
rm -f "$I/bin/sqlite3"
pass "(j) a failed, empty or non-numeric probe refuses"

echo ""
if [ "$HAS_SQLITE3" -eq 1 ]; then
  echo "==> (k) an operator's sqlite3 rc file changes neither answer of the guard"
  # sqlite3 applies the user's rc file to a one-shot query too, and headers or csv mode turn the count
  # into text. It finds that file through the passwd entry, not $HOME, so a test cannot plant one by
  # moving HOME. The wrapper loads one with -init instead; an explicit -init later on the command line
  # replaces it, exactly as it replaces ~/.sqliterc.
  printf '.headers on\n.mode csv\n' >"$I/sqliterc"
  printf '#!/usr/bin/env bash\nexec %q -init %q "$@"\n' "$(command -v sqlite3)" "$I/sqliterc" >"$I/bin/sqlite3"
  chmod +x "$I/bin/sqlite3"
  expect_refused k
  # And a database with no tables yet is still safe to restore over without --force.
  mkdir -p "$I/fresh"
  : >"$I/fresh/openwa.sqlite"
  guarded_restore "$I/fresh"
  if [ "$RC" -ne 0 ]; then
    fail "(k) the rc file made a database with no tables look live"
  fi
  pass "(k) with an rc file, a live target is still refused and an empty one still restores"
else
  echo "SKIP: (k) sqlite3 not found on this host, so there is no rc file to load"
fi

echo ""
echo "==> (l) an unwritable BACKUP_DIR fails before anything is staged"
# The shipped container mounts its root read-only, so the default ./backups cannot be created. The
# run must stop up front, not after copying every database and media file into /tmp.
if [ "$(id -u)" -ne 0 ]; then
  L="$WORK/l"
  mkdir -p "$L/data" "$L/ro"
  make_fixture "$L/data/main.sqlite" "l-main"
  make_fixture "$L/data/openwa.sqlite" "l-data"
  chmod a-w "$L/ro"
  set +e
  OUT_L="$(cd "$L" && BACKUP_DIR="$L/ro/out" "$BACKUP" 2>&1)"
  RC_L=$?
  set -e
  chmod u+w "$L/ro"
  if [ "$RC_L" -eq 0 ]; then
    fail "(l) backup.sh exited 0 with an unwritable BACKUP_DIR"
  fi
  if ! printf '%s' "$OUT_L" | grep -q 'BACKUP_DIR=.* is not writable'; then
    fail "(l) error message does not name the unwritable BACKUP_DIR"
  fi
  if printf '%s' "$OUT_L" | grep -q 'Backing up'; then
    fail "(l) state was staged before the BACKUP_DIR check"
  fi
  pass "(l) unwritable BACKUP_DIR -> non-zero exit before staging, clear message"
else
  echo "SKIP: (l) running as root, which ignores the permission bits this case relies on"
fi

echo ""
echo "==> (m) OPENWA_RESTORE_SNAPSHOT_DIR takes the data-dir snapshot off a read-only parent"
# The shipped compose file and Helm chart mount the data dir as a volume under a read-only root, so
# the snapshot's default place next to it cannot be written and the restore stopped there.
if [ "$(id -u)" -ne 0 ]; then
  M="$WORK/m"
  mkdir -p "$M/root/data" "$M/snapshots"
  printf 'mike-before\n' >"$M/root/data/.api-key"
  chmod a-w "$M/root"
  set +e
  OUT_M="$(cd "$M" && MAIN_DATABASE_NAME="$M/root/data/main.sqlite" DATABASE_NAME="$M/root/data/openwa.sqlite" \
    OPENWA_DATA_DIR="$M/root/data" OPENWA_RESTORE_SNAPSHOT_DIR="$M/snapshots" "$RESTORE" "$ARCHIVE_H" 2>&1)"
  RC_M=$?
  set -e
  chmod u+w "$M/root"
  if [ "$RC_M" -ne 0 ]; then
    fail "(m) restore failed with a writable OPENWA_RESTORE_SNAPSHOT_DIR: $OUT_M"
  fi
  if [ "$(cat "$M"/snapshots/data.pre-restore-*/.api-key 2>/dev/null || true)" != "mike-before" ]; then
    fail "(m) the data-dir snapshot is not under OPENWA_RESTORE_SNAPSHOT_DIR"
  fi
  if [ "$(db_fingerprint "$M/root/data/main.sqlite")" != "hotel-archive-main" ]; then
    fail "(m) the restore did not put the archived main DB in place"
  fi
  pass "(m) data-dir snapshot written under OPENWA_RESTORE_SNAPSHOT_DIR, restore completes"
else
  echo "SKIP: (m) running as root, which ignores the permission bits this case relies on"
fi

echo ""
echo "==> (n) a state dir outside the data dir is snapshotted before any database is written"
# SESSION_DATA_PATH on its own mount has a parent of its own. When that parent is read-only, the
# snapshot of the directory cannot go next to it, and a restore that finds out only after writing
# the databases leaves them from the archive and the sessions from the live install.
if [ "$(id -u)" -ne 0 ]; then
  N="$WORK/n"
  mkdir -p "$N/src/data/sessions/session-s1" "$N/live" "$N/ro/sessions/session-s1" "$N/ext/sessions/session-s1"
  make_fixture "$N/src/data/main.sqlite" "november-archive-main"
  make_fixture "$N/src/data/openwa.sqlite" "november-archive-data"
  printf 'november-archive\n' >"$N/src/data/sessions/session-s1/marker"
  (
    cd "$N/src"
    BACKUP_DIR="$N/out" "$BACKUP" >/dev/null
  )
  ARCHIVE_N="$(ls "$N"/out/openwa-backup-*.tar.gz)"
  make_fixture "$N/live/main.sqlite" "november-live-main"
  make_fixture "$N/live/openwa.sqlite" "november-live-data"
  printf 'november-live\n' >"$N/ro/sessions/session-s1/marker"
  printf 'november-live\n' >"$N/ext/sessions/session-s1/marker"

  # restore_n <sessions dir> [snapshot dir]: a forced restore of ARCHIVE_N over $N/live. Output lands
  # in OUT, the exit code in RC.
  restore_n() {
    set +e
    OUT="$(cd "$N" && MAIN_DATABASE_NAME="$N/live/main.sqlite" DATABASE_NAME="$N/live/openwa.sqlite" \
      OPENWA_DATA_DIR="$N/live" SESSION_DATA_PATH="$1" OPENWA_RESTORE_SNAPSHOT_DIR="${2:-}" \
      "$RESTORE" "$ARCHIVE_N" --force 2>&1)"
    RC=$?
    set -e
  }

  chmod a-w "$N/ro"
  restore_n "$N/ro/sessions"
  chmod u+w "$N/ro"
  if [ "$RC" -eq 0 ]; then
    fail "(n) restore exited 0 although the sessions snapshot could not be written"
  fi
  if [ "$(db_fingerprint "$N/live/main.sqlite")" != "november-live-main" ]; then
    fail "(n) the main DB was overwritten before the sessions snapshot failed"
  fi
  if [ "$(cat "$N/ro/sessions/session-s1/marker")" != "november-live" ]; then
    fail "(n) the failed restore changed the live sessions"
  fi

  restore_n "$N/ext/sessions" "$N/snapshots"
  if [ "$RC" -ne 0 ]; then
    fail "(n) restore with an external SESSION_DATA_PATH failed: $OUT"
  fi
  if [ "$(cat "$N"/snapshots/sessions.pre-restore-*/session-s1/marker 2>/dev/null || true)" != "november-live" ]; then
    fail "(n) the sessions snapshot is not under OPENWA_RESTORE_SNAPSHOT_DIR"
  fi
  if [ -n "$(ls -d "$N"/ext/sessions.pre-restore-* 2>/dev/null || true)" ]; then
    fail "(n) the sessions snapshot was written next to the target despite OPENWA_RESTORE_SNAPSHOT_DIR"
  fi
  if [ "$(cat "$N/ext/sessions/session-s1/marker")" != "november-archive" ]; then
    fail "(n) the archived sessions were not restored"
  fi
  pass "(n) external state snapshotted before the databases are written, under OPENWA_RESTORE_SNAPSHOT_DIR"

  echo ""
  echo "==> (o) a state dir whose parent is read-only is restored in place"
  # A volume mounted at /sessions can be emptied but not removed or re-created: its parent is the
  # read-only root. The unwritable parent stands in for that here.
  printf 'oscar-stale\n' >"$N/ro/sessions/stale"
  chmod a-w "$N/ro"
  restore_n "$N/ro/sessions" "$N/snapshots-o"
  chmod u+w "$N/ro"
  if [ "$RC" -ne 0 ]; then
    fail "(o) restore into a state dir under a read-only parent failed: $OUT"
  fi
  if [ "$(cat "$N/ro/sessions/session-s1/marker")" != "november-archive" ]; then
    fail "(o) the archived sessions were not restored into the directory"
  fi
  if [ -e "$N/ro/sessions/stale" ]; then
    fail "(o) a file the archive does not carry survived the restore"
  fi
  if [ "$(cat "$N"/snapshots-o/sessions.pre-restore-*/session-s1/marker 2>/dev/null || true)" != "november-live" ]; then
    fail "(o) the sessions snapshot is not under OPENWA_RESTORE_SNAPSHOT_DIR"
  fi
  pass "(o) a state dir under a read-only parent is emptied and refilled in place"
else
  echo "SKIP: (n) and (o) running as root, which ignores the permission bits these cases rely on"
fi

echo ""
echo "==> (p) a symlinked database target or data dir is snapshotted as a copy"
# cp -R copies a symlink as the link itself, and the restore then writes through that link, which
# would leave a snapshot showing the archive instead of the state it replaced.
P="$WORK/p"
mkdir -p "$P/src/data" "$P/real/data"
make_fixture "$P/src/data/main.sqlite" "papa-archive-main"
make_fixture "$P/src/data/openwa.sqlite" "papa-archive-data"
(
  cd "$P/src"
  BACKUP_DIR="$P/out" "$BACKUP" >/dev/null
)
ARCHIVE_P="$(ls "$P"/out/openwa-backup-*.tar.gz)"
make_fixture "$P/real/main.sqlite" "papa-live-main"
make_fixture "$P/real/data/openwa.sqlite" "papa-live-data"
ln -s "$P/real/main.sqlite" "$P/ext-main.sqlite"
ln -s "$P/real/data" "$P/live"
(
  cd "$P"
  MAIN_DATABASE_NAME="$P/ext-main.sqlite" DATABASE_NAME="$P/live/openwa.sqlite" OPENWA_DATA_DIR="$P/live" \
    "$RESTORE" "$ARCHIVE_P" --force >/dev/null
)
SNAPSHOT_P="$(ls -d "$P"/ext-main.sqlite.pre-restore-*)"
if [ -L "$SNAPSHOT_P" ]; then
  fail "(p) the snapshot of a symlinked database is a link to the file the restore overwrote"
fi
if [ "$(db_fingerprint "$SNAPSHOT_P")" != "papa-live-main" ]; then
  fail "(p) the snapshot does not hold the database the restore replaced"
fi
SNAPSHOT_P="$(ls -d "$P"/live.pre-restore-*)"
if [ -L "$SNAPSHOT_P" ]; then
  fail "(p) the snapshot of a symlinked data dir is a link to the directory the restore overwrote"
fi
if [ "$(db_fingerprint "$SNAPSHOT_P/openwa.sqlite")" != "papa-live-data" ]; then
  fail "(p) the data-dir snapshot does not hold the data store the restore replaced"
fi
if [ "$(db_fingerprint "$P/ext-main.sqlite")" != "papa-archive-main" ]; then
  fail "(p) the archived main DB was not restored"
fi
if [ "$(db_fingerprint "$P/live/openwa.sqlite")" != "papa-archive-data" ]; then
  fail "(p) the archived data store was not restored"
fi
pass "(p) a symlinked database target and data dir are snapshotted as copies"

echo ""
if [ "$HAS_SQLITE3" -eq 1 ]; then
  echo "==> (q) a leftover -wal is neither replayed over the restored database nor lost from the snapshot"
  # An unclean stop of a WAL-mode database leaves committed transactions in <db>-wal. SQLite replays
  # that file over whatever main file sits next to it at the next open, so a restore that copies only
  # the main file reads back the old install's rows, and a snapshot without it misses those rows.
  Q="$WORK/q"
  mkdir -p "$Q/src/data" "$Q/live" "$Q/ext"
  make_fixture "$Q/src/data/main.sqlite" "quebec-archive-main"
  make_fixture "$Q/src/data/openwa.sqlite" "quebec-archive-data"
  (
    cd "$Q/src"
    BACKUP_DIR="$Q/out" "$BACKUP" >/dev/null
  )
  ARCHIVE_Q="$(ls "$Q"/out/openwa-backup-*.tar.gz)"
  # wal_fixture <db> <payload>: a WAL-mode database whose main file still says 'stale' and whose
  # un-checkpointed -wal, as an unclean stop leaves it, says <payload>.
  wal_fixture() {
    sqlite3 "$1" "PRAGMA journal_mode=WAL; CREATE TABLE sentinel(payload TEXT); INSERT INTO sentinel VALUES('stale');" >/dev/null
    cp "$1" "$1.base"
    sqlite3 "$1" "PRAGMA wal_autocheckpoint=0; UPDATE sentinel SET payload='$2';" ".system cp '$1-wal' '$1.wal'" >/dev/null
    mv "$1.base" "$1"
    mv "$1.wal" "$1-wal"
  }
  wal_fixture "$Q/live/main.sqlite" "quebec-live-main"
  wal_fixture "$Q/ext/openwa.sqlite" "quebec-live-data"
  (
    cd "$Q"
    MAIN_DATABASE_NAME="$Q/live/main.sqlite" DATABASE_NAME="$Q/ext/openwa.sqlite" OPENWA_DATA_DIR="$Q/live" \
      "$RESTORE" "$ARCHIVE_Q" --force >/dev/null
  )
  if [ "$(db_fingerprint "$Q/live/main.sqlite")" != "quebec-archive-main" ]; then
    fail "(q) the old install's -wal was replayed over the restored main DB"
  fi
  if [ "$(db_fingerprint "$Q/ext/openwa.sqlite")" != "quebec-archive-data" ]; then
    fail "(q) the old install's -wal was replayed over the restored data store"
  fi
  # The snapshot name ends in the timestamp; its sidecars end in -wal and -shm.
  if [ "$(db_fingerprint "$(ls -d "$Q"/ext/openwa.sqlite.pre-restore-*[0-9])")" != "quebec-live-data" ]; then
    fail "(q) the snapshot of a database outside the data dir lost the transactions in its -wal"
  fi
  pass "(q) stale -wal files are cleared before the copy and kept in the snapshot"
else
  echo "SKIP: (q) sqlite3 not found on this host, so there is no WAL-mode database to build"
fi

echo ""
echo "==> (r) a symlinked state dir is archived by content and refilled in place"
# An operator who keeps media on another disk links ./data/media there. cp -R archived the link and
# not the files, and the restore replaced the link with a real directory on the data disk, leaving
# the linked disk with the old files.
R="$WORK/r"
mkdir -p "$R/src/data" "$R/src-disk/media" "$R/live" "$R/disk/media"
make_fixture "$R/src/data/main.sqlite" "romeo-archive-main"
make_fixture "$R/src/data/openwa.sqlite" "romeo-archive-data"
printf 'romeo-archive\n' >"$R/src-disk/media/a.jpg"
ln -s "$R/src-disk/media" "$R/src/data/media"
(
  cd "$R/src"
  BACKUP_DIR="$R/out" "$BACKUP" >/dev/null
)
ARCHIVE_R="$(ls "$R"/out/openwa-backup-*.tar.gz)"
if ! tar -tzf "$ARCHIVE_R" | grep -qx './media/a.jpg'; then
  fail "(r) backup archived the symlinked media dir as a link instead of its files"
fi
printf 'romeo-live\n' >"$R/disk/media/m0"
ln -s "$R/disk/media" "$R/live/media"
# restore_r <archive>: a forced restore over $R/live. Output lands in OUT, the exit code in RC.
restore_r() {
  set +e
  OUT="$(cd "$R" && MAIN_DATABASE_NAME="$R/live/main.sqlite" DATABASE_NAME="$R/live/openwa.sqlite" \
    OPENWA_DATA_DIR="$R/live" "$RESTORE" "$1" --force 2>&1)"
  RC=$?
  set -e
}
restore_r "$ARCHIVE_R"
if [ "$RC" -ne 0 ]; then
  fail "(r) restore over a symlinked media dir failed: $OUT"
fi
if [ ! -L "$R/live/media" ]; then
  fail "(r) the restore replaced the symlinked media dir with a real directory"
fi
if [ "$(cat "$R/disk/media/a.jpg" 2>/dev/null || true)" != "romeo-archive" ] || [ -e "$R/disk/media/m0" ]; then
  fail "(r) the directory the link points at was not refilled with the archived media"
fi
if [ "$(cat "$R"/live/media.pre-restore-*/m0 2>/dev/null || true)" != "romeo-live" ]; then
  fail "(r) the snapshot does not hold the media the restore replaced"
fi
# An archive written before backup.sh followed such links carries the link itself, which on this host
# may point at the very directory being emptied. It is refused before anything is touched.
mkdir -p "$R/linked"
tar -xzf "$ARCHIVE_R" -C "$R/linked"
rm -rf "${R:?}/linked/media"
ln -s "$R/disk/media" "$R/linked/media"
tar -czf "$R/linked.tar.gz" -C "$R/linked" .
rm -f "$R/live/main.sqlite"
make_fixture "$R/live/main.sqlite" "romeo-live-main"
restore_r "$R/linked.tar.gz"
if [ "$RC" -eq 0 ]; then
  fail "(r) restore accepted an archive whose media member is a symlink"
fi
if ! printf '%s' "$OUT" | grep -q 'symlink'; then
  fail "(r) the refusal does not say the archive member is a symlink"
fi
if [ "$(db_fingerprint "$R/live/main.sqlite")" != "romeo-live-main" ] || [ ! -f "$R/disk/media/a.jpg" ]; then
  fail "(r) the refused restore changed the install"
fi
pass "(r) a symlinked media dir is archived by content, refilled through the link, and a linked member is refused"

echo ""
echo "==> (s) state lands where the restored data/.env.generated points"
# Dashboard > Infrastructure writes SESSION_DATA_PATH and STORAGE_LOCAL_PATH to data/.env.generated.
# The restore installs the archive's copy of that file, so the state has to go where it points, not
# to the defaults a fresh target would otherwise resolve.
S="$WORK/s"
mkdir -p "$S/src/data/custom-sessions/session-s1" "$S/src/data/custom-media" "$S/dst" "$S/dst-env"
make_fixture "$S/src/data/main.sqlite" "sierra-main"
make_fixture "$S/src/data/openwa.sqlite" "sierra-data"
printf 'sierra-session\n' >"$S/src/data/custom-sessions/session-s1/marker"
printf 'sierra-media\n' >"$S/src/data/custom-media/a.jpg"
printf 'SESSION_DATA_PATH=./data/custom-sessions\nSTORAGE_LOCAL_PATH=./data/custom-media\n' >"$S/src/data/.env.generated"
(
  cd "$S/src"
  BACKUP_DIR="$S/out" "$BACKUP" >/dev/null
)
ARCHIVE_S="$(ls "$S"/out/openwa-backup-*.tar.gz)"
(
  cd "$S/dst"
  "$RESTORE" "$ARCHIVE_S" >/dev/null
)
if [ "$(cat "$S/dst/data/custom-sessions/session-s1/marker" 2>/dev/null || true)" != "sierra-session" ]; then
  fail "(s) the sessions did not land at the SESSION_DATA_PATH the restored data/.env.generated names"
fi
if [ "$(cat "$S/dst/data/custom-media/a.jpg" 2>/dev/null || true)" != "sierra-media" ]; then
  fail "(s) the media did not land at the STORAGE_LOCAL_PATH the restored data/.env.generated names"
fi
if [ -e "$S/dst/data/sessions" ] || [ -e "$S/dst/data/media" ]; then
  fail "(s) state was restored to the default paths as well"
fi
# ./.env still wins over the restored file, as it does in the app.
printf 'SESSION_DATA_PATH=./data/env-sessions\n' >"$S/dst-env/.env"
(
  cd "$S/dst-env"
  "$RESTORE" "$ARCHIVE_S" >/dev/null
)
if [ "$(cat "$S/dst-env/data/env-sessions/session-s1/marker" 2>/dev/null || true)" != "sierra-session" ]; then
  fail "(s) a SESSION_DATA_PATH in ./.env lost to the restored data/.env.generated"
fi
pass "(s) restored state follows the restored data/.env.generated, and ./.env still wins"

echo ""
echo "==> (t) ./.env lines with CRLF endings, spaces around = or trailing blanks read as the app reads them"
# The app loads ./.env with dotenv, which drops a CR, trims the value and accepts `KEY = value`. The
# scripts kept the CR and the blanks in the path and skipped the spaced line without a word, so a
# backup fell back to a stale default and a restore wrote `custom.sqlite<CR>` beside the database the
# app opens, past a live-target guard that probed the wrong name.
T="$WORK/t"
mkdir -p "$T/src/data/sess/session-s1" "$T/src/live" "$T/dst/data"
make_fixture "$T/src/live/auth.sqlite" "tango-main"
make_fixture "$T/src/live/store.sqlite" "tango-data"
make_fixture "$T/src/data/main.sqlite" "STALE-main"
make_fixture "$T/src/data/openwa.sqlite" "STALE-data"
printf 'tango-session\n' >"$T/src/data/sess/session-s1/marker"
printf 'MAIN_DATABASE_NAME = %s\r\nDATABASE_NAME=%s\r\nSESSION_DATA_PATH=./data/sess  \r\n' \
  "$T/src/live/auth.sqlite" "$T/src/live/store.sqlite" >"$T/src/.env"
set +e
OUT_T="$(cd "$T/src" && BACKUP_DIR="$T/out" "$BACKUP" 2>&1)"
RC_T=$?
set -e
if [ "$RC_T" -ne 0 ]; then
  fail "(t) backup failed on a CRLF ./.env: $OUT_T"
fi
mkdir -p "$T/extract"
tar -xzf "$(ls "$T"/out/openwa-backup-*.tar.gz)" -C "$T/extract"
if [ "$(db_fingerprint "$T/extract/main.sqlite")" != "tango-main" ]; then
  fail "(t) a \`MAIN_DATABASE_NAME = path\` line in ./.env was skipped and the stale default archived"
fi
if [ "$(db_fingerprint "$T/extract/openwa.sqlite")" != "tango-data" ]; then
  fail "(t) a CRLF DATABASE_NAME line in ./.env did not resolve to the database it names"
fi
if [ "$(cat "$T/extract/sessions/session-s1/marker" 2>/dev/null || true)" != "tango-session" ]; then
  fail "(t) a SESSION_DATA_PATH with trailing blanks did not resolve to the sessions dir"
fi
printf 'DATABASE_NAME=./data/custom.sqlite\r\nMAIN_DATABASE_NAME = ./data/custom-main.sqlite  \r\n' >"$T/dst/.env"
make_fixture "$T/dst/data/custom.sqlite" "tango-live"
set +e
OUT_T="$(cd "$T/dst" && "$RESTORE" "$(ls "$T"/out/openwa-backup-*.tar.gz)" 2>&1)"
RC_T=$?
set -e
if [ "$RC_T" -eq 0 ]; then
  fail "(t) restore without --force wrote past the live database a CRLF DATABASE_NAME names"
fi
(
  cd "$T/dst"
  "$RESTORE" "$(ls "$T"/out/openwa-backup-*.tar.gz)" --force >/dev/null
)
if [ "$(db_fingerprint "$T/dst/data/custom.sqlite")" != "tango-data" ]; then
  fail "(t) restore did not write the data store to the path the CRLF line names"
fi
if [ "$(db_fingerprint "$T/dst/data/custom-main.sqlite")" != "tango-main" ]; then
  fail "(t) restore did not write the main DB to the path the spaced line names"
fi
if [ -n "$(find "$T/dst/data" -name "*$(printf '\r')*" 2>/dev/null)" ]; then
  fail "(t) restore created a file whose name ends in a carriage return"
fi
pass "(t) CRLF, spaced and blank-padded ./.env lines resolve like dotenv"

echo ""
echo "==> (u) a target the restore cannot write stops it before any database is written"
# The snapshot pass skipped a target that did not exist yet and never asked whether one could be
# written, so the databases were replaced first and the run died on the state directory after them,
# leaving the archive's databases beside the old sessions, media and configuration.
if [ "$(id -u)" -ne 0 ]; then
  U="$WORK/u"
  mkdir -p "$U/src/data/sessions/session-s1" "$U/live" "$U/ro" "$U/busy/sessions/session-s1"
  make_fixture "$U/src/data/main.sqlite" "uniform-archive-main"
  make_fixture "$U/src/data/openwa.sqlite" "uniform-archive-data"
  printf 'uniform-archive\n' >"$U/src/data/sessions/session-s1/marker"
  (
    cd "$U/src"
    BACKUP_DIR="$U/out" "$BACKUP" >/dev/null
  )
  ARCHIVE_U="$(ls "$U"/out/openwa-backup-*.tar.gz)"
  make_fixture "$U/live/main.sqlite" "uniform-live-main"
  printf 'uniform-live\n' >"$U/busy/sessions/session-s1/marker"

  # restore_u <sessions dir> <data-store path>: a forced restore of ARCHIVE_U over $U/live. Output
  # lands in OUT, the exit code in RC.
  restore_u() {
    set +e
    OUT="$(cd "$U" && MAIN_DATABASE_NAME="$U/live/main.sqlite" DATABASE_NAME="$2" OPENWA_DATA_DIR="$U/live" \
      SESSION_DATA_PATH="$1" OPENWA_RESTORE_SNAPSHOT_DIR="$U/snapshots" "$RESTORE" "$ARCHIVE_U" --force 2>&1)"
    RC=$?
    set -e
  }
  # expect_untouched <label>: the refused restore must fail, say why, and leave the main DB alone.
  expect_untouched() {
    if [ "$RC" -eq 0 ]; then
      fail "(u) restore exited 0 with an unwritable $1 target"
    fi
    if ! printf '%s' "$OUT" | grep -q 'cannot write'; then
      fail "(u) the refusal for an unwritable $1 target does not say so: $OUT"
    fi
    if [ "$(db_fingerprint "$U/live/main.sqlite")" != "uniform-live-main" ]; then
      fail "(u) the main DB was overwritten before the unwritable $1 target stopped the restore"
    fi
  }

  chmod a-w "$U/ro"
  restore_u "$U/ro/sessions" "$U/live/openwa.sqlite"
  expect_untouched "missing sessions"
  restore_u "$U/busy/sessions" "$U/ro/openwa.sqlite"
  expect_untouched "data store"
  chmod u+w "$U/ro"
  # An existing directory is emptied before it is refilled, which needs every directory in it.
  chmod a-w "$U/busy/sessions/session-s1"
  restore_u "$U/busy/sessions" "$U/live/openwa.sqlite"
  chmod u+w "$U/busy/sessions/session-s1"
  expect_untouched "non-empty sessions"
  if [ "$(cat "$U/busy/sessions/session-s1/marker")" != "uniform-live" ]; then
    fail "(u) the refused restore changed the live sessions"
  fi
  # The two files written into the data dir after the targets: an archive carrying both, and each one
  # made read-only in turn.
  mkdir -p "$U/extra"
  tar -xzf "$ARCHIVE_U" -C "$U/extra"
  printf 'LOG_LEVEL=info\n' >"$U/extra/.env.generated"
  printf -- '-- dump\n' >"$U/extra/database.sql"
  ARCHIVE_U="$U/extra.tar.gz"
  tar -czf "$ARCHIVE_U" -C "$U/extra" .
  for f in .env.generated database.sql; do
    printf 'uniform-live\n' >"$U/live/$f"
    chmod a-w "$U/live/$f"
    restore_u "$U/busy/sessions" "$U/live/openwa.sqlite"
    chmod u+w "$U/live/$f"
    rm -f "$U/live/$f"
    expect_untouched "$f"
  done
  pass "(u) an unwritable state or database target stops the restore before anything is written"
else
  echo "SKIP: (u) running as root, which ignores the permission bits this case relies on"
fi

echo ""
echo "==> (v) a leftover STORAGE_LOCAL_PATH=./uploads follows the app's fallback to ./data/media"
# v0.2.0 to v0.7.3 persisted ./uploads into data/.env.generated. In the image /app is not writable, so
# the app cannot create it and keeps media in ./data/media instead; the scripts looked in ./uploads,
# found nothing and left every media file out without a word. The read-only working directory stands
# in for /app here.
if [ "$(id -u)" -ne 0 ]; then
  V="$WORK/v"
  mkdir -p "$V/app/data/media" "$V/dst/data" "$V/bare/data"
  make_fixture "$V/app/data/main.sqlite" "victor-main"
  make_fixture "$V/app/data/openwa.sqlite" "victor-data"
  printf 'victor-media\n' >"$V/app/data/media/a.jpg"
  printf 'STORAGE_LOCAL_PATH=./uploads\n' >"$V/app/data/.env.generated"
  chmod a-w "$V/app"
  set +e
  OUT_V="$(cd "$V/app" && BACKUP_DIR="$V/out" "$BACKUP" 2>&1)"
  RC_V=$?
  set -e
  chmod u+w "$V/app"
  if [ "$RC_V" -ne 0 ]; then
    fail "(v) backup failed: $OUT_V"
  fi
  ARCHIVE_V="$(ls "$V"/out/openwa-backup-*.tar.gz)"
  if ! tar -tzf "$ARCHIVE_V" | grep -qx './media/a.jpg'; then
    fail "(v) backup left out the media the app keeps in ./data/media"
  fi
  if ! printf '%s' "$OUT_V" | grep -q 'STORAGE_LOCAL_PATH=./uploads'; then
    fail "(v) the fallback from the leftover ./uploads was not reported"
  fi
  chmod a-w "$V/dst"
  set +e
  OUT_V="$(cd "$V/dst" && "$RESTORE" "$ARCHIVE_V" 2>&1)"
  RC_V=$?
  set -e
  chmod u+w "$V/dst"
  if [ "$RC_V" -ne 0 ]; then
    fail "(v) restore failed: $OUT_V"
  fi
  if [ "$(cat "$V/dst/data/media/a.jpg" 2>/dev/null || true)" != "victor-media" ]; then
    fail "(v) restore did not put the media back where the app reads it"
  fi
  # On a host where ./uploads can be created the app uses it, so the scripts keep it too, and a
  # media dir that is not there is reported rather than skipped in silence.
  make_fixture "$V/bare/data/main.sqlite" "victor-bare-main"
  make_fixture "$V/bare/data/openwa.sqlite" "victor-bare-data"
  printf 'STORAGE_LOCAL_PATH=./uploads\n' >"$V/bare/data/.env.generated"
  OUT_V="$(cd "$V/bare" && BACKUP_DIR="$V/out-bare" "$BACKUP" 2>&1)"
  if ! printf '%s' "$OUT_V" | grep -q 'WARN: ./uploads not found'; then
    fail "(v) a missing media dir was skipped without a warning"
  fi
  pass "(v) a leftover ./uploads falls back like the app, and missing media is reported"
else
  echo "SKIP: (v) running as root, which ignores the permission bits this case relies on"
fi

echo ""
echo "==> (w) the default colocated plugins dir is rebuilt from both archive members"
# Every default and Docker install keeps plugin packages and plugin state in one ./data/plugins, which
# restore replaces once from a merge of the two members. An archive from a split layout makes the
# members differ, so a merge that is skipped or a half that replaces the other shows up here.
W="$WORK/w"
mkdir -p "$W/split/data" "$W/split/pkgs/pkg-a" "$W/split/state/plugins/chatwoot" "$W/dst/data/plugins/old"
make_fixture "$W/split/data/main.sqlite" "whiskey-main"
make_fixture "$W/split/data/openwa.sqlite" "whiskey-data"
printf 'whiskey-code\n' >"$W/split/pkgs/pkg-a/index.js"
printf '{"plugins":[{"id":"chatwoot"}]}' >"$W/split/state/plugins/registry.json"
printf 'whiskey-state\n' >"$W/split/state/plugins/chatwoot/k.json"
printf 'whiskey-stale\n' >"$W/dst/data/plugins/old/x"
(
  cd "$W/split"
  PLUGINS_DIR="$W/split/pkgs" PLUGIN_STATE_DIR="$W/split/state" BACKUP_DIR="$W/out" "$BACKUP" >/dev/null
)
(
  cd "$W/dst"
  "$RESTORE" "$(ls "$W"/out/openwa-backup-*.tar.gz)" >/dev/null
)
# check_plugins <dir> <label>: the package, the registry and the plugin's storage all landed in <dir>.
check_plugins() {
  if [ "$(cat "$1/pkg-a/index.js" 2>/dev/null || true)" != "whiskey-code" ]; then
    fail "(w) $2: the installed plugin package is missing from the colocated plugins dir"
  fi
  if [ ! -f "$1/registry.json" ]; then
    fail "(w) $2: the plugin registry is missing from the colocated plugins dir"
  fi
  if [ "$(cat "$1/chatwoot/k.json" 2>/dev/null || true)" != "whiskey-state" ]; then
    fail "(w) $2: a plugin's persisted ctx.storage is missing from the colocated plugins dir"
  fi
}
check_plugins "$W/dst/data/plugins" "split archive"
if [ -e "$W/dst/data/plugins/old/x" ]; then
  fail "(w) a plugin entry the archive does not carry survived the restore"
fi
if [ "$(cat "$W"/dst/data.pre-restore-*/plugins/old/x 2>/dev/null || true)" != "whiskey-stale" ]; then
  fail "(w) the data-dir snapshot does not hold the plugins dir the restore replaced"
fi
# And the plain round trip of that default layout keeps all three.
(
  cd "$W/dst"
  BACKUP_DIR="$W/out-default" "$BACKUP" >/dev/null
)
mkdir -p "$W/dst2"
(
  cd "$W/dst2"
  "$RESTORE" "$(ls "$W"/out-default/openwa-backup-*.tar.gz)" >/dev/null
)
check_plugins "$W/dst2/data/plugins" "default round trip"
pass "(w) the colocated plugins dir gets packages and state, and loses what the archive does not carry"

echo ""
echo "==> (x) a BOOTSTRAP_KEY_FILE outside the data dir is archived and restored there"
# The app writes and reads the generated admin key at BOOTSTRAP_KEY_FILE. The scripts only looked at
# <data dir>/.api-key, so a relocated key was left out of the archive without a word, and an archived
# one went back to a path the app never reads.
X="$WORK/x"
mkdir -p "$X/src/data" "$X/src/secrets" "$X/dst" "$X/ro/data"
make_fixture "$X/src/data/main.sqlite" "xray-main"
make_fixture "$X/src/data/openwa.sqlite" "xray-data"
printf 'xray-key\n' >"$X/src/secrets/admin.key"
printf 'BOOTSTRAP_KEY_FILE=%s\n' "$X/src/secrets/admin.key" >"$X/src/.env"
(
  cd "$X/src"
  BACKUP_DIR="$X/out" "$BACKUP" >/dev/null
)
ARCHIVE_X="$(ls "$X"/out/openwa-backup-*.tar.gz)"
if [ "$(tar -xOzf "$ARCHIVE_X" ./.api-key 2>/dev/null || true)" != "xray-key" ]; then
  fail "(x) backup left out the admin key BOOTSTRAP_KEY_FILE names"
fi
(
  cd "$X/dst"
  BOOTSTRAP_KEY_FILE="$X/dst/secrets/admin.key" "$RESTORE" "$ARCHIVE_X" >/dev/null
)
if [ "$(cat "$X/dst/secrets/admin.key" 2>/dev/null || true)" != "xray-key" ]; then
  fail "(x) restore did not put the admin key where BOOTSTRAP_KEY_FILE points"
fi
if [ -e "$X/dst/data/.api-key" ]; then
  fail "(x) restore also wrote the admin key to the data dir, where the app does not read it"
fi
if [ "$(id -u)" -ne 0 ]; then
  # A key path the restore cannot write is refused with the other targets, before any database.
  make_fixture "$X/ro/data/main.sqlite" "xray-live-main"
  mkdir -p "$X/ro/secrets"
  chmod a-w "$X/ro/secrets"
  set +e
  OUT_X="$(cd "$X/ro" && BOOTSTRAP_KEY_FILE="$X/ro/secrets/admin.key" "$RESTORE" "$ARCHIVE_X" --force 2>&1)"
  RC_X=$?
  set -e
  chmod u+w "$X/ro/secrets"
  if [ "$RC_X" -eq 0 ] || ! printf '%s' "$OUT_X" | grep -q 'cannot write'; then
    fail "(x) an unwritable BOOTSTRAP_KEY_FILE was not refused: $OUT_X"
  fi
  if [ "$(db_fingerprint "$X/ro/data/main.sqlite")" != "xray-live-main" ]; then
    fail "(x) the main DB was overwritten before the unwritable key path stopped the restore"
  fi
fi
pass "(x) BOOTSTRAP_KEY_FILE is honoured by backup and by restore"

echo ""
echo "==> (y) plugin code in the legacy ./plugins is reported, since the archive does not carry it"
# With PLUGINS_DIR unset the app still loads packages from ./plugins, the default up to 0.12.1, but
# the archive holds only <data dir>/plugins, so a restore brings back a registry with no code.
Y="$WORK/y"
mkdir -p "$Y/data" "$Y/plugins/legacy-bot"
make_fixture "$Y/data/main.sqlite" "yankee-main"
make_fixture "$Y/data/openwa.sqlite" "yankee-data"
printf '{"id":"legacy-bot"}' >"$Y/plugins/legacy-bot/manifest.json"
OUT_Y="$(cd "$Y" && BACKUP_DIR="$Y/out" "$BACKUP" 2>&1)"
if ! printf '%s' "$OUT_Y" | grep -q 'WARN: ./plugins holds plugin packages'; then
  fail "(y) plugin code in the legacy ./plugins was left out without a warning"
fi
OUT_Y="$(cd "$Y" && PLUGINS_DIR="$Y/plugins" BACKUP_DIR="$Y/out2" "$BACKUP" 2>&1)"
if printf '%s' "$OUT_Y" | grep -q 'WARN: ./plugins'; then
  fail "(y) the legacy ./plugins was reported although PLUGINS_DIR names the plugin dir"
fi
pass "(y) packages in the legacy ./plugins are reported when PLUGINS_DIR is unset"

echo ""
echo "==> (z) a leftover ./uploads that was never created follows the app to an existing ./data/media"
# docker exec runs the scripts as root, which can create /app/uploads, while the app runs as openwa,
# which cannot and keeps media in ./data/media. Deciding by writability alone archived no media there
# and restored it into the container layer. The app creates a ./uploads it uses at boot, so a missing
# ./uploads beside an existing ./data/media means ./data/media is the one in use, whatever the uid.
Z="$WORK/z"
mkdir -p "$Z/app/data/media" "$Z/dst/data/media"
make_fixture "$Z/app/data/main.sqlite" "zulu-main"
make_fixture "$Z/app/data/openwa.sqlite" "zulu-data"
printf 'zulu-media\n' >"$Z/app/data/media/a.jpg"
printf 'STORAGE_LOCAL_PATH=./uploads\n' >"$Z/app/data/.env.generated"
OUT_Z="$(cd "$Z/app" && BACKUP_DIR="$Z/out" "$BACKUP" 2>&1)"
ARCHIVE_Z="$(ls "$Z"/out/openwa-backup-*.tar.gz)"
if ! tar -tzf "$ARCHIVE_Z" | grep -qx './media/a.jpg'; then
  fail "(z) backup left out the media in ./data/media: $OUT_Z"
fi
OUT_Z="$(cd "$Z/dst" && "$RESTORE" "$ARCHIVE_Z" 2>&1)"
if [ "$(cat "$Z/dst/data/media/a.jpg" 2>/dev/null || true)" != "zulu-media" ] || [ -e "$Z/dst/uploads" ]; then
  fail "(z) restore did not put the media back under ./data/media: $OUT_Z"
fi
pass "(z) a never-created ./uploads beside ./data/media resolves to ./data/media without a uid check"

echo ""
echo "==> (aa) engine auth state copied from a running app is noted, and restore does not refuse it"
# The databases are snapshotted consistently online, but sessions/ and baileys/ are plain copies of
# directories the engines keep writing, and the runbook called the online backup impact-free. The
# note has its own marker: --strict gates only the database one, or it would refuse every online backup.
AA="$WORK/aa"
mkdir -p "$AA/src/data/sessions/session-s1" "$AA/src/data/sessions/session-s2" "$AA/src/data/baileys/s1" \
  "$AA/dst" "$AA/quiet/data/sessions/session-s1"
make_fixture "$AA/src/data/main.sqlite" "alpha2-main"
make_fixture "$AA/src/data/openwa.sqlite" "alpha2-data"
printf 'profile\n' >"$AA/src/data/sessions/session-s1/Preferences"
printf 'profile\n' >"$AA/src/data/sessions/session-s2/Preferences"
ln -s host-123 "$AA/src/data/sessions/session-s1/SingletonLock"
printf '{}' >"$AA/src/data/baileys/s1/creds.json"
OUT_AA="$(cd "$AA/src" && BACKUP_DIR="$AA/out" "$BACKUP" 2>&1)"
ARCHIVE_AA="$(ls "$AA"/out/openwa-backup-*.tar.gz)"
NOTE_AA="$(tar -xOzf "$ARCHIVE_AA" ./ENGINE-STATE-NOTE 2>/dev/null || true)"
if ! printf '%s\n' "$NOTE_AA" | grep -q 'open or left by a killed browser: session-s1)' ||
  ! printf '%s\n' "$NOTE_AA" | grep -q '^baileys/'; then
  fail "(aa) the archive does not note the open profile and the Baileys state: $NOTE_AA"
fi
# Without sqlite3 the same archive carries CONSISTENCY-WARNING, so the engine note must not vouch
# for the databases.
if printf '%s\n' "$NOTE_AA" | grep -qi 'consistent snapshot'; then
  fail "(aa) the engine note claims the databases are consistent: $NOTE_AA"
fi
if ! printf '%s' "$OUT_AA" | grep -q 'may have been written during the copy'; then
  fail "(aa) backup did not warn that engine auth state may have been written during the copy: $OUT_AA"
fi
if ! tar -tvzf "$ARCHIVE_AA" | grep -q '^l.*session-s1/SingletonLock'; then
  fail "(aa) the profile lock was not archived as the symlink it is"
fi
# Without sqlite3 the databases are plain-copied and --strict rightly refuses on that marker.
if [ "$HAS_SQLITE3" -eq 1 ]; then
  OUT_AA="$(cd "$AA/dst" && "$RESTORE" "$ARCHIVE_AA" --strict 2>&1)" ||
    fail "(aa) restore --strict refused an archive whose only note is the engine one: $OUT_AA"
else
  OUT_AA="$(cd "$AA/dst" && "$RESTORE" "$ARCHIVE_AA" 2>&1)" || fail "(aa) restore failed: $OUT_AA"
fi
if ! printf '%s' "$OUT_AA" | grep -q 'ENGINE-STATE-NOTE; engine auth state may have been copied' ||
  ! printf '%s' "$OUT_AA" | grep -q 'session-s1'; then
  fail "(aa) restore did not print the engine state note: $OUT_AA"
fi
# No open profile and no Baileys state: nothing to note.
make_fixture "$AA/quiet/data/main.sqlite" "alpha2-quiet-main"
make_fixture "$AA/quiet/data/openwa.sqlite" "alpha2-quiet-data"
printf 'profile\n' >"$AA/quiet/data/sessions/session-s1/Preferences"
(cd "$AA/quiet" && BACKUP_DIR="$AA/quiet-out" "$BACKUP" >/dev/null 2>&1)
if tar -tzf "$(ls "$AA"/quiet-out/openwa-backup-*.tar.gz)" | grep -q 'ENGINE-STATE-NOTE'; then
  fail "(aa) an archive with no open profile and no Baileys state carries the engine note"
fi
pass "(aa) live engine auth state is noted in the archive and printed, never refused"

echo ""
echo "==> (ab) a blank line in ./.env hides the key from data/.env.generated, as it does in the app"
# dotenv sets a blank ./.env line to '' and never overwrites a key that is already set, so the app
# reads its built-in default and never sees .env.generated's value. Falling through to that value
# archived a database the app does not use, and the run exited 0.
AB="$WORK/ab"
mkdir -p "$AB/data" "$AB/elsewhere" "$AB/extract"
make_fixture "$AB/data/main.sqlite" "bravo2-main"
make_fixture "$AB/data/openwa.sqlite" "bravo2-default"
make_fixture "$AB/elsewhere/openwa.sqlite" "WRONG-data"
printf 'DATABASE_NAME=\n' >"$AB/.env"
printf 'DATABASE_NAME=%s\n' "$AB/elsewhere/openwa.sqlite" >"$AB/data/.env.generated"
(cd "$AB" && BACKUP_DIR="$AB/out" "$BACKUP" >/dev/null 2>&1)
tar -xzf "$(ls "$AB"/out/openwa-backup-*.tar.gz)" -C "$AB/extract"
if [ "$(db_fingerprint "$AB/extract/openwa.sqlite")" != "bravo2-default" ]; then
  fail "(ab) a blank DATABASE_NAME in ./.env fell through to data/.env.generated"
fi
pass "(ab) a blank ./.env line stops the lookup and the built-in default applies"

echo ""
echo "==> (ac) a Baileys engine chosen in the dashboard is warned about when its auth dir is missing"
# Compose forwards a blank ENGINE_TYPE and the dashboard saves the real one in data/.env.generated, so
# reading the environment alone never saw Baileys there and skipped the re-pairing warning.
AC="$WORK/ac"
mkdir -p "$AC/data"
make_fixture "$AC/data/main.sqlite" "charlie2-main"
make_fixture "$AC/data/openwa.sqlite" "charlie2-data"
printf 'ENGINE_TYPE=baileys\n' >"$AC/data/.env.generated"
OUT_AC="$(cd "$AC" && ENGINE_TYPE='' BACKUP_DIR="$AC/out" "$BACKUP" 2>&1)"
if ! printf '%s' "$OUT_AC" | grep -q 'ENGINE_TYPE=baileys but .* was not found'; then
  fail "(ac) a dashboard-selected Baileys engine with no auth dir was not reported: $OUT_AC"
fi
pass "(ac) the missing Baileys auth dir is reported when data/.env.generated selects Baileys"

echo ""
echo "==> (ad) a file the engine deletes during the state copy notes the copy instead of failing the backup"
# Chromium and the Baileys auth store delete and rename files while they run, so cp can list a file
# that is gone when it opens it. Under set -e that aborted the online backup with no archive. The shim
# cp copies for real, then reports the error a vanished file gives; any other cp error stays fatal.
AD="$WORK/ad"
mkdir -p "$AD/data/sessions/session-s1" "$AD/data/baileys/s1" "$AD/data/media" "$AD/data/plugins" "$AD/shim"
make_fixture "$AD/data/main.sqlite" "delta2-main"
make_fixture "$AD/data/openwa.sqlite" "delta2-data"
printf 'profile\n' >"$AD/data/sessions/session-s1/Preferences"
printf '{}' >"$AD/data/baileys/s1/creds.json"
printf 'jpeg\n' >"$AD/data/media/status.jpg"
printf '{}' >"$AD/data/plugins/registry.json"
# SHIM_CP_LINES repeats the error past a pipe buffer, the size of a real tree's worth of failures. Without
# LC_ALL=C the vanished-file text comes out translated, as cp prints it on a localized host.
cat >"$AD/shim/cp" <<SHIM
#!/bin/sh
$(command -v cp) "\$@" || exit
msg="\$SHIM_CP_ERROR"
if [ "\${LC_ALL:-}" != C ] && [ "\$msg" = 'No such file or directory' ]; then
  msg='Datei oder Verzeichnis nicht gefunden'
fi
case "\$3" in
  */sessions | */baileys | */media | */plugin-*)
    i=0
    while [ "\$i" -lt "\${SHIM_CP_LINES:-1}" ]; do
      echo "cp: cannot stat '\$2/gone\$i': \$msg" >&2
      i=\$((i + 1))
    done
    exit 1
    ;;
esac
SHIM
chmod +x "$AD/shim/cp"
set +e
OUT_AD="$(cd "$AD" && SHIM_CP_ERROR='No such file or directory' PATH="$AD/shim:$PATH" BACKUP_DIR="$AD/out" "$BACKUP" 2>&1)"
RC_AD=$?
set -e
if [ "$RC_AD" -ne 0 ]; then
  fail "(ad) a file that vanished during the engine state copy failed the backup: $OUT_AD"
fi
NOTE_AD="$(tar -xOzf "$(ls "$AD"/out/openwa-backup-*.tar.gz)" ./ENGINE-STATE-NOTE 2>/dev/null || true)"
if ! printf '%s\n' "$NOTE_AD" | grep -q '^sessions/ (files changed during the copy)' ||
  ! printf '%s\n' "$NOTE_AD" | grep -q '^baileys/ (files changed during the copy)'; then
  fail "(ad) the archive does not note the state copies that changed underneath: $NOTE_AD"
fi
for tree in media plugins; do
  if ! printf '%s\n' "$OUT_AD" | grep -q "WARN: files under .*/$tree changed during the copy"; then
    fail "(ad) the backup did not log the $tree copy that changed underneath: $OUT_AD"
  fi
done
set +e
OUT_AD="$(cd "$AD" && SHIM_CP_ERROR='Permission denied' SHIM_CP_LINES=20000 PATH="$AD/shim:$PATH" \
  BACKUP_DIR="$AD/out2" "$BACKUP" 2>&1)"
RC_AD=$?
set -e
if [ "$RC_AD" -eq 0 ] || ! grep -q 'Permission denied' <<<"$OUT_AD" ||
  [ -n "$(ls "$AD"/out2/openwa-backup-*.tar.gz 2>/dev/null)" ]; then
  fail "(ad) a cp error other than a vanished file did not fail the backup: $(tail -n 5 <<<"$OUT_AD")"
fi
pass "(ad) a vanished engine file is noted, a vanished media or plugin file logged, other cp errors fatal"

echo ""
echo "==> (ae) the min-content check passes an archive whose listing outgrows a pipe buffer"
# A whatsapp-web.js profile alone lists thousands of members. A grep -q that matched a required member
# early and stopped reading broke the pipe feeding it, and pipefail turned the match into "missing", so a
# good archive was deleted. The shim tar pads the listing after the real members, past a pipe buffer.
AE="$WORK/ae"
mkdir -p "$AE/data" "$AE/shim"
make_fixture "$AE/data/main.sqlite" "echo2-main"
make_fixture "$AE/data/openwa.sqlite" "echo2-data"
cat >"$AE/shim/tar" <<SHIM
#!/bin/sh
$(command -v tar) "\$@" || exit
if [ "\$1" = -tzf ]; then
  i=0
  while [ "\$i" -lt 20000 ]; do
    echo "./sessions/session-s1/Default/Cache/Cache_Data/padding-\$i"
    i=\$((i + 1))
  done
fi
SHIM
chmod +x "$AE/shim/tar"
set +e
OUT_AE="$(cd "$AE" && PATH="$AE/shim:$PATH" BACKUP_DIR="$AE/out" "$BACKUP" 2>&1)"
RC_AE=$?
set -e
if [ "$RC_AE" -ne 0 ] || [ -z "$(ls "$AE"/out/openwa-backup-*.tar.gz 2>/dev/null)" ]; then
  fail "(ae) a long archive listing failed the min-content check: $(grep -v padding- <<<"$OUT_AE")"
fi
pass "(ae) the min-content check reads the whole listing"

echo ""
if [ "$HAS_SQLITE3" -eq 1 ]; then
  echo "==> (af) the online SQLite backup waits out a writer holding the database lock"
  # The app writes several times a second in rollback-journal mode. A bare .backup gave up on the first
  # lock it met with 'database is locked', so on a busy gateway no online backup completed.
  AF="$WORK/af"
  mkdir -p "$AF/data"
  make_fixture "$AF/data/main.sqlite" "foxtrot2-main"
  make_fixture "$AF/data/openwa.sqlite" "foxtrot2-data"
  {
    echo 'BEGIN EXCLUSIVE;'
    echo "INSERT INTO sentinel VALUES('foxtrot2-late');"
    echo ".system touch '$AF/locked'"
    sleep 2
    echo 'COMMIT;'
  } | sqlite3 "$AF/data/main.sqlite" &
  WRITER_AF=$!
  for _ in $(seq 1 100); do
    [ -f "$AF/locked" ] && break
    sleep 0.1
  done
  [ -f "$AF/locked" ] || fail "(af) the writer never took the database lock"
  set +e
  OUT_AF="$(cd "$AF" && BACKUP_DIR="$AF/out" "$BACKUP" 2>&1)"
  RC_AF=$?
  set -e
  wait "$WRITER_AF"
  if [ "$RC_AF" -ne 0 ]; then
    fail "(af) the backup failed while a writer held the database lock: $OUT_AF"
  fi
  mkdir -p "$AF/extract"
  tar -xzf "$(ls "$AF"/out/openwa-backup-*.tar.gz)" -C "$AF/extract"
  if [ "$(sqlite3 "$AF/extract/main.sqlite" 'PRAGMA integrity_check;')" != ok ]; then
    fail "(af) the snapshot taken after the writer let go is not a sound database"
  fi
  pass "(af) the online backup waits for the lock instead of failing"
else
  echo "SKIP: (af) sqlite3 not found on this host, so there is no database lock to wait on"
fi

echo ""
echo "==> (ag) quoted, commented and empty-quoted ./.env values resolve as the app reads them, and others stop the run"
# dotenv strips a value's quotes and an unquoted value's comment, and a key it has set keeps
# data/.env.generated from supplying it. The scripts skipped every such line and read the next layer,
# so .env.example's commented PLUGINS_DIR line and a `DATABASE_NAME=""` resolved to values the app
# never uses. A line the scripts cannot parse used to resolve to the default with a warning, so a
# backup archived a stale database at the default path, or no media, and still exited 0.
AG="$WORK/ag"
mkdir -p "$AG/data"
cat >"$AG/.env" <<'ENV'
PLUGINS_DIR=./data/plugins          # Plugin directory (default: ./data/plugins)
DATABASE_NAME=""
MAIN_DATABASE_NAME='./data/quoted main.sqlite'
BAILEYS_AUTH_DIR=./data/bl#inline
SESSION_DATA_PATH="./data/sess" # quoted, then a comment
STORAGE_LOCAL_PATH="./data/media" # see "docs"
PLUGIN_STATE_DIR='./data/state' # it'
ENGINE_TYPE: baileys
BOOTSTRAP_KEY_FILE="./data/key\file"
ENV
printf 'DATABASE_NAME=./elsewhere/openwa.sqlite\nSESSION_DATA_PATH=./elsewhere/sess\n' >"$AG/data/.env.generated"
resolve_ag() {
  (cd "$AG" && DATA_DIR=./data && . "$REPO_ROOT/scripts/lib-env.sh" && openwa_resolve "$1" "$2") 2>>"$AG/err"
}
# A blank value resolves to the default, never to data/.env.generated.
for check in 'PLUGINS_DIR|./data/plugins' 'DATABASE_NAME|DEFAULT' 'MAIN_DATABASE_NAME|./data/quoted main.sqlite' \
  'BAILEYS_AUTH_DIR|./data/bl'; do
  key="${check%%|*}"
  got="$(resolve_ag "$key" DEFAULT)"
  if [ "$got" != "${check#*|}" ]; then
    fail "(ag) $key resolved to '$got', expected '${check#*|}'"
  fi
done
# An unparsed line fails the lookup and prints no value: neither the default nor data/.env.generated.
# A comment ending in the value's own quote must not pass for the closing quote.
for key in SESSION_DATA_PATH STORAGE_LOCAL_PATH PLUGIN_STATE_DIR ENGINE_TYPE BOOTSTRAP_KEY_FILE; do
  set +e
  got="$(resolve_ag "$key" DEFAULT)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ] || [ -n "$got" ]; then
    fail "(ag) $key in a form the scripts cannot parse resolved to '$got' (rc $rc) instead of failing"
  fi
  if ! grep -q "sets $key in a form" "$AG/err"; then
    fail "(ag) the parse error did not name $key: $(cat "$AG/err")"
  fi
done
if [ "$(grep -c 'do not parse' "$AG/err")" -ne 5 ]; then
  fail "(ag) the parse error did not name exactly the five unparsed lines: $(cat "$AG/err")"
fi

# Both scripts stop on such a line before archiving or writing anything. The data store sits at a
# custom path while a stale database is left at the default one, which the backup used to archive.
AGB="$WORK/ag-backup"
mkdir -p "$AGB/data/media" "$AGB/dst/data"
make_fixture "$AGB/data/main.sqlite" "ag-main"
make_fixture "$AGB/data/active.sqlite" "ag-active"
make_fixture "$AGB/data/openwa.sqlite" "ag-STALE"
(cd "$AGB" && BACKUP_DIR="$AGB/good" "$BACKUP" >/dev/null 2>&1) || fail "(ag) the fixture backup failed"
ARCHIVE_AG="$(ls "$AGB"/good/openwa-backup-*.tar.gz)"
for line in 'DATABASE_NAME="./data/active.sqlite" # data store' \
  'DATABASE_TYPE="postgres" # migrated' \
  'STORAGE_LOCAL_PATH="./data/media" # local disk'; do
  key="${line%%[=:]*}"
  printf '%s\n' "$line" >"$AGB/.env"
  set +e
  OUT_AG="$(cd "$AGB" && BACKUP_DIR="$AGB/out" "$BACKUP" 2>&1)"
  RC_AG=$?
  set -e
  if [ "$RC_AG" -eq 0 ]; then
    fail "(ag) backup exited 0 with an unparsed $key line: $OUT_AG"
  fi
  if ! grep -q "sets $key in a form" <<<"$OUT_AG"; then
    fail "(ag) backup did not name $key: $OUT_AG"
  fi
  if [ -n "$(ls "$AGB/out" 2>/dev/null)" ]; then
    fail "(ag) backup left an archive behind for an unparsed $key line"
  fi
  if [ "$key" = DATABASE_TYPE ]; then
    continue # restore does not read it
  fi
  printf '%s\n' "$line" >"$AGB/dst/.env"
  set +e
  OUT_AG="$(cd "$AGB/dst" && "$RESTORE" "$ARCHIVE_AG" --force 2>&1)"
  RC_AG=$?
  set -e
  if [ "$RC_AG" -eq 0 ] || ! grep -q "sets $key in a form" <<<"$OUT_AG"; then
    fail "(ag) restore did not stop on an unparsed $key line (rc $RC_AG): $OUT_AG"
  fi
  if [ -n "$(ls "$AGB/dst/data")" ]; then
    fail "(ag) restore wrote into the target before stopping on an unparsed $key line"
  fi
done
# dotenv also reads a line behind a byte-order mark or a Unicode blank, trims a no-break space off a
# value and takes a bare CR for a line break. grep's [[:space:]] does not, so each of these used to
# resolve to the stale default and archive it with exit 0. dotenv reads a byte that is not UTF-8 as
# U+FFFD, which grep in a UTF-8 locale skipped the line for, and bash drops a NUL from the value.
for line in '\357\273\277DATABASE_NAME=./data/active.sqlite' '\302\240DATABASE_NAME=./data/active.sqlite' \
  'DATABASE_NAME=./data/active.sqlite\302\240' 'LOG_LEVEL=info\rDATABASE_NAME=./data/active.sqlite' \
  'DATABASE_NAME=./data/active.sqlite # donn\351es' 'DATABASE_NAME=./data/act\000ive.sqlite' \
  'DATABASE_NAME\302\240=./data/active.sqlite' 'DATABASE_NAME=\342\200\257./data/active.sqlite' \
  'DATABASE_NAME=./data/active.sqlite\343\200\200 # data store' '# note\342\200\250DATABASE_NAME=./data/active.sqlite'; do
  # shellcheck disable=SC2059 # the line's escapes are the point
  printf "$line\n" >"$AGB/.env"
  set +e
  OUT_AG="$(cd "$AGB" && BACKUP_DIR="$AGB/out" "$BACKUP" 2>&1)"
  RC_AG=$?
  set -e
  if [ "$RC_AG" -eq 0 ] || [ -n "$(ls "$AGB/out" 2>/dev/null)" ] ||
    ! grep -q 'on a line naming DATABASE_NAME' <<<"$OUT_AG"; then
    fail "(ag) backup did not stop on $line (rc $RC_AG): $OUT_AG"
  fi
done
# A NUL elsewhere in the file made grep treat it as binary and print nothing, so the default was used.
printf 'LOG_LEVEL=a\000b\nDATABASE_NAME=./data/active.sqlite\n' >"$AGB/.env"
OUT_AG="$(cd "$AGB" && BACKUP_DIR="$AGB/nul" "$BACKUP" 2>&1)" || fail "(ag) backup failed with a NUL on another line of ./.env"
# bash 4.4 and later warn about a NUL in a command substitution's output, which reads like a fault.
if grep -q 'null byte' <<<"$OUT_AG"; then
  fail "(ag) a NUL on the line before DATABASE_NAME leaked a shell warning: $OUT_AG"
fi
rm -rf "$AGB/x" && mkdir -p "$AGB/x"
tar -xzf "$(ls "$AGB"/nul/openwa-backup-*.tar.gz)" -C "$AGB/x"
if [ "$(db_fingerprint "$AGB/x/openwa.sqlite")" != "ag-active" ]; then
  fail "(ag) a NUL on another line of ./.env archived '$(db_fingerprint "$AGB/x/openwa.sqlite")' instead of the configured data store"
fi
# None of these stop the run, as none changes what the app reads: a comment or another key's value
# naming the key holds a no-break space or a Latin-1 byte, the key's own inline comment or the middle
# of its value holds a Unicode blank, or a bare `export KEY` follows the key's line, which dotenv skips.
# ENGINE_TYPE only gates a warning, so a line the scripts cannot parse skips the warning, not the backup.
make_fixture "$AGB/data/act"$'\343\200\200'"ive.sqlite" "ag-active"
for content in 'DATABASE_NAME=./data/active.sqlite\nexport DATABASE_NAME' \
  '# DATABASE_NAME\302\240is the data store\nDATABASE_NAME=./data/active.sqlite' \
  '# DATABASE_NAME: donn\351es\nDATABASE_NAME=./data/active.sqlite' \
  'NOTE=see DATABASE_NAME\302\240below\nDATABASE_NAME=./data/active.sqlite' \
  'DATABASE_NAME=./data/active.sqlite # primary\302\240store' 'DATABASE_NAME=./data/act\343\200\200ive.sqlite' \
  'DATABASE_NAME=./data/active.sqlite\nENGINE_TYPE: baileys'; do
  # shellcheck disable=SC2059 # the line's escapes are the point
  printf "$content\n" >"$AGB/.env"
  rm -rf "$AGB/kept" "$AGB/x" && mkdir -p "$AGB/x"
  set +e
  OUT_AG="$(cd "$AGB" && BACKUP_DIR="$AGB/kept" "$BACKUP" 2>&1)"
  RC_AG=$?
  set -e
  if [ "$RC_AG" -ne 0 ]; then
    fail "(ag) backup stopped on $content (rc $RC_AG): $OUT_AG"
  fi
  tar -xzf "$(ls "$AGB"/kept/openwa-backup-*.tar.gz)" -C "$AGB/x"
  if [ "$(db_fingerprint "$AGB/x/openwa.sqlite")" != "ag-active" ]; then
    fail "(ag) $content archived '$(db_fingerprint "$AGB/x/openwa.sqlite")' instead of the configured data store"
  fi
done
if ! grep -q 'sets ENGINE_TYPE in a form' <<<"$OUT_AG" || ! grep -q 'skipping only the check for missing Baileys state' <<<"$OUT_AG"; then
  fail "(ag) backup did not report the ENGINE_TYPE line it cannot parse and that it carried on: $OUT_AG"
fi
# The run carries on, so the line is reported as a warning rather than an error.
if grep -q 'ERROR' <<<"$OUT_AG" || ! grep -q '^\[config\] WARN: .* sets ENGINE_TYPE in a form' <<<"$OUT_AG"; then
  fail "(ag) backup reported the ENGINE_TYPE line it carries on past as an error: $OUT_AG"
fi
rm -f "$AGB/data/act"$'\343\200\200'"ive.sqlite"
# dotenv reads the line after a bare `NAME:` line as NAME's value, so the app never sets the key from it.
printf 'LOG_LEVEL:\nDATABASE_NAME=./data/active.sqlite\n' >"$AGB/.env"
set +e
OUT_AG="$(cd "$AGB" && BACKUP_DIR="$AGB/out" "$BACKUP" 2>&1)"
RC_AG=$?
set -e
if [ "$RC_AG" -eq 0 ] || [ -n "$(ls "$AGB/out" 2>/dev/null)" ] ||
  ! grep -q 'just before a line setting DATABASE_NAME' <<<"$OUT_AG"; then
  fail "(ag) backup did not stop on a DATABASE_NAME line right after a bare LOG_LEVEL: line (rc $RC_AG): $OUT_AG"
fi
# dotenv's `KEY\s*=` and the quoted value after an empty `KEY=` cross line breaks, and dotenv starts a
# line after U+2028, so each of these sets the key for the app, or hides its line, from another line.
# The scripts used to read the default or the hidden line, and archived it with exit 0.
for check in 'DATABASE_NAME\n=./data/active.sqlite|names DATABASE_NAME on a line without an =' \
  'DATABASE_NAME=./data/openwa.sqlite\nexport DATABASE_NAME\n\n=./data/active.sqlite|names DATABASE_NAME on a line without an =' \
  'DATABASE_NAME=\n\n"./data/active.sqlite"|leaves DATABASE_NAME empty on its line' \
  '# note\342\200\250LOG_LEVEL:\nDATABASE_NAME=./data/active.sqlite|just before a line setting DATABASE_NAME'; do
  # shellcheck disable=SC2059 # the line's escapes are the point
  printf "${check%%|*}\n" >"$AGB/.env"
  set +e
  OUT_AG="$(cd "$AGB" && BACKUP_DIR="$AGB/out" "$BACKUP" 2>&1)"
  RC_AG=$?
  set -e
  if [ "$RC_AG" -eq 0 ] || [ -n "$(ls "$AGB/out" 2>/dev/null)" ] || ! grep -q "${check#*|}" <<<"$OUT_AG"; then
    fail "(ag) backup did not stop on ${check%%|*} (rc $RC_AG): $OUT_AG"
  fi
done
# dotenv can take the backslash and quote that end a quoted value for an escaped quote, and read on to a
# later quote that only blanks or a comment follow, escaped or not.
for ag_next in "'" "x\\' # note"; do
  printf '%s\n' "DATABASE_NAME='./data/active.sqlite\\'" "$ag_next" >"$AGB/.env"
  set +e
  OUT_AG="$(cd "$AGB" && DATA_DIR=./data && . "$REPO_ROOT/scripts/lib-env.sh" && openwa_resolve DATABASE_NAME DEFAULT 2>&1)"
  RC_AG=$?
  set -e
  if [ "$RC_AG" -eq 0 ] || ! grep -q 'ending in a backslash' <<<"$OUT_AG"; then
    fail "(ag) a quoted DATABASE_NAME ending in a backslash before '$ag_next' did not fail the lookup (rc $RC_AG): $OUT_AG"
  fi
done
# An empty `KEY=` followed by blank lines and an unquoted line stays empty for dotenv too.
printf 'DATABASE_NAME=\n\n# data store\nLOG_LEVEL=info\n' >"$AGB/.env"
if [ "$(cd "$AGB" && DATA_DIR=./data && . "$REPO_ROOT/scripts/lib-env.sh" && openwa_resolve DATABASE_NAME DEFAULT)" != DEFAULT ]; then
  fail "(ag) an empty DATABASE_NAME= followed by a comment and another key did not resolve to the default"
fi
# dotenv reads each of these unambiguously, and the scripts used to stop on them: a Unicode blank inside
# a quoted value; a Unicode blank, a byte that is not UTF-8 or a bare NAME: line before it on an earlier
# line for the key, which the last one overrides; and a value single-quoted for its `#` and ending in a
# backslash, as the dashboard writes it, with no single quote on a later line or only one followed by
# more than a comment. An empty value followed by a comment holding a Unicode blank is still empty, so
# the default applies. The key's line also sets it after a quoted value that closes on its own lines,
# even on a line that looks like it opens one, or that nothing closes, which dotenv then reads without
# its quote, and after one closed by an escaped quote whose later quote is followed by more than a
# comment. A line that would open a quoted value but is the value of a bare NAME: line before it
# opens nothing, and neither does a U+2028 inside an unquoted value start a line. Nor does a quote
# inside a value opened with another quote character open a value, even after a U+2029 there, or a
# quote in an unquoted value, which runs on past a U+2028. Fields: ./.env, .env.generated, the key and
# the value the app reads, all with printf escapes.
AGC="$WORK/ag-last-line"
mkdir -p "$AGC/data"
for check in 'DATABASE_NAME=\047a\302\240#b\047||DATABASE_NAME|a\302\240#b' \
  'LOG_LEVEL:\nDATABASE_NAME=a\nDATABASE_NAME=b||DATABASE_NAME|b' \
  'DATABASE_NAME=a\302\240\nDATABASE_NAME=b||DATABASE_NAME|b' \
  'DATABASE_NAME=a # donn\351es\nDATABASE_NAME=b||DATABASE_NAME|b' \
  'DATABASE_NAME= # note\302\240||DATABASE_NAME|DEFAULT' \
  'DATABASE_NAME=#a\302\240#b\nLOG_LEVEL=info||DATABASE_NAME|DEFAULT' \
  '|DATABASE_PASSWORD=\047p#w\134\047\nDATABASE_HOST="db"|DATABASE_PASSWORD|p#w\134' \
  '|DATABASE_PASSWORD=\047p#w\134\047\nREDIS_PASSWORD=\047x#y\047|DATABASE_PASSWORD|p#w\134' \
  'N:\nB=\047y\nDATABASE_NAME=b\nz\047||DATABASE_NAME|b' \
  'M:\nN=\n\047x\nDATABASE_NAME=b\nz\047||DATABASE_NAME|b' \
  'A=1\342\200\250B=\047y\nDATABASE_NAME=b\nz\047||DATABASE_NAME|b' \
  '|DATABASE_PASSWORD=\047pw\302\240#x\047|DATABASE_PASSWORD|pw\302\240#x' \
  'CERT="BEGIN\nabc\nEND"\nDATABASE_NAME=b||DATABASE_NAME|b' \
  'LOG_LEVEL=\047x\nDATABASE_NAME=b||DATABASE_NAME|b' \
  'LOG_LEVEL=\047a\134\047\nDATABASE_NAME=b\nY=\047c\047||DATABASE_NAME|b' \
  'CERT=\047a\nNOTE=\047 # c\nDATABASE_NAME=b\nY=x\047||DATABASE_NAME|b' \
  'A=\047x\nB="y\n\047\nDATABASE_NAME=b\nC=z"||DATABASE_NAME|b' \
  'A=\047x\342\200\251B="y\047 # c\nDATABASE_NAME=b\nC=z"||DATABASE_NAME|b' \
  'A=x\047y\342\200\250B=\047z\nDATABASE_NAME=b\nz\047||DATABASE_NAME|b' \
  'N:\nx\047\342\200\250B=\047z\nDATABASE_NAME=b\nz\047||DATABASE_NAME|b'; do
  IFS='|' read -r ag_env ag_gen ag_key ag_want <<<"$check"
  # shellcheck disable=SC2059 # the fields' escapes are the point
  printf "$ag_env\n" >"$AGC/.env"
  # shellcheck disable=SC2059
  printf "$ag_gen\n" >"$AGC/data/.env.generated"
  # shellcheck disable=SC2059
  ag_want="$(printf "$ag_want")"
  set +e
  got="$(cd "$AGC" && DATA_DIR=./data && . "$REPO_ROOT/scripts/lib-env.sh" && openwa_resolve "$ag_key" DEFAULT 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ] || [ "$got" != "$ag_want" ]; then
    fail "(ag) $ag_key in '$ag_env' / '$ag_gen' resolved to '$got' (rc $rc) instead of the app's '$ag_want'"
  fi
done
# dotenv reads the line after a bare `DATABASE_NAME:` as its value, and Docker Compose, which
# interpolates ./.env into the container, reads `KEY:value` and `KEY :value` as settings, so each stops
# the run even when .env.generated sets the key. The error names the `KEY: value` form, not a bare
# NAME: line before the key's line.
printf 'DATABASE_NAME=./data/gen\n' >"$AGC/data/.env.generated"
for ag_env in 'DATABASE_NAME:\n./data/active.sqlite' 'DATABASE_NAME:./data/a.sqlite' \
  'DATABASE_NAME=./data/b.sqlite\nDATABASE_NAME :./data/a.sqlite'; do
  # shellcheck disable=SC2059 # the escapes are the point
  printf "$ag_env\n" >"$AGC/.env"
  set +e
  OUT_AG="$(cd "$AGC" && DATA_DIR=./data && . "$REPO_ROOT/scripts/lib-env.sh" && openwa_resolve DATABASE_NAME DEFAULT 2>&1)"
  RC_AG=$?
  set -e
  if [ "$RC_AG" -ne 2 ] || ! grep -q 'sets DATABASE_NAME in a form' <<<"$OUT_AG" || grep -q 'bare NAME:' <<<"$OUT_AG"; then
    fail "(ag) '$ag_env' was not reported as KEY: value (rc $RC_AG): $OUT_AG"
  fi
done
# dotenv reads a quoted value on to its closing quote, so a line for the key inside it does not set the
# key. Whether the quote opens on an earlier line for the key or another key's, at the start of a line
# after an empty NAME=, after a bare NAME: line that is itself the value of the one before it, or after
# a bare CR, U+2028 or U+2029, where dotenv starts a line, and whether it closes before one of those,
# the run stops instead of reading the key's last line or a line inside the value. A quote followed by
# a colon opens a value too.
for ag_env in 'DATABASE_NAME=\047a\302\240\nDATABASE_NAME=./data/a.sqlite\047' \
  'DATABASE_NAME=\047x\nDATABASE_NAME=\377a\nDATABASE_NAME=./data/a.sqlite\047' \
  'LOG_LEVEL=\047x\nDATABASE_NAME=a\302\240\nDATABASE_NAME=./data/a.sqlite\nY\047' \
  'LOG_LEVEL=\047x\nLOG:\nDATABASE_NAME=a\nDATABASE_NAME=./data/a.sqlite\nY\047' \
  'DATABASE_NAME=\047a\nDATABASE_NAME=./data/a.sqlite\047' \
  'LOG_LEVEL=\n\n"x\nDATABASE_NAME=./data/a.sqlite" # note' \
  'W:\nN:\nB=\047y\nDATABASE_NAME=./data/a.sqlite\nz\047' \
  'x\rA=\047y\nDATABASE_NAME=./data/a.sqlite\nz\047' \
  '# n\342\200\250A=\047y\nDATABASE_NAME=./data/a.sqlite\nz\047' \
  'A=\047x\nDATABASE_NAME=./data/a.sqlite\nz\047\342\200\251more' \
  'A=\047x\nDATABASE_NAME=./data/a.sqlite\nz\047\rmore' \
  'A=\047x\nB=\047:\nDATABASE_NAME=./data/a.sqlite\n\047'; do
  # shellcheck disable=SC2059 # the escapes are the point
  printf "$ag_env\n" >"$AGC/.env"
  set +e
  OUT_AG="$(cd "$AGC" && DATA_DIR=./data && . "$REPO_ROOT/scripts/lib-env.sh" && openwa_resolve DATABASE_NAME DEFAULT 2>&1)"
  RC_AG=$?
  set -e
  if [ "$RC_AG" -ne 2 ] || ! grep -q 'opens a quoted value on line' <<<"$OUT_AG"; then
    fail "(ag) DATABASE_NAME inside the quoted value in '$ag_env' resolved to '$OUT_AG' (rc $RC_AG) instead of stopping"
  fi
done
# The error names the file's line that opens the value, not one counted after a line break dotenv adds,
# and still counts a line of the file that starts with U+2029.
printf 'Q=1\n\342\200\251# n\nx\ry\342\200\250A=\047v\nDATABASE_NAME=./data/a.sqlite\nz\047\n' >"$AGC/.env"
set +e
OUT_AG="$(cd "$AGC" && DATA_DIR=./data && . "$REPO_ROOT/scripts/lib-env.sh" && openwa_resolve DATABASE_NAME DEFAULT 2>&1)"
set -e
if ! grep -q 'opens a quoted value on line 3 that the app can read on to line 4,' <<<"$OUT_AG"; then
  fail "(ag) the quoted value opened after a bare CR and U+2028 was not reported on line 3: $OUT_AG"
fi
# The scripts trim only ASCII blanks, so a no-break space after a closing quote stops the run in a
# UTF-8 locale too, as it does in the C locale.
ag_loc="$(locale -a 2>/dev/null | grep -m 1 -ixE 'C\.UTF-?8|en_US\.UTF-?8')" || true
if [ -n "$ag_loc" ]; then
  printf 'DATABASE_NAME=\047\047 \302\240\n' >"$AGC/.env"
  set +e
  # shellcheck disable=SC2016 # expanded by the inner shell
  OUT_AG="$(cd "$AGC" && LC_ALL="$ag_loc" bash -c 'DATA_DIR=./data && . "$1" && openwa_resolve DATABASE_NAME DEFAULT' _ "$REPO_ROOT/scripts/lib-env.sh" 2>&1)"
  RC_AG=$?
  set -e
  if [ "$RC_AG" -ne 2 ] || ! grep -q 'sets DATABASE_NAME in a form' <<<"$OUT_AG"; then
    fail "(ag) a no-break space after a closing quote resolved to '$OUT_AG' (rc $RC_AG) under LC_ALL=$ag_loc"
  fi
fi
# Without tr, tail, sed or grep the key's line cannot be read, so the lookup stops instead of taking
# the default.
printf 'DATABASE_SSL=true\n' >"$AGC/.env"
for ag_tool in tr tail sed grep; do
  rm -rf "$AGC/shim"
  mkdir -p "$AGC/shim"
  populate_shim "$AGC/shim"
  rm -f "$AGC/shim/$ag_tool"
  set +e
  # shellcheck disable=SC2016 # expanded by the inner shell
  OUT_AG="$(cd "$AGC" && PATH="$AGC/shim" bash -c 'DATA_DIR=./data && . "$1" && openwa_resolve DATABASE_SSL false' _ "$REPO_ROOT/scripts/lib-env.sh" 2>&1)"
  RC_AG=$?
  set -e
  if [ "$RC_AG" -ne 2 ] || ! grep -q "$ag_tool is required" <<<"$OUT_AG"; then
    fail "(ag) without $ag_tool DATABASE_SSL resolved to '$OUT_AG' (rc $RC_AG) instead of stopping"
  fi
done
# A quoted value holding its own quote character is named as such, and the remedy warns that double
# quotes expand \n and \r. The other quote style, which the error suggests, archives the configured store.
make_fixture "$AGB/data/o'brien.sqlite" "ag-active"
printf '%s\n' "DATABASE_NAME='./data/o'brien.sqlite'" >"$AGB/.env"
set +e
OUT_AG="$(cd "$AGB" && BACKUP_DIR="$AGB/out" "$BACKUP" 2>&1)"
RC_AG=$?
set -e
if [ "$RC_AG" -eq 0 ] || ! grep -q 'containing its own quote character' <<<"$OUT_AG" ||
  ! grep -q 'turns \\n and \\r into line breaks' <<<"$OUT_AG"; then
  fail "(ag) backup did not stop on a single-quoted value holding a single quote with that cause named (rc $RC_AG): $OUT_AG"
fi
printf '%s\n' "DATABASE_NAME=\"./data/o'brien.sqlite\"" >"$AGB/.env"
(cd "$AGB" && BACKUP_DIR="$AGB/quote-fix" "$BACKUP" >/dev/null 2>&1) || fail "(ag) backup failed with the value in the other quote style"
rm -rf "$AGB/x" "$AGB/data/o'brien.sqlite" && mkdir -p "$AGB/x"
tar -xzf "$(ls "$AGB"/quote-fix/openwa-backup-*.tar.gz)" -C "$AGB/x"
if [ "$(db_fingerprint "$AGB/x/openwa.sqlite")" != "ag-active" ]; then
  fail "(ag) the other quote style archived '$(db_fingerprint "$AGB/x/openwa.sqlite")' instead of the configured data store"
fi
# The Postgres connection keys are resolved where a failure stops the run, before pg_dump starts.
mkdir -p "$AGB/bin"
printf '#!/bin/sh\necho dumped >"%s/pg_dump-ran"\n' "$AGB" >"$AGB/bin/pg_dump"
chmod +x "$AGB/bin/pg_dump"
printf 'DATABASE_TYPE=postgres\nDATABASE_HOST="db.internal" # primary\n' >"$AGB/.env"
set +e
OUT_AG="$(cd "$AGB" && PATH="$AGB/bin:$PATH" BACKUP_DIR="$AGB/out" "$BACKUP" 2>&1)"
RC_AG=$?
set -e
if [ "$RC_AG" -eq 0 ] || [ -e "$AGB/pg_dump-ran" ] || ! grep -q 'sets DATABASE_HOST in a form' <<<"$OUT_AG"; then
  fail "(ag) backup dumped the default Postgres host past an unparsed DATABASE_HOST line (rc $RC_AG): $OUT_AG"
fi
# DATABASE_NAME is the SQLite data store's path or the Postgres database's name, so a line for it the
# scripts cannot parse stops neither a Postgres backup that dumps DATABASE_URL nor the restore of a
# PostgreSQL archive, neither of which reads it.
printf 'DATABASE_TYPE=postgres\nDATABASE_NAME="openwa" # primary\n' >"$AGB/.env"
set +e
OUT_AG="$(cd "$AGB" && PATH="$AGB/bin:$PATH" DATABASE_URL=postgres://db.internal/openwa BACKUP_DIR="$AGB/pg" "$BACKUP" 2>&1)"
RC_AG=$?
set -e
if [ "$RC_AG" -ne 0 ] || [ ! -e "$AGB/pg_dump-ran" ] || ! tar -tzf "$(ls "$AGB"/pg/openwa-backup-*.tar.gz)" | grep -qx './database.sql'; then
  fail "(ag) a Postgres backup through DATABASE_URL stopped on a DATABASE_NAME line it does not use (rc $RC_AG): $OUT_AG"
fi
rm -rf "$AGB/pgdst" && mkdir -p "$AGB/pgdst/data"
printf 'DATABASE_NAME="openwa" # primary\n' >"$AGB/pgdst/.env"
set +e
OUT_AG="$(cd "$AGB/pgdst" && "$RESTORE" "$(ls "$AGB"/pg/openwa-backup-*.tar.gz)" --force 2>&1)"
RC_AG=$?
set -e
if [ "$RC_AG" -ne 0 ] || [ ! -f "$AGB/pgdst/data/database.sql" ] || [ "$(db_fingerprint "$AGB/pgdst/data/main.sqlite")" != "ag-main" ]; then
  fail "(ag) restoring a PostgreSQL archive stopped on a DATABASE_NAME line it does not use (rc $RC_AG): $OUT_AG"
fi
# The remedies the error gives work: the key in the environment wins over the unparsed line, and the
# same quoted value with its comment on its own line parses. Either way the configured store is archived.
AG_LINE='DATABASE_NAME="./data/active.sqlite" # data store'
printf '%s\n' "$AG_LINE" >"$AGB/.env"
(cd "$AGB" && DATABASE_NAME=./data/active.sqlite BACKUP_DIR="$AGB/env-fix" "$BACKUP" >/dev/null 2>&1) ||
  fail "(ag) backup failed with DATABASE_NAME passed in the environment over an unparsed line"
printf '# data store\nDATABASE_NAME="./data/active.sqlite"\n' >"$AGB/.env"
(cd "$AGB" && BACKUP_DIR="$AGB/line-fix" "$BACKUP" >/dev/null 2>&1) || fail "(ag) backup failed with the comment on its own line"
for dir in env-fix line-fix; do
  rm -rf "$AGB/x" && mkdir -p "$AGB/x"
  tar -xzf "$(ls "$AGB/$dir"/openwa-backup-*.tar.gz)" -C "$AGB/x"
  if [ "$(db_fingerprint "$AGB/x/openwa.sqlite")" != "ag-active" ]; then
    fail "(ag) the $dir backup archived '$(db_fingerprint "$AGB/x/openwa.sqlite")' instead of the configured data store"
  fi
done
# A line that only data/.env.generated holds stops the run as well, and so does one in the archive's
# copy, which a restore reads in place of the target's.
rm -f "$AGB/.env"
printf '%s\n' "$AG_LINE" >"$AGB/data/.env.generated"
set +e
OUT_AG="$(cd "$AGB" && BACKUP_DIR="$AGB/out" "$BACKUP" 2>&1)"
RC_AG=$?
set -e
if [ "$RC_AG" -eq 0 ] || [ -n "$(ls "$AGB/out" 2>/dev/null)" ] ||
  ! grep -q '\.env\.generated sets DATABASE_NAME in a form' <<<"$OUT_AG" ||
  ! grep -q 'Move a comment to its own' <<<"$OUT_AG"; then
  fail "(ag) backup did not stop on an unparsed DATABASE_NAME line in data/.env.generated (rc $RC_AG): $OUT_AG"
fi
(cd "$AGB" && DATABASE_NAME=./data/active.sqlite BACKUP_DIR="$AGB/gen" "$BACKUP" >/dev/null 2>&1) ||
  fail "(ag) backup failed with DATABASE_NAME passed in the environment over data/.env.generated"
rm -f "$AGB/data/.env.generated" "$AGB/dst/.env"
set +e
OUT_AG="$(cd "$AGB/dst" && "$RESTORE" "$(ls "$AGB"/gen/openwa-backup-*.tar.gz)" --force 2>&1)"
RC_AG=$?
set -e
if [ "$RC_AG" -eq 0 ] || [ -n "$(ls "$AGB/dst/data")" ] ||
  ! grep -q '\.env\.generated sets DATABASE_NAME in a form' <<<"$OUT_AG"; then
  fail "(ag) restore did not stop on an unparsed DATABASE_NAME line in the archive's .env.generated (rc $RC_AG): $OUT_AG"
fi
if ! grep -q "come from the archive's .env.generated" <<<"$OUT_AG"; then
  fail "(ag) restore did not name the archive's .env.generated as the source of its paths: $OUT_AG"
fi
(cd "$AGB/dst" && DATABASE_NAME=./data/active.sqlite "$RESTORE" "$(ls "$AGB"/gen/openwa-backup-*.tar.gz)" --force >/dev/null 2>&1) ||
  fail "(ag) restore failed with DATABASE_NAME passed in the environment over the archive's .env.generated"
if [ "$(db_fingerprint "$AGB/dst/data/active.sqlite")" != "ag-active" ] || [ -e "$AGB/dst/data/openwa.sqlite" ]; then
  fail "(ag) restore with DATABASE_NAME in the environment did not land on the configured data store only"
fi
pass "(ag) dotenv's quoted, commented and empty forms resolve like the app, and an unparsed line stops both scripts"

echo ""
echo "==> (ah) pg_dump makes the app's TLS check when DATABASE_SSL=true"
# libpq defaults to sslmode=prefer: it falls back to plaintext and takes any certificate, so a dump of
# a database the app reaches over verified TLS sent its password to whoever answered. The shim pg_dump
# records the TLS settings it was started with and whether its root certificate file held any CA.
AH="$WORK/ah"
mkdir -p "$AH/data" "$AH/shim"
make_fixture "$AH/data/main.sqlite" "hotel2-main"
cat >"$AH/shim/pg_dump" <<'SHIM'
#!/bin/sh
certs=none
[ -f "${PGSSLROOTCERT:-}" ] && certs="$(grep -c 'BEGIN CERTIFICATE' "$PGSSLROOTCERT")"
echo "mode=${PGSSLMODE:-} root=${PGSSLROOTCERT:-} certs=$certs" >"$AH_LOG"
echo '-- dump'
SHIM
chmod +x "$AH/shim/pg_dump"
# backup_ah <.env.generated content> [env assignments...]: the TLS settings pg_dump ran with. The
# backup's output is kept in out.log.
backup_ah() {
  printf '%b' "$1" >"$AH/data/.env.generated"
  shift
  rm -rf "$AH/out"
  if ! OUT_AH="$(cd "$AH" && env "$@" AH_LOG="$AH/log" PATH="$AH/shim:$PATH" BACKUP_DIR="$AH/out" \
    "$BACKUP" 2>&1)"; then
    fail "(ah) the backup failed: $OUT_AH"
  fi
  printf '%s\n' "$OUT_AH" >"$AH/out.log"
  cat "$AH/log"
}
PG_AH='DATABASE_TYPE=postgres\n'
if [ "$(backup_ah "$PG_AH")" != "mode= root= certs=none" ]; then
  fail "(ah) pg_dump got TLS settings without DATABASE_SSL: $(cat "$AH/log")"
fi
GOT_AH="$(backup_ah "${PG_AH}DATABASE_SSL=true\n")"
if ! [[ "$GOT_AH" =~ ^mode=verify-full\ root=(/[^ ]+)\ certs=([0-9]+)$ ]]; then
  fail "(ah) DATABASE_SSL=true did not verify the server against a root certificate file: $GOT_AH"
fi
# Node's CA set runs to well over a hundred roots; the file holding it is removed with the staging copy.
if [ "${BASH_REMATCH[2]}" -lt 100 ] || [ -e "${BASH_REMATCH[1]}" ]; then
  fail "(ah) the root certificates were not Node's CA set, or were left behind: $GOT_AH"
fi
if [ "$(backup_ah "${PG_AH}DATABASE_SSL=true\nDATABASE_SSL_REJECT_UNAUTHORIZED=false\n" \
  DATABASE_URL=postgres://openwa@db/openwa)" != "mode=require root= certs=none" ]; then
  fail "(ah) DATABASE_SSL_REJECT_UNAUTHORIZED=false did not encrypt without verifying: $(cat "$AH/log")"
fi
# The app reads a TLS line the scripts cannot parse, so the run stops before pg_dump connects without it.
for check in 'DATABASE_SSL|DATABASE_SSL="true" # tls on\n' \
  'DATABASE_SSL_REJECT_UNAUTHORIZED|DATABASE_SSL=true\nDATABASE_SSL_REJECT_UNAUTHORIZED="false" # x\n'; do
  key="${check%%|*}"
  printf '%b' "${PG_AH}${check#*|}" >"$AH/data/.env.generated"
  rm -rf "$AH/out" "$AH/log"
  set +e
  OUT_AH="$(cd "$AH" && AH_LOG="$AH/log" PATH="$AH/shim:$PATH" BACKUP_DIR="$AH/out" "$BACKUP" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne 2 ] || [ -e "$AH/log" ] || ls "$AH"/out/openwa-backup-* >/dev/null 2>&1 ||
    ! grep -q "sets $key in a form" <<<"$OUT_AH"; then
    fail "(ah) backup ran pg_dump past an unparsed $key line (rc $rc): $OUT_AH"
  fi
done
# A line the run does not read does not stop it: DATABASE_SSL under PGSSLMODE, the second key when
# the first is false.
if [ "$(backup_ah "${PG_AH}DATABASE_SSL=\"true\" # tls on\n" PGSSLMODE=require)" != "mode=require root= certs=none" ] ||
  [ "$(backup_ah "${PG_AH}DATABASE_SSL=false\nDATABASE_SSL_REJECT_UNAUTHORIZED=\"false\" # x\n")" != "mode= root= certs=none" ]; then
  fail "(ah) an unparsed TLS line the run does not read stopped the backup: $(cat "$AH/log")"
fi
if [ "$(backup_ah "${PG_AH}DATABASE_SSL=true\n" PGSSLROOTCERT="$AH/ca.pem")" != \
  "mode=verify-full root=$AH/ca.pem certs=none" ] ||
  [ "$(backup_ah "${PG_AH}DATABASE_SSL=true\n" PGSSLMODE=verify-ca)" != "mode=verify-ca root= certs=none" ]; then
  fail "(ah) an operator's PGSSLROOTCERT or PGSSLMODE was not honoured: $(cat "$AH/log")"
fi
# Without node there is no CA set to write: libpq's system store is used, and the log says what it needs.
mkdir -p "$AH/nonode"
populate_shim "$AH/nonode"
ln -sf "$(command -v tail)" "$AH/nonode/tail"
ln -sf "$AH/shim/pg_dump" "$AH/nonode/pg_dump"
if [ "$(PATH="$AH/nonode" backup_ah "${PG_AH}DATABASE_SSL=true\n")" != "mode=verify-full root=system certs=none" ] ||
  ! grep -q 'node not found.*sslrootcert=system.*libpq 16+' "$AH/out.log"; then
  fail "(ah) without node the system CA store was not used, or the log gave no hint: $(cat "$AH/out.log")"
fi
pass "(ah) pg_dump verifies the server under DATABASE_SSL=true and is unchanged without it"
echo "==> (ai) ./data defaults and paths follow OPENWA_DATA_DIR in a run on the host"
# The app writes STORAGE_LOCAL_PATH=./data/media on first run, and a dashboard save adds
# SESSION_DATA_PATH=./data/sessions, both relative to /app in the image, where the databases default to
# ./data too and compose hands ./.env's PLUGINS_DIR=./data/plugins (as .env.example sets it) to the
# app. Run on the host with OPENWA_DATA_DIR at the volume's mountpoint, the scripts read these
# against the host's working directory: the backup took a stale ./data there, or left the volume's
# state out, and exited 0, and the restore put it where the app never reads it.
AI="$WORK/ai"
mkdir -p "$AI/vol/media" "$AI/vol/sessions/session-1" "$AI/vol/plugins/p1" "$AI/host/data/media" \
  "$AI/host/data/plugins/stale" "$AI/vol2" "$AI/x"
make_fixture "$AI/vol/main.sqlite" "ai-main"
make_fixture "$AI/vol/openwa.sqlite" "ai-data"
make_fixture "$AI/host/data/main.sqlite" "ai-stale-main"
make_fixture "$AI/host/data/openwa.sqlite" "ai-stale-data"
printf 'ai-media\n' >"$AI/vol/media/a.jpg"
printf 'ai-session\n' >"$AI/vol/sessions/session-1/marker"
printf '{}\n' >"$AI/vol/plugins/p1/manifest.json"
printf 'host-stale\n' >"$AI/host/data/media/stale.jpg"
printf '{}\n' >"$AI/host/data/plugins/stale/manifest.json"
printf 'PLUGINS_DIR=./data/plugins\n' >"$AI/host/.env"
# What the app writes: no database path, so the databases take their ./data defaults.
printf '%s\n' DATABASE_TYPE=sqlite STORAGE_LOCAL_PATH=./data/media SESSION_DATA_PATH=./data/sessions \
  >"$AI/vol/.env.generated"
(cd "$AI/host" && OPENWA_DATA_DIR="$AI/vol" BACKUP_DIR="$AI/out" "$BACKUP" >/dev/null 2>&1) ||
  fail "(ai) backup from the host failed"
ARCHIVE_AI="$(ls "$AI"/out/openwa-backup-*.tar.gz)"
tar -xzf "$ARCHIVE_AI" -C "$AI/x"
if [ "$(db_fingerprint "$AI/x/main.sqlite")" != "ai-main" ] ||
  [ "$(db_fingerprint "$AI/x/openwa.sqlite")" != "ai-data" ]; then
  fail "(ai) backup did not archive the volume's databases"
fi
if [ "$(cat "$AI/x/media/a.jpg" 2>/dev/null || true)" != "ai-media" ] || [ -e "$AI/x/media/stale.jpg" ]; then
  fail "(ai) backup did not archive the volume's media: $(find "$AI/x/media" 2>&1 | tr '\n' ' ')"
fi
if [ "$(cat "$AI/x/sessions/session-1/marker" 2>/dev/null || true)" != "ai-session" ]; then
  fail "(ai) backup did not archive the volume's sessions"
fi
if [ ! -f "$AI/x/plugin-packages/p1/manifest.json" ] || [ -e "$AI/x/plugin-packages/stale" ]; then
  fail "(ai) backup did not archive the volume's plugins: $(find "$AI/x/plugin-packages" 2>&1 | tr '\n' ' ')"
fi
(cd "$AI/host" && OPENWA_DATA_DIR="$AI/vol2" "$RESTORE" "$ARCHIVE_AI" >/dev/null 2>&1) ||
  fail "(ai) restore from the host failed"
if [ "$(cat "$AI/vol2/media/a.jpg" 2>/dev/null || true)" != "ai-media" ] ||
  [ "$(cat "$AI/vol2/sessions/session-1/marker" 2>/dev/null || true)" != "ai-session" ] ||
  [ "$(db_fingerprint "$AI/vol2/main.sqlite" 2>/dev/null || true)" != "ai-main" ] ||
  [ "$(db_fingerprint "$AI/vol2/openwa.sqlite" 2>/dev/null || true)" != "ai-data" ] ||
  [ ! -f "$AI/vol2/plugins/p1/manifest.json" ]; then
  fail "(ai) restore did not put media, sessions, plugins and databases in the volume"
fi
if [ "$(db_fingerprint "$AI/host/data/main.sqlite")" != "ai-stale-main" ] ||
  [ "$(db_fingerprint "$AI/host/data/openwa.sqlite")" != "ai-stale-data" ] ||
  [ "$(cd "$AI/host/data" && find . -mindepth 1 -maxdepth 1 | LC_ALL=C sort | tr '\n' ' ')" != \
    "./main.sqlite ./media ./openwa.sqlite ./plugins " ] ||
  [ "$(ls -A "$AI/host/data/media")" != stale.jpg ] || [ "$(ls -A "$AI/host/data/plugins")" != stale ]; then
  fail "(ai) restore wrote into the host's working directory: $(find "$AI/host/data" | tr '\n' ' ')"
fi
# A ./data path passed in the environment is the caller's own and is read against the working directory.
mkdir -p "$AI/host/data/sessions/session-1"
printf 'ai-host-session\n' >"$AI/host/data/sessions/session-1/marker"
(cd "$AI/host" && OPENWA_DATA_DIR="$AI/vol" SESSION_DATA_PATH=./data/sessions BACKUP_DIR="$AI/out-env" \
  "$BACKUP" >/dev/null 2>&1) || fail "(ai) backup with SESSION_DATA_PATH in the environment failed"
if [ "$(tar -xzOf "$(ls "$AI"/out-env/openwa-backup-*.tar.gz)" ./sessions/session-1/marker)" != "ai-host-session" ]; then
  fail "(ai) a ./data path from the environment was taken under OPENWA_DATA_DIR"
fi
# A leftover ./uploads falls back to the volume's media as well, not to the host's ./data/media.
printf 'STORAGE_LOCAL_PATH=./uploads\n' >"$AI/vol/.env.generated"
(cd "$AI/host" && OPENWA_DATA_DIR="$AI/vol" BACKUP_DIR="$AI/out-uploads" "$BACKUP" >/dev/null 2>&1) ||
  fail "(ai) backup with a leftover ./uploads failed"
if ! tar -tzf "$(ls "$AI"/out-uploads/openwa-backup-*.tar.gz)" | grep -qx './media/a.jpg'; then
  fail "(ai) a leftover ./uploads did not fall back to the volume's media"
fi
# Only path settings are mapped: a dashboard-provisioned Postgres named, owned or reached as "data", or
# a password under "data/", reaches pg_dump as written, with the default data dir too.
mkdir -p "$AI/pg/data" "$AI/pg/bin"
make_fixture "$AI/pg/data/main.sqlite" "ai-pg-main"
cat >"$AI/pg/bin/pg_dump" <<EOF
#!/bin/sh
printf '%s|' "\$PGPASSWORD" "\$@" >"$AI/pg/pg_dump-args"
EOF
chmod +x "$AI/pg/bin/pg_dump"
printf 'DATABASE_TYPE=postgres\nDATABASE_HOST=data\nDATABASE_USERNAME=data\nDATABASE_PASSWORD=data/s3cret\nDATABASE_NAME=data\n' \
  >"$AI/pg/data/.env.generated"
(cd "$AI/pg" && PATH="$AI/pg/bin:$PATH" BACKUP_DIR="$AI/pg/out" "$BACKUP" >/dev/null 2>&1) ||
  fail "(ai) Postgres backup with settings named data failed"
if [ "$(cat "$AI/pg/pg_dump-args" 2>/dev/null || true)" != "data/s3cret|-h|data|-p|5432|-U|data|data|" ]; then
  fail "(ai) Postgres settings from .env.generated were rewritten: $(cat "$AI/pg/pg_dump-args" 2>&1)"
fi
pass "(ai) a host run backs up and restores the volume's databases, media, sessions and plugins, not the working directory's"

echo ""
echo "All smoke tests passed!"
