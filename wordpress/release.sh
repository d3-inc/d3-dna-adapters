#!/usr/bin/env bash
# Builds release/d3-dna.zip and its sha256 from the committed plugin, with d3-dna/
# at the top: Upload Plugin unpacks it there, and the wp-config.php line expects it.
# Usage: wordpress/release.sh [version]   (a tag's version, checked against the plugin's)
set -euo pipefail
cd "$(dirname "$0")/.."

header=$(sed -n 's/^ \* Version: *//p' wordpress/d3-dna/d3-dna.php)
sends=$(sed -n "s/.*const DNA_ADAPTER = 'wordpress:\(.*\)';/\1/p" wordpress/d3-dna/src/Runtime.php)
# DNA grants features by the version the plugin sends, so the two must agree.
if [ -z "$header" ] || [ "$header" != "$sends" ]; then
  echo "d3-dna.php is version '$header' but Runtime.php sends 'wordpress:$sends'" >&2
  exit 1
fi
if [ -n "${1:-}" ] && [ "$1" != "$header" ]; then
  echo "the tag names $1, the plugin is $header" >&2
  exit 1
fi

mkdir -p release
git archive --format=zip --prefix=d3-dna/ HEAD:wordpress/d3-dna > release/d3-dna.zip

listed=$(unzip -Z1 release/d3-dna.zip)
for file in d3-dna/d3-dna.php d3-dna/boot.php d3-dna/src/Runtime.php; do
  grep -qx "$file" <<<"$listed" || { echo "release/d3-dna.zip has no $file" >&2; exit 1; }
done
if grep -v '^d3-dna/' <<<"$listed"; then
  echo "release/d3-dna.zip has entries outside d3-dna/" >&2
  exit 1
fi

(cd release && shasum -a 256 d3-dna.zip > d3-dna.zip.sha256)
echo "release/d3-dna.zip: DNA by D3 $header"
