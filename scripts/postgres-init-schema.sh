#!/bin/bash
# OpenWA — built-in PostgreSQL schema init.
#
# Mounted at /docker-entrypoint-initdb.d/01-create-schema.sh by docker-compose.yml, so the
# official postgres image runs it ONCE on first initialization (before any app migration).
# It creates the configured POSTGRES_SCHEMA and sets the database default search_path so the
# built-in container works zero-config with a custom schema — the app's TypeORM `schema` option
# + `extra.options search_path` then resolve every table + the migration ledger into it.
#
# No-op when POSTGRES_SCHEMA is empty or 'public' (the default): the public schema always
# exists and the default search_path already includes it, so there is nothing to do.
#
# Limitation: the postgres image only runs docker-entrypoint-initdb.d scripts on FIRST init.
# An existing postgres-data volume will NOT re-run this script. To adopt a custom schema on an
# already-initialized volume, create it manually once (e.g. `CREATE SCHEMA openwa;`) and set
# POSTGRES_SCHEMA on the openwa-api service.
set -euo pipefail

schema="${POSTGRES_SCHEMA:-public}"

if [ -z "$schema" ] || [ "$schema" = "public" ]; then
  echo "postgres-init-schema: POSTGRES_SCHEMA is '${schema}' (default) — nothing to do."
  exit 0
fi

echo "postgres-init-schema: creating schema '${schema}' and setting default search_path."

# The postgres image exports POSTGRES_USER + POSTGRES_DB for docker-entrypoint-initdb.d
# scripts; connect as the provisioning role (superuser for the fresh cluster) against the
# just-created database. AUTHORIZATION grants ownership so the app role can create tables.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE SCHEMA IF NOT EXISTS "$schema" AUTHORIZATION "$POSTGRES_USER";
ALTER DATABASE "$POSTGRES_DB" SET search_path TO "$schema", public;
SQL

echo "postgres-init-schema: done."
