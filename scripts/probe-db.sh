#!/bin/sh
# Read-only database probe: booking-related tables + the full migration history.
#
# Written for the Online Booking drift investigation (docs/migrations.md), but
# useful before ANY deploy: it answers "what does this database actually think
# has been applied to it", which is the question `migrate deploy` acts on.
#
# Usage:  sh scripts/probe-db.sh "$DIRECT_URL"
#
# Reads nothing but catalog tables and _prisma_migrations, and writes nothing.
# The connection string is never echoed.
set -e

URL="$1"
if [ -z "$URL" ]; then
  echo "usage: sh scripts/probe-db.sh <connection-string>" >&2
  exit 2
fi

# psql rejects Prisma's ?schema=/?connection_limit= parameters; strip the query
# string. Neon's ?sslmode=require is also dropped, so add it back via PGSSLMODE
# rather than the URL (harmless against a local database that ignores it).
URL_NO_PARAMS="${URL%%\?*}"
case "$URL" in *sslmode=require*) PGSSLMODE=require; export PGSSLMODE ;; esac

psql "$URL_NO_PARAMS" -v ON_ERROR_STOP=1 -At <<'SQL'
\echo '--- connected to ---'
SELECT current_database() || ' @ ' || COALESCE(inet_server_addr()::text, 'local');

\echo '--- booking-like tables ---'
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name ILIKE '%booking%';

\echo '--- booking-like migrations ---'
SELECT migration_name
       || ' | finished=' || COALESCE(finished_at::text, 'NULL')
       || ' | rolled_back=' || COALESCE(rolled_back_at::text, 'NULL')
FROM _prisma_migrations WHERE migration_name ILIKE '%booking%';

\echo '--- external lab migration present? ---'
SELECT migration_name || ' | ' || COALESCE(finished_at::text, 'PENDING')
FROM _prisma_migrations WHERE migration_name ILIKE '%external_lab%';

\echo '--- full migration history, in APPLICATION order ---'
SELECT migration_name || ' | ' || COALESCE(finished_at::text, 'PENDING')
FROM _prisma_migrations ORDER BY started_at;
SQL
