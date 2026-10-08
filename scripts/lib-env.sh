#!/usr/bin/env bash
# shellcheck shell=bash
#
# Shared configuration resolution for backup.sh and restore.sh.
#
# The application fills its configuration from three layers (src/config/load-env.ts), each supplying
# only what the previous one left unset:
#
#   1. the process environment
#   2. ./.env
#   3. <data dir>/.env.generated   — written by Dashboard > Infrastructure
#
# These scripts used to read layer 1 only, so an install configured through the dashboard was backed
# up at the DEFAULT paths. That is not reliably loud: a missing database fails the run, but a
# database left at a default path from BEFORE the operator switched is archived instead, and the run
# exits 0. A backup that captured an abandoned database only reveals itself during a restore.
#
# Deliberately conservative: only the `KEY=value` forms dotenv reads plainly are honoured. Blanks
# around the `=` and the value, CRLF line endings, a value wrapped in one pair of quotes and a comment
# after an unquoted value are read as dotenv reads them. Anything else (a quoted value followed by a
# comment, containing its own quote character or ending in a backslash, a double-quoted value with
# escapes, a `KEY: value` line, a bare CR, U+2028 or U+2029 on a line naming the key, a NUL or byte
# that is not UTF-8 on its line, a byte-order mark or Unicode blank next to the key, its `=` or the
# ends of its value, a bare `NAME:` line just before it, a bare `KEY` or an empty `KEY=` the app
# completes from a later line) stops the run rather than being guessed at: the app still reads such a
# line, so neither a guess nor the default is safe to back up or restore to, and a silently
# mis-resolved path is the exact failure this exists to prevent. The file is still read line by line:
# a line for the key inside a quoted value that spans lines, whether another key's or an earlier one
# of the same key, is taken as a setting, although the app reads it as part of that value. Nothing
# here exports anything: each key is looked up by name, so a stray entry in an operator's .env can
# never reach the script's own environment.

