#!/usr/bin/env bash
# Run a command in the pinned Node image with the repo mounted. CI uses the same script.
#   scripts/dev.sh npm ci
#   NETWORK=none scripts/dev.sh npm test     # the tests need no network
#   PORT=8787 scripts/dev.sh node src/main.ts
# Keep IMAGE in step with the Dockerfile's base.
set -euo pipefail
IMAGE="node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
args=(--rm --init -v "$ROOT":/app -w /app -u "$(id -u):$(id -g)"
      -e HOME=/tmp -e npm_config_cache=/app/.npm -e CI="${CI:-}")
[ -t 0 ] && [ -t 1 ] && args+=(-it)
[ -n "${NETWORK:-}" ] && args+=(--network "$NETWORK")
[ -n "${PORT:-}" ] && args+=(-p "127.0.0.1:$PORT:$PORT")
exec docker run "${args[@]}" "$IMAGE" "$@"
