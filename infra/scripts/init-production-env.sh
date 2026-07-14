#!/usr/bin/env bash

set -Eeuo pipefail

usage() {
  echo "Usage: init-production-env.sh <git-sha> <public-origin> [env-path]" >&2
}

git_sha="${1:-}"
public_origin="${2:-}"
env_path="${3:-$PWD/.env}"
image_repository="${APP_IMAGE_REPOSITORY:-poker-with-friends-app}"
bind_address="${APP_BIND_ADDRESS:-127.0.0.1}"
bind_port="${APP_BIND_PORT:-3000}"
project_name="${COMPOSE_PROJECT_NAME:-poker-with-friends}"
postgres_container="${POSTGRES_CONTAINER_NAME:-poker-with-friends-postgres}"
postgres_data_path="${POSTGRES_DATA_PATH:-}"

[[ -n "$git_sha" && -n "$public_origin" ]] || { usage; exit 64; }
[[ "$git_sha" =~ ^[0-9a-f]{7,40}$ ]] || { echo "invalid Git SHA" >&2; exit 64; }
[[ "$public_origin" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || {
  echo "public origin must be an HTTPS origin without a path" >&2
  exit 64
}
[[ "$image_repository" =~ ^[a-z0-9][a-z0-9._/:-]*$ ]] || {
  echo "invalid APP_IMAGE_REPOSITORY" >&2
  exit 64
}
[[ "$bind_address" =~ ^[A-Za-z0-9.:-]+$ ]] || { echo "invalid APP_BIND_ADDRESS" >&2; exit 64; }
[[ "$bind_port" =~ ^[0-9]+$ ]] && ((bind_port > 0 && bind_port <= 65535)) || {
  echo "invalid APP_BIND_PORT" >&2
  exit 64
}
[[ "$project_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || {
  echo "invalid COMPOSE_PROJECT_NAME" >&2
  exit 64
}
[[ "$postgres_container" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || {
  echo "invalid POSTGRES_CONTAINER_NAME" >&2
  exit 64
}
if [[ -n "$postgres_data_path" && "$postgres_data_path" != /* ]]; then
  echo "POSTGRES_DATA_PATH must be an absolute path" >&2
  exit 64
fi
if [[ "$env_path" != /* ]]; then
  env_path="$PWD/$env_path"
fi
[[ "$(id -u)" == "0" ]] || { echo "must run as root" >&2; exit 1; }
if [[ -e "$env_path" ]]; then
  echo "refusing to overwrite existing production environment: $env_path" >&2
  exit 1
fi

command -v docker >/dev/null
command -v openssl >/dev/null
umask 077

admin_password="$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n' | cut -c1-24)"
db_password="$(openssl rand -hex 32)"
cookie_secret="$(openssl rand -hex 48)"
token_pepper="$(openssl rand -hex 48)"
snapshot_key="$(openssl rand -base64 32 | tr -d '\n')"
admin_hash="$(printf '%s' "$admin_password" | docker run --rm -i --entrypoint node "$image_repository:$git_sha" dist/cli/hash-admin-password.js)"
[[ "$admin_hash" == \$argon2id\$* ]] || { echo "failed to generate Argon2id hash" >&2; exit 1; }

install -d -m 0700 "$(dirname "$env_path")"
temp="$(mktemp "${env_path}.tmp.XXXXXX")"
cleanup() { rm -f -- "$temp"; }
trap cleanup EXIT INT TERM
{
  printf 'COMPOSE_PROJECT_NAME=%s\n' "$project_name"
  printf 'APP_IMAGE_REPOSITORY=%s\n' "$image_repository"
  printf 'NODE_ENV=production\n'
  printf 'HOST=0.0.0.0\nPORT=3000\n'
  printf 'PUBLIC_ORIGIN=%s\nTRUST_PROXY=true\n' "$public_origin"
  printf 'POSTGRES_USER=poker\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=poker\n' "$db_password"
  printf 'POSTGRES_IMAGE=postgres:18-alpine\nPOSTGRES_CONTAINER_NAME=%s\n' "$postgres_container"
  [[ -z "$postgres_data_path" ]] || printf 'POSTGRES_DATA_PATH=%s\n' "$postgres_data_path"
  printf 'DATABASE_URL=postgres://poker:%s@postgres:5432/poker\n' "$db_password"
  printf 'COOKIE_SECRET=%s\nTOKEN_PEPPER=%s\nSNAPSHOT_KEY=%s\n' "$cookie_secret" "$token_pepper" "$snapshot_key"
  printf 'ADMIN_USERNAME=admin\n'
  printf "ADMIN_PASSWORD_HASH='%s'\n" "$admin_hash"
  printf 'RETENTION_DAYS=30\nROOM_IDLE_HOURS=12\n'
  printf 'APP_BUILD_SHA=%s\nAPP_IMAGE_TAG=%s\n' "$git_sha" "$git_sha"
  printf 'APP_BIND_ADDRESS=%s\nAPP_BIND_PORT=%s\n' "$bind_address" "$bind_port"
} >"$temp"
chmod 0600 "$temp"
mv -- "$temp" "$env_path"
trap - EXIT INT TERM

printf 'ADMIN_USERNAME=admin\nADMIN_PASSWORD=%s\n' "$admin_password"
