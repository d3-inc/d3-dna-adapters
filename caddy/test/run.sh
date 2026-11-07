#!/usr/bin/env bash
# Runs dna.caddy in real Caddy against a mock DNA endpoint and origin.
# Needs caddy and node on PATH. Usage: caddy/test/run.sh
set -u
cd "$(dirname "$0")"
export D3_EDGE_ADAPTER_KEY=test-key DNA_ENDPOINT=http://127.0.0.1:9000 DNA_ENDPOINT_HOST=mock
# Short budgets keep the timeout checks quick; production defaults are 500ms and 10s.
export DNA_TIMEOUT=500ms DNA_PAYMENT_TIMEOUT=3s
export DNA_EXCLUDE_HEADERS=x-internal-token DNA_EXCLUDE_COOKIES=sid
pids=()
stop() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; }
trap stop EXIT
up() { for _ in $(seq 1 40); do curl -s -o /dev/null "$1" && return 0; sleep 0.25; done; echo "never came up: $1" >&2; exit 1; }

node origin.mjs & pids+=($!)
node mock-worker.mjs & worker=$!; pids+=($worker)
up 127.0.0.1:3000; up 127.0.0.1:9000/__log
caddy run --config site.Caddyfile --adapter caddyfile >caddy.log 2>&1 & pids+=($!)
up 127.0.0.1:8080; up 127.0.0.1:8085

node run.mjs live; live=$?
kill "$worker"; wait "$worker" 2>/dev/null
node run.mjs dead; dead=$?
exit $(( live || dead ))
