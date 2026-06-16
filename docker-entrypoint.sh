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

# "$@" = CMD from Dockerfile (default: node dist/main).
# gosu performs exec, so the node process replaces this shell and becomes the
# direct child of dumb-init (PID 1), which can therefore forward SIGTERM cleanly.
exec gosu openwa "$@"
