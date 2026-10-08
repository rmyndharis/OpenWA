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
# after an unquoted value are read as dotenv reads them. As in dotenv, the last line setting the key
# wins, so only that line is checked. Anything else (a quoted value followed by a comment, containing
# its own quote character or ending in a backslash the app can read on past to a later quote, a
# double-quoted value with escapes, a `KEY: value` or `KEY:value` line, a bare CR, U+2028 or U+2029 on
# any line naming the key, a NUL or byte that is not UTF-8 on its line, a byte-order mark or Unicode
# blank next to the key, its `=`, the ends of an unquoted value or a closing quote, a bare `NAME:` line
# just before it, a bare `KEY` or an empty `KEY=` the app completes from a later line) stops the run
# rather than being guessed at: the app still reads such a line, so neither a guess nor the default is
# safe to back up or restore to, and a silently mis-resolved path is the exact failure this exists to
# prevent. So does a quoted value opened on an earlier line, the key's own or another key's, that the
# app can read on to the key's line, where lines break as the app breaks them: at a bare CR, and at
# U+2028 or U+2029 outside an unquoted value. Nothing here exports anything: each key is looked up by
# name, so a stray entry in an operator's .env can never reach the script's own environment.

# openwa_env_lines - copy stdin with a line break wherever dotenv starts a line: at a bare CR, and at
# U+2028 or U+2029 unless an unquoted value without a `#` runs on past it. Each added line starts with
# the CR or a U+2028, which the patterns read as a blank, and CRLF line ends lose their CR. It also
# splits inside a quoted value, and after a stray quote in an unquoted one; openwa_env_opener skips
# the lines that adds inside a value.
openwa_env_lines() (
  export LC_ALL=C
  local line seg a b cr=$'\r' ls=$'\xe2\x80\xa8'
  local setting='^(export[[:space:]]+)?[A-Za-z0-9_.-]+([[:space:]]*=|:$|:[[:space:]])(.*)$'
  sed -e $'s/\r$//' -e $'s/\xe2\x80\xa9/\xe2\x80\xa8/g' | while IFS= read -r line || [ -n "$line" ]; do
    seg=""
    while :; do
      a="${line%%"$cr"*}"
      b="${line%%"$ls"*}"
      [ "${#a}" -lt "${#line}" ] || [ "${#b}" -lt "${#line}" ] || break
      if [ "${#a}" -lt "${#b}" ]; then
        printf '%s\n' "$seg$a"
        seg="$cr"
        line="${line:${#a}+1}"
        continue
      fi
      seg="$seg$b"
      line="${line:${#b}+3}"
      a="${seg#"$cr"}"
      a="${a#"$ls"}"
      a="${a#"${a%%[![:space:]]*}"}"
      if [[ $a =~ $setting ]] && [[ ${BASH_REMATCH[3]} != *[#\'\"\`]* ]]; then
        seg="$seg$ls"
        continue
      fi
      printf '%s\n' "$seg"
      seg="$ls"
    done
    printf '%s\n' "$seg$line"
  done
)

# openwa_env_opener <s> <closes> - read the lines before the key's line, split by openwa_env_lines, and
# print the number of the one that opens a quoted value dotenv reads on to the key's line. <s> matches
# one blank; <closes> lists the quote characters that a quote on or after the key's line, up to the
# first such quote without a backslash before it, can close a value with: one only blanks or a comment
# follow. The lines are read in order, as dotenv reads them, so a line inside a value opens nothing.
# A quote opens a value after `NAME=` or `NAME: `, after a bare `NAME` and an `=` on the next line that
# is not blank, or at the start of the line after a bare `NAME:` or of a line after an empty `NAME=` or
# `NAME:` or a bare `NAME` and a lone `=`, past blank lines. The value ends at the last quote that only
# blanks or a comment follow, up to the first quote without a backslash; with none, dotenv reads the
# line after `NAME=`, `NAME: ` or a bare `NAME:` as an unquoted value, which runs on past a U+2028 or
# U+2029 until a `#`, and any other line as no setting at all.
openwa_env_opener() (
  local LC_ALL=C
  local s="$1" closes="$2" l v r q c i=0 j n e u kind last prior open closer ls=$'\xe2\x80\xa8'
  local set="^$s*(export$s+)?[A-Za-z0-9_.-]+($s*=|:$s)" colon="^$s*(export$s+)?[A-Za-z0-9_.-]+:\$"
  local bare="^$s*(export$s+)?[A-Za-z0-9_.-]+$s*\$" empty="^$s*(export$s+)?[A-Za-z0-9_.-]+($s*=|:)$s*\$"
  local blankline="^$s*\$" eq="^$s*=" lone="^$s*=$s*\$" quote="^$s*[=\"'\`]"
  # after[i]: line i is the value of a bare `NAME:` line before it. free[i]: dotenv starts reading at
  # line i, which is not inside a value.
  local -a lines after free
  while IFS= read -r l; do
    i=$((i + 1))
    lines[i]="$l"
  done
  n=$i
  i=1
  while [ "$i" -le "$n" ]; do
    l="${lines[i]}"
    free[i]=1
    # A line without a quote opens nothing; only a bare `NAME:` line, the value of one, or a value that
    # runs on past a U+2028 needs the checks below.
    case "$l" in
      *[\"\'\`]* | *:) ;;
      *)
        if [ -z "${after[i]:-}" ] && [[ ${lines[i + 1]:-} != "$ls"* ]]; then
          i=$((i + 1))
          continue
        fi
        ;;
    esac
    kind=""
    v="$l"
    if [ -n "${after[i]:-}" ]; then
      kind=value
    elif [[ $l =~ $set ]]; then
      kind=value
      v="${l#*[=:]}"
    elif [[ $l =~ $colon ]]; then
      after[i + 1]=1
    elif [[ $l =~ $quote ]]; then
      # The two lines before it that are not blank, which have to start its value.
      j=$i last="" prior=""
      while [ "$j" -gt 1 ]; do
        j=$((j - 1))
        [[ ! ${lines[j]} =~ $blankline ]] || continue
        [ -z "$last" ] || { prior=$j && break; }
        last=$j
      done
      if [ -z "$last" ] || [ -z "${free[last]:-}" ] || [ -n "${after[last]:-}" ]; then
        :
      elif [[ $l =~ $eq ]]; then
        if [[ ${lines[last]} =~ $bare ]]; then
          kind=value
          v="${l#*=}"
        fi
      elif [[ ${lines[last]} =~ $lone ]]; then
        if [ -n "$prior" ] && [ -n "${free[prior]:-}" ] && [ -z "${after[prior]:-}" ] && [[ ${lines[prior]} =~ $bare ]]; then
          kind=quoted
        fi
      elif [[ ${lines[last]} =~ $empty ]]; then
        kind=quoted
      fi
    fi
    if [ -z "$kind" ]; then
      i=$((i + 1))
      continue
    fi
    q=""
    for c in "'" '"' '`'; do
      open="^$s*$c"
      if [[ $v =~ $open ]]; then q="$c" && break; fi
    done
    if [ -n "$q" ]; then
      open="(^|[^\\\\])$q"
      closer="^([^$q]|\\\\$q)*$q$s*(#.*)?\$"
      r="${v#*"$q"}"
      e=""
      if [[ $r =~ $open ]]; then
        [[ ! $r =~ $closer ]] || e=$i
      else
        j=$i u=""
        while [ "$j" -lt "$n" ]; do
          j=$((j + 1))
          [[ ! ${lines[j]} =~ $closer ]] || e=$j
          if [[ ${lines[j]} =~ $open ]]; then u=$j && break; fi
        done
        if [ -z "$u" ] && [[ $closes == *"$q"* ]]; then
          printf '%s' "$i"
          return 0
        fi
        [ -n "$e" ] || [[ ! $r =~ $closer ]] || e=$i
      fi
      if [ -n "$e" ]; then
        i=$((e + 1))
        continue
      fi
      if [ "$kind" = quoted ]; then
        i=$((i + 1))
        continue
      fi
    fi
    # An unquoted value, which runs on past a U+2028 or U+2029 up to a `#`.
    i=$((i + 1))
    while [ "$i" -le "$n" ] && [[ $v != *'#'* ]] && [[ ${lines[i]} == "$ls"* ]]; do
      v="${lines[i]}"
      i=$((i + 1))
    done
  done
)

# openwa_env_file_value <file> <key> - print the value from one env-file layer. Returns 1 when the layer
# does not set the key and 2 when it may set it in a form rejected below; a blank value succeeds and
# prints nothing.
openwa_env_file_value() {
  local file="$1" key="$2" line match value n next prev rest tool q o closes bad=""
  # The trims below take only ASCII blanks whatever the operator's locale, so a Unicode blank after a
  # closing quote stops the run on every host.
  local LC_ALL=C
  # The code points beyond ASCII that dotenv's \s matches: the Unicode blanks and the byte-order mark.
  local blank=$'\xc2\xa0|\xe1\x9a\x80|\xe2\x80[\x80-\x8a\xa8\xa9\xaf]|\xe2\x81\x9f|\xe3\x80\x80|\xef\xbb\xbf'
  local s="([[:space:]]|$blank)"
  # A line dotenv or Docker Compose may read as setting the key: `KEY=`, `KEY:` or a bare `KEY`.
  # dotenv skips `KEY:value`, but Compose interpolates ./.env into the container and reads it as a
  # setting, so that line stops the run too.
  local keyline="^$s*(export$s+)?${key}$s*([=:]|\$)"
  # A line of well-formed UTF-8, without NUL.
  local utf8=$'([\x01-\x7f]|[\xc2-\xdf][\x80-\xbf]|\xe0[\xa0-\xbf][\x80-\xbf]|[\xe1-\xec\xee\xef][\x80-\xbf]{2}|\xed[\x80-\x9f][\x80-\xbf]|\xf0[\x90-\xbf][\x80-\xbf]{2}|[\xf1-\xf3][\x80-\xbf]{3}|\xf4[\x80-\x8f][\x80-\xbf]{2})*'
  [ -f "$file" ] || return 1
  # Without these the key's line would read as absent and the lookup would fall through to a default.
  for tool in tr tail sed grep; do
    command -v "$tool" >/dev/null 2>&1 && continue
    echo "[config] ERROR: $tool is required to read $file; install it or pass $key in the environment." >&2
    return 2
  done
  # dotenv takes a bare CR for a line break and can start a setting right after U+2028 or U+2029 (after
  # a comment or a quoted value, say), so a line grep sees can hold the key's setting in its middle.
  # Such a character on any line naming the key, comments included, is rejected. Every grep here runs
  # with -a in the C locale: otherwise a NUL anywhere in the file, or a byte that is not UTF-8 in a
  # UTF-8 locale, can hide the key's line. A NUL, which bash would drop from the line, becomes \377.
  line="$(LC_ALL=C tr '\000' '\377' 2>/dev/null <"$file" | LC_ALL=C grep -aE "(^|[^A-Za-z0-9_.-])${key}([^A-Za-z0-9_.-]|\$)")" || true
  if LC_ALL=C grep -qE $'\r.|\xe2\x80[\xa8\xa9]' <<<"$line"; then bad=1; fi
  # The last line setting the key wins, as in dotenv, so only that one is checked below. `KEY: value`
  # and `KEY:value` are matched only so that they stop the run. dotenv skips a bare `KEY` line (`export
  # KEY`, say), unless the next line that is not blank starts with `=`: its `KEY\s*=` crosses line
  # breaks, so that pair sets the key and stops the run too.
  line=""
  while IFS= read -r match; do
    value="${match#*"$key"}"
    if LC_ALL=C grep -qxE "$s*" <<<"$value"; then
      next="$(LC_ALL=C tail -n +"$((${match%%:*} + 1))" "$file" | LC_ALL=C tr '\000' '\377' |
        LC_ALL=C grep -avE -m 1 "^$s*\$")" || true
      LC_ALL=C grep -qE "^$s*=" <<<"$next" || continue
    fi
    line="$match"
  done < <(LC_ALL=C tr '\000' '\377' 2>/dev/null <"$file" | LC_ALL=C grep -anE "$keyline")
  [ -n "$line$bad" ] || return 1
  n="${line%%:*}"
  line="${line#*:}"
  # dotenv also takes a byte-order mark or a Unicode blank (a no-break space, say) for whitespace and
  # decodes the file as UTF-8, so a byte that is not UTF-8 reaches the app as U+FFFD. grep and the trims
  # below do neither, so the line is rejected with such a blank before the key, around its `=`, or at
  # either end of an unquoted value (a quoted value keeps its blanks), or with a NUL or a byte that is
  # not UTF-8 anywhere.
  if [ -n "$bad" ] || ! LC_ALL=C grep -qE "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*([=:]|\$)" <<<"$line" ||
    LC_ALL=C grep -qE "^[^=:]*[=:][[:space:]]*($blank)|^[^=:]*[=:][[:space:]]*([^\"'\`[:space:]#][^#]*)?($blank)[[:space:]]*(#|\$)" <<<"$line" ||
    LC_ALL=C grep -qvxE "$utf8" <<<"$line"; then
    echo "[config] ERROR: $file has a bare CR, U+2028 or U+2029 on a line naming $key, a NUL or a byte that is" >&2
    echo "[config]        not UTF-8 on the line setting it, or a byte-order mark or Unicode blank next to $key, its =" >&2
    echo "[config]        or the ends of its unquoted value. Save it as UTF-8 with plain ASCII blanks and LF or CRLF" >&2
    echo "[config]        line ends, or pass $key in the environment." >&2
    return 2
  fi
  # dotenv reads the line after a bare `NAME:` line as NAME's value, so the key's line right there does
  # not set the key for the app, although the scripts would read it. dotenv can also start a setting
  # after a bare CR, U+2028 or U+2029, so `# note<U+2028>NAME:` is such a line too.
  prev=""
  [ "$n" -le 1 ] || prev="$(LC_ALL=C tr '\000' '\377' 2>/dev/null <"$file" | LC_ALL=C sed -n "$((n - 1))p")"
  if LC_ALL=C grep -qE "(^|"$'\r|\xe2\x80[\xa8\xa9]'")$s*(export$s+)?[A-Za-z0-9_.-]+:"$'\r'"?\$" <<<"$prev"; then
    echo "[config] ERROR: $file has a bare NAME: line just before a line setting $key, which the app reads as" >&2
    echo "[config]        NAME's value instead. Give NAME: a value or remove it, or pass $key in the environment." >&2
    return 2
  fi
  # dotenv reads a quoted value on across lines, so a line inside one does not set the key. The value
  # ends at the first quote without a backslash before it or, when more than blanks or a comment follow
  # that quote on its line, at the last quote before it that only blanks or a comment follow. So the
  # line is rejected when, for some quote character, such a quote sits on it or after it, up to the
  # first quote without a backslash, and an earlier line opens a value with that quote which no such
  # quote closes before the line (openwa_env_opener). Lines are split where dotenv splits them
  # (openwa_env_lines).
  rest="$(LC_ALL=C tr '\000' '\377' 2>/dev/null <"$file" | LC_ALL=C tail -n +"$n" | openwa_env_lines)"
  closes=""
  for q in "'" '"' '`'; do
    next="$rest"
    o="$(LC_ALL=C grep -anE -m 1 "(^|[^\\\\])$q" <<<"$next")" || true
    [ -z "$o" ] || next="$(LC_ALL=C sed -n "1,${o%%:*}p" <<<"$next")"
    ! LC_ALL=C grep -aqE "^([^$q]|\\\\$q)*$q$s*(#.*)?\$" <<<"$next" || closes="$closes$q"
  done
  o=""
  if [ "$n" -gt 1 ] && [ -n "$closes" ]; then
    prev="$(LC_ALL=C tr '\000' '\377' 2>/dev/null <"$file" | LC_ALL=C sed -n "1,$((n - 1))p" | openwa_env_lines)"
    o="$(openwa_env_opener "$s" "$closes" <<<"$prev")"
  fi
  if [ -n "$o" ]; then
    # Count only the lines the file has, not the ones openwa_env_lines added. A file line that starts with
    # a CR or U+2028 still counts: openwa_env_lines prints the empty text before that character first.
    o="$(LC_ALL=C sed -n "1,${o}p" <<<"$prev" | LC_ALL=C grep -acvE "^("$'\r|\xe2\x80\xa8'")")" || true
    echo "[config] ERROR: $file opens a quoted value on line $o that the app can read on to line $n, which sets" >&2
    echo "[config]        $key, as part of that value. Close the quote on the line that opens it, or pass $key in" >&2
    echo "[config]        the environment." >&2
    return 2
  fi
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
        \"*\" | \'*\' | \`*\`)
          # A quote inside means the pair does not wrap the whole value: a comment ending in one follows it.
          case "${value:1:${#value}-2}" in
            *"${value:0:1}"*) ;;
            *\\)
              # dotenv may take the backslash and quote for an escaped quote and read on, up to the first
              # quote without a backslash, to a quote that only blanks or a comment follow on its line, so
              # the value ends here only when no later line has such a quote.
              q="${value:0:1}"
              next="$(LC_ALL=C sed 1d <<<"$rest")"
              o="$(LC_ALL=C grep -anE -m 1 "(^|[^\\\\])$q" <<<"$next")" || true
              [ -z "$o" ] || next="$(LC_ALL=C sed -n "1,${o%%:*}p" <<<"$next")"
              if ! LC_ALL=C grep -aqE "^([^$q]|\\\\$q)*$q$s*(#.*)?\$" <<<"$next"; then
                printf '%s' "${value:1:${#value}-2}"
                return 0
              fi
              ;;
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
  echo "[config]        ending in a backslash the app can read on past to a later quote, a double-quoted value" >&2
  echo "[config]        with a backslash, or KEY: value." >&2
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
