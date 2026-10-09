#!/usr/bin/env bash
# Persistent SSH tunnel to the remote Postgres, with retry-on-drop (autossh
# is not assumed to be installed). Reads connection metadata from .env —
# never sources the whole file (some values there contain spaces/characters
# that are not valid POSIX shell), just greps the specific keys it needs.
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

get_env() {
  local key="$1"
  local default="${2:-}"
  local value
  value=$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d'=' -f2-)
  echo "${value:-$default}"
}

HOST=$(get_env SSH_TUNNEL_HOST)
USER_NAME=$(get_env SSH_TUNNEL_USER root)
KEY_PATH=$(get_env SSH_TUNNEL_KEY_PATH)
LOCAL_PORT=$(get_env SSH_TUNNEL_LOCAL_PORT 55432)
REMOTE_PORT=$(get_env SSH_TUNNEL_REMOTE_PORT 5432)

if [ -z "$HOST" ]; then
  echo "SSH_TUNNEL_HOST is not set in .env — nothing to connect to." >&2
  exit 1
fi
if [ -z "$KEY_PATH" ]; then
  echo "SSH_TUNNEL_KEY_PATH is not set in .env — refusing to fall back to password auth." >&2
  exit 1
fi

# Expand a leading ~ (grep/cut above won't expand it for us).
KEY_PATH="${KEY_PATH/#\~/$HOME}"

echo "Starting persistent SSH tunnel: localhost:${LOCAL_PORT} -> ${HOST}:${REMOTE_PORT} (as ${USER_NAME}, key=${KEY_PATH})"
echo "Ctrl+C to stop. Reconnects automatically on drop."

while true; do
  ssh -N \
    -o "ServerAliveInterval=30" \
    -o "ServerAliveCountMax=3" \
    -o "ExitOnForwardFailure=yes" \
    -o "StrictHostKeyChecking=accept-new" \
    -i "$KEY_PATH" \
    -L "${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" \
    "${USER_NAME}@${HOST}"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Tunnel dropped. Reconnecting in 5s..."
  sleep 5
done
