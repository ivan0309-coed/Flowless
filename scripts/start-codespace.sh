#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

health_url="http://127.0.0.1:${PORT:-3000}/api/v1/health"
pid_file="/tmp/flowless.pid"
log_file="/tmp/flowless.log"

if curl --fail --silent --show-error "$health_url" >/dev/null 2>&1; then
  exit 0
fi

server_pid=""
if [[ -f "$pid_file" ]]; then
  existing_pid="$(cat "$pid_file")"
  if kill -0 "$existing_pid" 2>/dev/null; then
    server_pid="$existing_pid"
  else
    rm -f "$pid_file"
  fi
fi

if [[ -z "$server_pid" ]]; then
  nohup pnpm start >"$log_file" 2>&1 </dev/null &
  server_pid=$!
  echo "$server_pid" >"$pid_file"
fi

for _ in {1..30}; do
  if curl --fail --silent --show-error "$health_url" >/dev/null 2>&1; then
    exit 0
  fi

  if ! kill -0 "$server_pid" 2>/dev/null; then
    cat "$log_file" >&2
    exit 1
  fi

  sleep 1
done

cat "$log_file" >&2
exit 1
