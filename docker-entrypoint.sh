#!/bin/sh
set -e

# Fix data directory permissions for named volume mounts (runs as root before dropping privileges)
mkdir -p /app/data/sessions /app/data/media /app/data/plugins
chown -R openwa:openwa /app/data

exec gosu openwa dumb-init "$@"
