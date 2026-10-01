#!/bin/sh
# Runs once, on the first start of an empty PostgreSQL volume.
# Creates a separate database for the backend test suite so tests never
# touch application data.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "CREATE DATABASE \"${POSTGRES_DB}_test\" OWNER \"$POSTGRES_USER\";"
