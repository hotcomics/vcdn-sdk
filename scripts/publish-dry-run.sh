#!/usr/bin/env bash
set -euo pipefail

pnpm install
pnpm run publish:check

echo "Dry-run artifacts written to ./.artifacts"
