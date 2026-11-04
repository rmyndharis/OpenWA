#!/bin/bash
# OpenWA — built-in PostgreSQL schema init.
#
# Mounted at /docker-entrypoint-initdb.d/01-create-schema.sh by docker-compose.yml, so the
# official postgres image runs it ONCE on first initialization (before any app migration).
# It creates the configured POSTGRES_SCHEMA and sets the database default search_path so the
# built-in container works zero-config with a custom schema — the app's TypeORM `schema` option
# + the search_path it sets with set_config on every new connection then resolve every table + the
# migration ledger into it.
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

# The value is interpolated into the CREATE SCHEMA / SET search_path statements below, so apply
# the same boot-time validation the app does (src/config/env.validation.ts): a plain, non-reserved
# Postgres identifier or nothing. Fail fast here rather than let a typo reach the SQL. Lower case
# only: the app sets an unquoted search_path, which Postgres folds to lower case.
identifier_re='^[a-z_][a-z0-9_]{0,62}$'
if ! [[ "$schema" =~ $identifier_re ]]; then
  echo "postgres-init-schema: ERROR: POSTGRES_SCHEMA must be a valid lower-case Postgres identifier (a lower-case letter or underscore, then lower-case letters/digits/underscores, max 63 chars; got '${schema}')." >&2
  exit 1
fi
case "$schema" in
  pg_*)
    echo "postgres-init-schema: ERROR: POSTGRES_SCHEMA must not use the reserved \"pg_\" prefix (got '${schema}')." >&2
    exit 1
    ;;
esac

echo "postgres-init-schema: creating schema '${schema}' and setting default search_path."

# The postgres image exports POSTGRES_USER + POSTGRES_DB for docker-entrypoint-initdb.d
# scripts; connect as the provisioning role (superuser for the fresh cluster) against the
# just-created database. AUTHORIZATION grants ownership so the app role can create tables.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE SCHEMA IF NOT EXISTS "$schema" AUTHORIZATION "$POSTGRES_USER";
ALTER DATABASE "$POSTGRES_DB" SET search_path TO "$schema", public;
SQL

echo "postgres-init-schema: done."