# openwa_env_file_value <file> <key> - print the value from one env-file layer. Returns 1 when the layer
# does not set the key and 2 when it may set it in a form rejected below; a blank value succeeds and
# prints nothing.
openwa_env_file_value() {
  local file="$1" key="$2" line match value n next
  local keyline="^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*([=:]|\$)"
  # The code points beyond ASCII that dotenv's \s matches: the Unicode blanks and the byte-order mark.
  local blank=$'\xc2\xa0|\xe1\x9a\x80|\xe2\x80[\x80-\x8a\xa8\xa9\xaf]|\xe2\x81\x9f|\xe3\x80\x80|\xef\xbb\xbf'
  # A line of well-formed UTF-8, without NUL.
  local utf8=$'([\x01-\x7f]|[\xc2-\xdf][\x80-\xbf]|\xe0[\xa0-\xbf][\x80-\xbf]|[\xe1-\xec\xee\xef][\x80-\xbf]{2}|\xed[\x80-\x9f][\x80-\xbf]|\xf0[\x90-\xbf][\x80-\xbf]{2}|[\xf1-\xf3][\x80-\xbf]{3}|\xf4[\x80-\x8f][\x80-\xbf]{2})*'
  [ -f "$file" ] || return 1
  # dotenv also takes a byte-order mark or a Unicode blank (a no-break space, say) for whitespace and a
  # bare CR, U+2028 or U+2029 for a line break, and decodes the file as UTF-8, so a byte that is not UTF-8
  # reaches the app as U+FFFD. grep and the trims below do none of that, so the key could be missed or
  # read with other bytes. Such a line break on any line naming the key, comments included, is rejected,
  # and so is a line setting the key with a blank before the key, around its `=` or at either end of an
  # unquoted value, or with a NUL or a byte that is not UTF-8 anywhere. Every grep here runs with -a in
  # the C locale: otherwise a NUL anywhere in the file, or a byte that is not UTF-8 in a UTF-8 locale, can
  # hide the key's line. A NUL, which bash would drop from the line, becomes \377.
  line="$(LC_ALL=C tr '\000' '\377' 2>/dev/null <"$file" | LC_ALL=C grep -aE "(^|[^A-Za-z0-9_.-])${key}([^A-Za-z0-9_.-]|\$)")" || true
  if ! LC_ALL=C grep -qE $'\r.|\xe2\x80[\xa8\xa9]' <<<"$line"; then
    line="$(LC_ALL=C grep -aE "^([[:space:]]|$blank)*(export([[:space:]]|$blank)+)?${key}([[:space:]]|$blank)*([=:]|\$)" <<<"$line")" || true
    [ -z "$line" ] || LC_ALL=C grep -qvE "$keyline" <<<"$line" ||
      LC_ALL=C grep -qE "^[^=:]*[=:][[:space:]]*($blank)|^[^#]*($blank)[[:space:]]*(#|\$)" <<<"$line" ||
      LC_ALL=C grep -qvxE "$utf8" <<<"$line" || line=""
  fi
  if [ -n "$line" ]; then
    echo "[config] ERROR: $file has a bare CR, U+2028 or U+2029 on a line naming $key, a NUL or a byte that is" >&2
    echo "[config]        not UTF-8 on a line setting it, or a byte-order mark or Unicode blank next to $key, its =" >&2
    echo "[config]        or the ends of its value. Save it as UTF-8 with plain ASCII blanks and LF or CRLF line" >&2
    echo "[config]        ends, or pass $key in the environment." >&2
    return 2
  fi
  # dotenv reads the line after a bare `NAME:` line as NAME's value, so a line for the key right there
  # does not set the key for the app, although the scripts would read it. dotenv also starts a line
  # after a bare CR, U+2028 or U+2029, so `# note<U+2028>NAME:` is such a line too.
  line="$(LC_ALL=C tr '\000' '\377' 2>/dev/null <"$file" | LC_ALL=C grep -aB1 -E "$keyline")" || true
  if LC_ALL=C grep -qE "(^|"$'\r|\xe2\x80[\xa8\xa9]'")([[:space:]]|$blank)*(export([[:space:]]|$blank)+)?[A-Za-z0-9_.-]+:"$'\r'"?\$" <<<"$line"; then
    echo "[config] ERROR: $file has a bare NAME: line just before a line setting $key, which the app reads as" >&2
    echo "[config]        NAME's value instead. Give NAME: a value or remove it, or pass $key in the environment." >&2
    return 2
  fi
  # The last line naming the key wins, as in dotenv. `KEY: value` is matched only so that it stops the
  # run. dotenv skips a bare `KEY` line (`export KEY`, say), unless the next line that is not blank
  # starts with `=`: its `KEY\s*=` crosses line breaks, so that pair sets the key and stops the run too.
  line=""
  while IFS= read -r match; do
    value="${match#*"$key"}"
    if [ -z "${value//[[:space:]]/}" ]; then
      next="$(LC_ALL=C tail -n +"$((${match%%:*} + 1))" "$file" | LC_ALL=C tr '\000' '\377' |
        LC_ALL=C grep -avE -m 1 "^([[:space:]]|$blank)*\$")" || true
      LC_ALL=C grep -qE "^([[:space:]]|$blank)*=" <<<"$next" || continue
    fi
    line="$match"
  done < <(LC_ALL=C grep -anE "$keyline" "$file" 2>/dev/null)
  [ -n "$line" ] || return 1
  n="${line%%:*}"
  line="${line#*:}"
  value="${line#*"$key"}"
  value="${value#"${value%%[![:space:]]*}"}"
  case "$value" in
    '')
      echo "[config] ERROR: $file names $key on a line without an =, which the app pairs with the = that starts" >&2
      echo "[config]        a later line. Write $key=value on one line, or pass $key in the environment." >&2
      return 2
      ;;
    =*)
      value="${value#=}"
      # Trim both ends, which also drops the CR of a CRLF line.
      value="${value#"${value%%[![:space:]]*}"}"
      value="${value%"${value##*[![:space:]]}"}"
      case "$value" in
        \"*\\*) ;; # dotenv expands \n and \r inside double quotes
        \'*\\\' | \`*\\\`) ;; # dotenv may take the backslash and quote for an escaped quote and read on
        \"*\" | \'*\' | \`*\`)
          # A quote inside means the pair does not wrap the whole value: a comment ending in one follows it.
          case "${value:1:${#value}-2}" in
            *"${value:0:1}"*) ;;
            *)
              printf '%s' "${value:1:${#value}-2}"
              return 0
              ;;
          esac
          ;;
        \"* | \'* | \`*) ;; # the quote does not close the value, as with a trailing comment
        '')
          # dotenv takes a quoted value that starts on a later line, past blank lines, as this key's.
          next="$(LC_ALL=C tail -n +"$((n + 1))" "$file" | LC_ALL=C tr '\000' '\377' |
            LC_ALL=C grep -avE -m 1 "^([[:space:]]|$blank)*\$")" || true
          if LC_ALL=C grep -qE "^([[:space:]]|$blank)*[\"'\`]" <<<"$next"; then
            echo "[config] ERROR: $file leaves $key empty on its line and starts a quoted value on a later line," >&2
            echo "[config]        which the app can read as $key's value. Write $key=value on one line, or pass $key in the" >&2
            echo "[config]        environment." >&2
            return 2
          fi
          return 0
          ;;
        *)
          # An unquoted value ends at a `#`, as in dotenv.
          value="${value%%#*}"
          printf '%s' "${value%"${value##*[![:space:]]}"}"
          return 0
          ;;
      esac
      ;;
  esac
  echo "[config] ERROR: $file sets $key in a form these scripts do not parse: a quoted value followed by a" >&2
  echo "[config]        comment or not closed on its line, a quoted value containing its own quote character or" >&2
  echo "[config]        ending in a backslash, a double-quoted value with a backslash, or KEY: value." >&2
  echo "[config]        Move a comment to its own line and keep the quotes, close the quote on the same line, wrap a" >&2
  echo "[config]        value in a quote character it does not contain, single-quote a value whose backslashes are" >&2
  printf '%s\n' "[config]        literal and not at its end (inside double quotes the app turns \\n and \\r into line breaks)," >&2
  echo "[config]        write $key=value for $key: value, or pass $key in the environment." >&2
  return 2
}

