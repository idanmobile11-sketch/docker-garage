#!/bin/sh
# =============================================================================
# docker-entrypoint.sh - Docker Socket Permission Fixer
# =============================================================================
# WHY THIS EXISTS:
#   The host's Docker socket (/var/run/docker.sock) is owned by a specific
#   group (GID) on the host machine. This GID varies between:
#     - Linux systems     : typically 999 or 998
#     - macOS             : different again
#     - Windows (WSL2)    : managed by Docker Desktop
#
#   Our non-root 'appuser' inside the container cannot access the socket
#   without belonging to that group. This script detects the socket's GID
#   at runtime and adds 'appuser' to the correct group automatically.
#
#   This makes the project work on Linux, macOS, and Windows (WSL2)
#   without any manual configuration.
# =============================================================================

set -e

echo "[Entrypoint] Starting Docker Garage..."

# Only run the permission fix if the Docker socket actually exists.
# If it's missing, the app will start anyway and show an error via the API.
if [ -S /var/run/docker.sock ]; then
    echo "[Entrypoint] Docker socket found. Checking permissions..."

    # Get the numeric GID of the group that owns the socket.
    DOCKER_GID=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo "0")
    echo "[Entrypoint] Docker socket GID: $DOCKER_GID"

    if [ "$DOCKER_GID" != "0" ]; then
        # GID is non-root: create a matching group and add appuser to it.
        if ! getent group "$DOCKER_GID" > /dev/null 2>&1; then
            echo "[Entrypoint] Creating group 'dockersock' with GID $DOCKER_GID"
            addgroup -g "$DOCKER_GID" dockersock
        fi

        GROUP_NAME=$(getent group "$DOCKER_GID" | cut -d: -f1)
        echo "[Entrypoint] Adding appuser to group: $GROUP_NAME"
        adduser appuser "$GROUP_NAME" 2>/dev/null || true
    else
        # Socket is root-owned (common on Docker Desktop / WSL2).
        # Make it world-readable/writable so appuser can connect.
        echo "[Entrypoint] Socket is root-owned. Opening permissions..."
        chmod 666 /var/run/docker.sock 2>/dev/null || true
    fi

    echo "[Entrypoint] Docker socket is ready."
else
    echo "[Entrypoint] WARNING: /var/run/docker.sock not found!"
    echo "[Entrypoint] Make sure the Docker socket is mounted in docker-compose.yml"
fi

# Ensure the Test Drive temp directory exists on the host mount and is
# writable by appuser. We are still running as root here, so we can chown it.
GENERATED_ROOT="${GENERATED_ROOT:-/tmp/docker-garage}"
echo "[Entrypoint] Ensuring $GENERATED_ROOT is writable by appuser..."
mkdir -p "$GENERATED_ROOT"
chown appuser:appgroup "$GENERATED_ROOT"
chmod 755 "$GENERATED_ROOT"
echo "[Entrypoint] $GENERATED_ROOT is ready."

# Drop from root to 'appuser' and execute the main command (e.g. npm run dev).
# 'exec' replaces this shell process so signals (SIGTERM) reach Node.js cleanly.
echo "[Entrypoint] Handing off to: $@"
exec su-exec appuser "$@"
