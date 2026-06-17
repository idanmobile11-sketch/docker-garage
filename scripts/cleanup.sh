#!/bin/sh
# =============================================================================
# scripts/cleanup.sh — Remove all Docker Garage generated containers
# =============================================================================
# Run this before or after "docker compose up/down" to ensure no test-drive
# containers are left running on the host.
#
# Usage:
#   sh scripts/cleanup.sh
#
# Or wire it into a Makefile:
#   up:   sh scripts/cleanup.sh && docker compose up -d
#   down: docker compose down  && sh scripts/cleanup.sh
# =============================================================================

set -eu

LABEL="com.docker-garage.managed=true"

echo "==> Looking for Docker Garage managed containers..."
containers=$(docker ps -aq --filter "label=${LABEL}" 2>/dev/null || true)

if [ -z "$containers" ]; then
    echo "    Nothing to clean up."
    exit 0
fi

count=$(echo "$containers" | wc -w | tr -d ' ')
echo "    Found ${count} container(s)."

echo "==> Stopping..."
# shellcheck disable=SC2086
docker stop $containers 2>/dev/null || true

echo "==> Removing..."
# shellcheck disable=SC2086
docker rm -f $containers 2>/dev/null || true

echo "==> Done. ${count} container(s) removed."
