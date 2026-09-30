#!/bin/sh
# Runs as root (via dumb-init) by default: fixes named-volume ownership, then drops to the
# openwa user via gosu so the Node process never holds root privileges. Started as any other
# uid (`docker run --user`, compose `user:`, a Kubernetes runAsUser) it cannot chown or switch
# users, so it skips both and runs the command as that uid.
set -e

# A non-root start needs a data volume its uid can already write. Say so here, naming the fix,
# rather than failing on a chown or on the first write inside Node.
if [ "$(id -u)" != 0 ]; then
  for dir in /app/data /app/data/sessions /app/data/media /app/data/plugins; do
    if [ -e "$dir" ] && [ ! -w "$dir" ]; then
      echo "FATAL: $dir is not writable by uid $(id -u), gid $(id -g)." >&2
      echo "       A non-root start needs a data volume that user can write: in Kubernetes set" >&2
      echo "       podSecurityContext.fsGroup to its gid; with Docker, chown the volume to it, or start as root." >&2
      exit 1
    fi
  done
fi

mkdir -p /app/data/sessions /app/data/media /app/data/plugins

# Chromium leaves SingletonLock/SingletonSocket/SingletonCookie in each session profile and does
# not remove them on an unclean shutdown; stale locks block the next launch ("profile appears to be
# in use by another Chromium process", exit Code 21). No Chromium is running yet at entrypoint time,
# so clearing them lets sessions re-launch after a crash/restart. (#259)
rm -f /app/data/sessions/*/Singleton* 2>/dev/null || true

# Chromium resolves its home from the passwd entry (no /home/openwa exists), so it hard-crashes at
# launch unless its config/cache dirs exist and are writable. XDG_CONFIG_HOME/XDG_CACHE_HOME (set in
# the image) point here; create them owned by openwa. On a read_only rootfs these live on tmpfs /tmp,
# which is mounted fresh each start, so they must be (re)created at runtime, not at build. (#254)
if ! mkdir -p "${XDG_CONFIG_HOME:-/tmp/.config}" "${XDG_CACHE_HOME:-/tmp/.cache}"; then
  echo "FATAL: cannot create Chromium config/cache dirs (${XDG_CONFIG_HOME:-/tmp/.config}, ${XDG_CACHE_HOME:-/tmp/.cache})." >&2
  echo "       On a read_only rootfs, mount a writable tmpfs/emptyDir at /tmp (compose: 'tmpfs: [/tmp]'; k8s: an emptyDir at /tmp)." >&2
  echo "       Without it Chromium cannot launch and sessions will fail (#254)." >&2
  exit 1
fi

# Nothing below can run without root: the chowns need CAP_CHOWN and gosu needs CAP_SETUID.
if [ "$(id -u)" != 0 ]; then
  exec "$@"
fi

# Re-own every path under /app/data that is not already openwa:openwa, except symlinks. Some bind
# mounts (Docker Desktop's file sharing) refuse to change a symlink's owner, which a link never
# needs, so a `chown -R` that met any link (a Chromium lock under a custom SESSION_DATA_PATH, a
# relocated session profile, a backup staging copy) failed under `set -e` and crash-looped the
# container on every start (#1722). Neither find nor `chown -h` follows a link, so a path swapped
# for a link between the walk and the chown never re-owns the link's target. The ownership test
# keeps a steady-state start to one stat per path: a chown is a metadata write even when the owner
# is unchanged, which on a large session or media volume (or NFS) held boot for minutes. The walk
# itself stays, because a file restored or copied in as root must still be re-owned. The
# parentheses matter: without them `-o` would let the group branch bypass `! -type l`. A real
# chown failure still stops the script.
find /app/data ! -type l \( ! -user openwa -o ! -group openwa \) -exec chown -h openwa:openwa {} +

# The Chromium config/cache dirs created above, as root.
chown openwa:openwa "${XDG_CONFIG_HOME:-/tmp/.config}" "${XDG_CACHE_HOME:-/tmp/.cache}"

# "$@" = CMD from Dockerfile (default: node dist/main).
# gosu performs exec, so the node process replaces this shell and becomes the
# direct child of dumb-init (PID 1), which can therefore forward SIGTERM cleanly.
exec gosu openwa "$@"
