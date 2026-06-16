#!/bin/sh
# Runs as root (via dumb-init). Fixes named-volume ownership then drops to the
# openwa user via gosu so the Node process never holds root privileges.
set -e

# Wipe all Chromium singleton locks — Chromium doesn't clean these up on crash,
# so stale locks block subsequent launches of sessions that reuse the same profile path.
rm -rf /tmp/.chromium /app/data/sessions/*/SingletonLock \
       /app/data/sessions/*/SingletonSocket \
       /app/data/sessions/*/SingletonCookie 2>/dev/null || true

# Create the XDG Crashpad directory so Chromium's crashpad handler can initialise
# without throwing "chrome_crashpad_handler: --database is required".
# Chromium reads $XDG_CONFIG_HOME/Crashpad (falls back to $HOME/.config/Crashpad).
# With HOME=/tmp in docker-compose, this gives /tmp/.config/Crashpad (#254/#242).
mkdir -p /tmp/.config/Crashpad
chown -R openwa:openwa /tmp/.config

mkdir -p /app/data/sessions /app/data/media /app/data/plugins
chown -R openwa:openwa /app/data

# Chromium resolves its home from the passwd entry (no /home/openwa exists), so it hard-crashes at
# launch unless its config/cache dirs exist and are writable. XDG_CONFIG_HOME/XDG_CACHE_HOME (set in
# the image) point here; create them owned by openwa. On a read_only rootfs these live on tmpfs /tmp,
# which is mounted fresh each start — so they must be (re)created at runtime, not at build. (#254)
if ! mkdir -p "${XDG_CONFIG_HOME:-/tmp/.config}" "${XDG_CACHE_HOME:-/tmp/.cache}"; then
  echo "FATAL: cannot create Chromium config/cache dirs (${XDG_CONFIG_HOME:-/tmp/.config}, ${XDG_CACHE_HOME:-/tmp/.cache})." >&2
  echo "       On a read_only rootfs, mount a writable tmpfs/emptyDir at /tmp (compose: 'tmpfs: [/tmp]'; k8s: an emptyDir at /tmp)." >&2
  echo "       Without it Chromium cannot launch and sessions will fail (#254)." >&2
  exit 1
fi
chown openwa:openwa "${XDG_CONFIG_HOME:-/tmp/.config}" "${XDG_CACHE_HOME:-/tmp/.cache}"

# "$@" = CMD from Dockerfile (default: node dist/main).
# gosu performs exec, so the node process replaces this shell and becomes the
# direct child of dumb-init (PID 1), which can therefore forward SIGTERM cleanly.
exec gosu openwa "$@"