# openwa_writable <path> - whether <path> can be written, or created when it does not exist yet (its
# nearest existing ancestor is then the directory that has to take it).
openwa_writable() {
  local p="$1"
  if [ -e "$p" ]; then
    [ -w "$p" ]
    return
  fi
  while [ ! -e "$p" ]; do p="$(dirname "$p")"; done
  [ -d "$p" ] && [ -w "$p" ]
}

# openwa_media_dir - STORAGE_LOCAL_PATH as the app settles it (src/config/storage-root.ts). v0.2.0 to
# v0.7.3 persisted ./uploads into .env.generated; where that cannot be created, as under the image's
# root-owned /app, the app keeps media in ./data/media (<data dir>/media) instead, so the scripts have
# to look there too. Writability alone cannot tell: `docker exec` runs these as root, which can create
# /app/uploads while the app's own user cannot. The app creates a ./uploads it uses at boot, so a
# missing one beside an existing <data dir>/media means that one is in use.
openwa_media_dir() {
  local dir
  dir="$(openwa_resolve STORAGE_LOCAL_PATH "$DATA_DIR/media" path)" || return
  case "$dir" in
    ./uploads | uploads)
      if ! openwa_writable "$dir" || { [ ! -d "$dir" ] && [ -d "$DATA_DIR/media" ]; }; then
        echo "[config] WARN: STORAGE_LOCAL_PATH=$dir is a leftover the app does not use here, so it keeps" >&2
        echo "[config]       media in ./data/media; using $DATA_DIR/media. Remove the line from .env.generated." >&2
        dir="$DATA_DIR/media"
      fi
      ;;
  esac
  printf '%s' "$dir"
}

# Layer 3. Set here rather than read from the environment, so it can never arrive from an operator's
# shell; restore.sh points it at the archive's copy, which replaces this file during the restore.
OPENWA_GENERATED_ENV="${DATA_DIR:-./data}/.env.generated"

# openwa_resolve <key> <default> [path] - the application's precedence: environment, then ./.env,
# then $OPENWA_GENERATED_ENV, then the built-in default. Requires DATA_DIR to be set before sourcing.
# With a third argument of `path`, the value names a filesystem path: the app reads .env.generated as
# ./data/.env.generated, so a ./data or ./data/... value there names a path in the data dir and is
# taken under DATA_DIR, which on the host is the volume's mountpoint rather than the working
# directory's ./data. Other keys (a PostgreSQL name, user or password) are returned as written.
# Fails, printing nothing, when a layer sets the key in a form openwa_env_file_value rejects. Callers
# must act on that status: set -e does for a top-level assignment, but not inside a function called
# from a command substitution or for a substitution in a command's arguments.
openwa_resolve() {
  local key="$1" fallback="$2" kind="${3:-}" current value layer rc
  current="$(printenv "$key" 2>/dev/null || true)"
  if [ -n "$current" ]; then
    printf '%s' "$current"
    return 0
  fi
  # The first layer that sets the key ends the lookup, even with a blank value: dotenv sets a blank
  # line to '' and never overwrites a key already set, so the app reads its built-in default. A line
  # these scripts cannot parse still sets the key for the app, so it fails the lookup instead.
  for layer in "./.env" "$OPENWA_GENERATED_ENV"; do
    rc=0
    value="$(openwa_env_file_value "$layer" "$key")" || rc=$?
    case "$rc" in
      0)
        if [ "$kind" = path ] && [ "$layer" = "$OPENWA_GENERATED_ENV" ]; then
          case "$value" in
            ./data | data) value="$DATA_DIR" ;;
            ./data/* | data/*) value="${DATA_DIR%/}/${value#*data/}" ;;
          esac
        fi
        printf '%s' "${value:-$fallback}"
        return 0
        ;;
      2) return 2 ;;
    esac
  done
  printf '%s' "$fallback"
}
