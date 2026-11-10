#!/usr/bin/env bash
# Runs the OpenResty install in real OpenResty (Docker) against a mock DNA
# endpoint and the shared echo origin. Needs docker and node on PATH.
# Usage: openresty/test/run.sh
set -u
cd "$(dirname "$0")"
IMAGE=${OPENRESTY_IMAGE:-openresty/openresty:1.27.1.2-13-alpine-fat@sha256:47f3ba33dc95b4abc2bae7a4fa0b5759f0c0b5b338d1e515ca3d8f61a5dbc7b5}
NAME=dna-openresty-test
work=$(mktemp -d)
pids=()
stop() {
  docker rm -f "$NAME" >/dev/null 2>&1
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
  wait 2>/dev/null
  rm -rf "$work"
}
trap stop EXIT
up() { for _ in $(seq 1 60); do curl -s -o /dev/null "$1" && return 0; sleep 0.25; done; echo "never came up: $1" >&2; exit 1; }

docker run --rm -v "$PWD/..":/etc/nginx/lua:ro "$IMAGE" \
  sh -c 'opm get ledgetech/lua-resty-http >/dev/null 2>&1 && resty /etc/nginx/lua/test/unit.lua' || exit 1

if [ "$(uname)" = Linux ]; then
  host=127.0.0.1 net=(--network host)
else
  # Its IPv4: nginx and lua-resty-http take an address, and the IPv6 one is unreachable.
  host=$(docker run --rm "$IMAGE" getent ahostsv4 host.docker.internal | awk 'NR==1{print $1}')
  net=(-p 8120:8120 -p 8121:8121 -p 8122:8122)
fi
sed "s/@HOST@/$host/g" site.conf > "$work/nginx.conf"
mkdir -p "$work/logs" && chmod 777 "$work/logs"

ORIGIN_PORT=3010 node ../../test/origin.mjs & pids+=($!)
MOCK_PORT=9010 node mock-decision.mjs & mock=$!; pids+=($mock)
up 127.0.0.1:3010; up 127.0.0.1:9010/__log

# Short budgets keep the timeout checks quick; production defaults are 150 ms and 10 s.
# LUA_DIR swaps the install's files, and HTTP_LIB=0 leaves lua-resty-http out.
start() {
  local lib='opm get ledgetech/lua-resty-http >/dev/null 2>&1 && '
  [ "${HTTP_LIB:-1}" = 0 ] && lib=''
  docker run -d --name "$NAME" "${net[@]}" \
    -e DNA_API_KEY=test-key -e DNA_ENDPOINT="http://$host:9010/v1/decision" \
    -e DNA_TIMEOUT_MS=500 -e DNA_PAYMENT_TIMEOUT_MS=3000 \
    -e DNA_EXCLUDE_HEADERS=x-internal-token -e DNA_EXCLUDE_COOKIES=sid "$@" \
    -v "${LUA_DIR:-$PWD/..}":/etc/nginx/lua:ro -v "$work/nginx.conf":/usr/local/openresty/nginx/conf/nginx.conf:ro \
    -v "$work/logs":/logs "$IMAGE" \
    sh -c "${lib}exec openresty -g 'daemon off;'" >/dev/null || exit 1
  up 127.0.0.1:8120; up 127.0.0.1:8121; up 127.0.0.1:8122
}
docker rm -f "$NAME" >/dev/null 2>&1
start

ERROR_LOG="$work/logs/error.log" node run.mjs live; live=$?
kill "$mock"; wait "$mock" 2>/dev/null
ERROR_LOG="$work/logs/error.log" node run.mjs dead; dead=$?

# DNA_ENABLED=false: off, but our credentials and a forged verdict still never reach the origin.
# An exclusion list past the 128 DNA is sent is warned about once, not per request.
docker rm -f "$NAME" >/dev/null 2>&1
start -e DNA_ENABLED=false -e DNA_EXCLUDE_HEADERS="$(seq -s, -f 'x-many-%g' 1 130)"
ERROR_LOG="$work/logs/error.log" node run.mjs disabled; off=$?

# The two installs that cannot run all of DNA's code: no lua-resty-http, and no dna.lua.
docker rm -f "$NAME" >/dev/null 2>&1
HTTP_LIB=0 start
ERROR_LOG="$work/logs/error.log" node run.mjs nolib; nolib=$?

cp -R .. "$work/unloaded" && rm "$work/unloaded/dna.lua"
docker rm -f "$NAME" >/dev/null 2>&1
LUA_DIR="$work/unloaded" start
ERROR_LOG="$work/logs/error.log" node run.mjs unloaded; unloaded=$?

failed=$(( live || dead || off || nolib || unloaded ))
[ "$failed" -eq 0 ] || { echo "--- error.log"; tail -40 "$work/logs/error.log"; }
exit "$failed"
