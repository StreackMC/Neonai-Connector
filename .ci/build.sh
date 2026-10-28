#!/usr/bin/env bash
set -euo pipefail

entry=${1:?entry point is required}
output=${2:?output path is required}
target=${3:?pkg target is required}

if [[ "$target" == windows-* ]]; then
  target="win-${target#windows-}"
fi

npx --no-install pkg "$entry" \
  --target "node18-${target}" \
  --output "$output"