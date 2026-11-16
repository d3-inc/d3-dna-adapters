#!/usr/bin/env bash
# Runs the WordPress plugin in real WordPress (Docker) against the shared mock
# DNA endpoint: the port's unit suite on PHP 7.4 and 8.3, then each install
# phase end to end. Needs docker (with compose) and node on PATH.
# Usage: wordpress/test/run.sh
set -u
cd "$(dirname "$0")"

export PHP74_IMAGE=php:7.4-cli@sha256:620a6b9f4d4feef2210026172570465e9d0c1de79766418d3affd09190a7fda5
export PHP83_IMAGE=php:8.3-cli@sha256:628102249d93494233b54490b785f12db9cd60f4dc89416dfca15973f2125f10
export FPM_IMAGE=wordpress:6.8-php8.3-fpm@sha256:906c25725c2edccb7809851f61f98560ea73b6c01d482d69d1b9fdf04b5ff75f
export APACHE83_IMAGE=wordpress:6.8-php8.3-apache@sha256:30bff39330d1693b0ce13d32fc9b7bb67193064f040b7d60d3494e136fa599d4
# WordPress publishes no PHP 7.4 image of 6.8; this one runs the 6.8 core the FPM image installs.
export APACHE74_IMAGE=wordpress:php7.4-apache@sha256:7e46cf3373751b6d62b7a0fc3a7d6686f641a34a2a0eb18947da5375c55fd009
export CLI_IMAGE=wordpress:cli-php8.3@sha256:e4980e3ef763ce7535049c05a54e906d95b16370f28ca02fa329a079eebf3f65
export NGINX_IMAGE=nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10
export DB_IMAGE=mariadb:11.4@sha256:5e73baf8179b29f115101bb102763a47a017361f3e9792daccba6646c3ab1532
export NODE_IMAGE=node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

compose() { docker compose -f compose.yml "$@"; }
work=$(mktemp -d)
# Setup's own output goes here, and is shown when a step fails.
setup_log="$work/setup.log"
fail() { echo "setup failed: $1" >&2; tail -40 "$setup_log" >&2; compose logs --tail 20 >&2; exit 1; }
down() { compose --profile tools down -v --remove-orphans >/dev/null 2>&1; }
trap 'down; rm -rf "$work"' EXIT
# Up once it answers anything but nginx's 502, which it gives while PHP-FPM restarts.
up() {
  for _ in $(seq 1 240); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$1")
    [ "$code" != 000 ] && [ "$code" != 502 ] && return 0
    sleep 0.5
  done
  fail "never came up: $1"
}

for image in "$PHP74_IMAGE" "$PHP83_IMAGE"; do
  echo "--- unit, ${image%%@*}"
  docker run --rm -v "$PWD/../..":/repo:ro -w /repo "$image" php wordpress/test/unit.php || exit 1
done

down
compose up -d --quiet-pull db mock fpm web >>"$setup_log" 2>&1 || fail 'starting the FPM site'
up 127.0.0.1:9020/__log
up 127.0.0.1:8130/
wp() { compose run --rm -T cli wp "$@" >>"$setup_log" 2>&1; }
wp core install --url=http://127.0.0.1:8130 --title=DNA --admin_user=admin --admin_password=admin \
  --admin_email=admin@example.com --skip-email || fail 'wp core install'
wp rewrite structure '/%postname%/' || fail 'wp rewrite structure'
wp plugin activate d3-dna dna-test-origin || fail 'wp plugin activate'
# Apache's half of pretty permalinks; nginx's is in nginx.conf.
compose exec -T fpm sh -c 'printf "%s\n" "RewriteEngine On" "RewriteRule ^index\.php$ - [L]" \
  "RewriteCond %{REQUEST_FILENAME} !-f" "RewriteCond %{REQUEST_FILENAME} !-d" "RewriteRule . /index.php [L]" \
  > /var/www/html/.htaccess' || fail 'writing .htaccess'
compose up -d --quiet-pull apache83 apache74 >>"$setup_log" 2>&1 || fail 'starting the Apache sites'
up 127.0.0.1:8131/; up 127.0.0.1:8132/

# Recreates the FPM site under other settings; the rest stay as they are.
restart_fpm() {
  env "$@" docker compose -f compose.yml up -d --force-recreate --no-deps fpm >>"$setup_log" 2>&1 || fail "restarting FPM with $*"
  up 127.0.0.1:8130/
}
phase() { echo "--- $1"; node run.mjs "$1"; }

phase live; live=$?

compose stop mock >/dev/null 2>&1
phase dead; dead=$?
compose start mock >/dev/null 2>&1; up 127.0.0.1:9020/__log

restart_fpm DNA_FAIL_MODE=closed
phase closed; closed=$?

restart_fpm DNA_ENABLED=false
phase disabled; off=$?

# No wp-config.php line: the must-use loader runs it, then the plugin alone once the loader is gone.
restart_fpm DNA_TEST_BOOT=no
phase mu-plugin; mu=$?
compose exec -T fpm rm /var/www/html/wp-content/mu-plugins/0-d3-dna-loader.php
phase plugin; plugin=$?

# A plugin update half done: boot.php is there and Runtime.php is not.
cp -R ../d3-dna "$work/d3-dna" && rm "$work/d3-dna/src/Runtime.php"
restart_fpm PLUGIN_DIR="$work/d3-dna"
phase unloaded; unloaded=$?

failed=$(( live || dead || closed || off || mu || plugin || unloaded ))
[ "$failed" -eq 0 ] || { echo "--- fpm log"; compose logs --tail 40 fpm; }
exit "$failed"
