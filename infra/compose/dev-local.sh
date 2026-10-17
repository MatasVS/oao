#!/bin/sh
set -u

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
cd "$repository_root"

oao_database_running() {
  if docker compose version >/dev/null 2>&1; then
    [ -n "$(docker compose -f "$script_dir/docker-compose.yml" ps --status running -q postgres 2>/dev/null)" ]
  else
    [ "$(docker inspect --format '{{.State.Running}}' oao-postgres-local 2>/dev/null || true)" = true ]
  fi
}

database_was_running=false
# An existing PostgreSQL server chosen during setup is never stopped here;
# like the launcher, .env's choice wins over an exported value.
postgres_mode=
if [ -f .env ]; then
  postgres_mode=$(sed -n 's/^[[:space:]]*OAO_POSTGRES_MODE=//p' .env | tail -n 1 | tr -d "\"' ")
fi
if [ "$postgres_mode" != existing ]; then
  postgres_mode=${OAO_POSTGRES_MODE-}
fi
if [ "$postgres_mode" = existing ] || oao_database_running; then
  database_was_running=true
fi

launcher_pid=
cleaned=false
cleanup() {
  if [ "$cleaned" = true ]; then
    return
  fi
  cleaned=true
  if [ -n "$launcher_pid" ]; then
    kill -TERM "$launcher_pid" >/dev/null 2>&1 || true
    wait "$launcher_pid" >/dev/null 2>&1 || true
    launcher_pid=
  fi
  if [ "$database_was_running" = false ] && oao_database_running; then
    "$script_dir/down.sh" || true
  fi
}

interrupt() {
  exit_code=$1
  trap - HUP INT TERM
  cleanup
  exit "$exit_code"
}

trap cleanup EXIT
trap 'interrupt 129' HUP
trap 'interrupt 130' INT
trap 'interrupt 143' TERM

node --env-file-if-exists=.env "$script_dir/dev-local.mjs" &
launcher_pid=$!
status=0
wait "$launcher_pid" || status=$?
launcher_pid=
exit "$status"
