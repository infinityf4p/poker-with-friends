#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() {
  cat <<'EOF'
Create and verify one atomic PostgreSQL custom-format backup.

Usage:
  pg-backup.sh [options]

Options:
  --mode host|docker       Run pg_dump on the host or in a container.
  --output-dir PATH        Backup directory (default: /var/backups/poker/postgres).
  --database NAME          Database name (default: poker).
  --user NAME              PostgreSQL role (default: poker).
  --host HOST              Host-mode database host (default: 127.0.0.1).
  --port PORT              Host-mode database port (default: 5432).
  --container NAME         Docker-mode container (default: poker-with-friends-postgres).
  --dry-run                Validate and print the planned operation only.
  -h, --help               Show this help.

Environment equivalents:
  PG_BACKUP_MODE, PG_BACKUP_DIR, PGDATABASE, PGUSER, PGHOST, PGPORT,
  PG_CONTAINER. Host mode uses normal libpq credential sources such as
  PGPASSFILE; this script intentionally has no password command-line option.
EOF
}

mode="${PG_BACKUP_MODE:-docker}"
output_dir="${PG_BACKUP_DIR:-/var/backups/poker/postgres}"
database="${PGDATABASE:-poker}"
db_user="${PGUSER:-poker}"
db_host="${PGHOST:-127.0.0.1}"
db_port="${PGPORT:-5432}"
container="${PG_CONTAINER:-poker-with-friends-postgres}"
dry_run=false

while (($# > 0)); do
  case "$1" in
    --mode)
      (($# >= 2)) || die "--mode requires a value"
      mode="$2"
      shift 2
      ;;
    --output-dir)
      (($# >= 2)) || die "--output-dir requires a value"
      output_dir="$2"
      shift 2
      ;;
    --database)
      (($# >= 2)) || die "--database requires a value"
      database="$2"
      shift 2
      ;;
    --user)
      (($# >= 2)) || die "--user requires a value"
      db_user="$2"
      shift 2
      ;;
    --host)
      (($# >= 2)) || die "--host requires a value"
      db_host="$2"
      shift 2
      ;;
    --port)
      (($# >= 2)) || die "--port requires a value"
      db_port="$2"
      shift 2
      ;;
    --container)
      (($# >= 2)) || die "--container requires a value"
      container="$2"
      shift 2
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "$mode" == "host" || "$mode" == "docker" ]] || die "--mode must be host or docker"
require_absolute_path "output directory" "$output_dir"
[[ -n "$database" && "$database" != *$'\n'* ]] || die "invalid database name"
[[ -n "$db_user" && "$db_user" != *$'\n'* ]] || die "invalid PostgreSQL user"
require_positive_uint "port" "$db_port"
((db_port <= 65535)) || die "port must be at most 65535"
[[ "$container" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die "invalid Docker container name: $container"

database_slug="${database//[^A-Za-z0-9_.-]/_}"
timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
filename="poker-daily-${database_slug}-${timestamp}.dump"
final_path="$output_dir/$filename"

if $dry_run; then
  log "DRY-RUN: would create private directory $output_dir"
  if [[ "$mode" == "host" ]]; then
    log "DRY-RUN: would run pg_dump against ${db_host}:${db_port}/${database} as ${db_user}"
  else
    log "DRY-RUN: would run pg_dump inside container $container for database $database as $db_user"
  fi
  log "DRY-RUN: would verify and atomically install $final_path plus SHA-256 sidecar"
  exit 0
fi

ensure_private_dir "$output_dir"
output_dir="$(canonical_existing_dir "output directory" "$output_dir")"

marker="$output_dir/.poker-pg-backup-root"
if [[ ! -e "$marker" ]]; then
  printf '%s\n' 'poker-postgresql-backups-v1' >"$marker"
  chmod 0600 "$marker"
elif [[ ! -f "$marker" || -L "$marker" || "$(<"$marker")" != "poker-postgresql-backups-v1" ]]; then
  die "backup directory marker is missing or invalid: $marker"
fi

require_command flock
exec 9>"$output_dir/.pg-backup.lock"
flock -n 9 || die "another PostgreSQL backup is already running"

temp_path="$(mktemp --tmpdir="$output_dir" ".${filename}.tmp.XXXXXX")"
checksum_temp=""
cleanup() {
  [[ -z "$temp_path" ]] || rm -f -- "$temp_path"
  [[ -z "$checksum_temp" ]] || rm -f -- "$checksum_temp"
}
trap cleanup EXIT INT TERM

log "creating PostgreSQL backup: $final_path"
if [[ "$mode" == "host" ]]; then
  require_command pg_dump
  require_command pg_restore
  PGHOST="$db_host" PGPORT="$db_port" PGDATABASE="$database" PGUSER="$db_user" \
    pg_dump --format=custom --compress=6 --no-owner --no-acl --file="$temp_path"
  pg_restore --list "$temp_path" >/dev/null
else
  require_command docker
  docker inspect "$container" >/dev/null
  docker exec "$container" \
    pg_dump --username="$db_user" --dbname="$database" --format=custom --compress=6 --no-owner --no-acl \
    >"$temp_path"
  docker exec -i "$container" pg_restore --list <"$temp_path" >/dev/null
fi

[[ -s "$temp_path" ]] || die "pg_dump produced an empty file"
chmod 0600 "$temp_path"
[[ ! -e "$final_path" ]] || die "backup already exists: $final_path"
mv -- "$temp_path" "$final_path"
temp_path=""

require_command sha256sum
checksum_temp="$(mktemp --tmpdir="$output_dir" ".${filename}.sha256.tmp.XXXXXX")"
(
  cd -- "$output_dir"
  sha256sum -- "$filename"
) >"$checksum_temp"
chmod 0600 "$checksum_temp"
[[ ! -e "$final_path.sha256" ]] || die "checksum already exists: $final_path.sha256"
mv -- "$checksum_temp" "$final_path.sha256"
checksum_temp=""

log "backup completed and verified: $final_path"

# Sunday backups receive a second hard-link name. Retention treats it as an
# independent weekly generation; removing the daily name never removes the
# weekly data while its link remains.
backup_timezone="${PG_BACKUP_TIMEZONE:-UTC}"
if [[ "$(TZ="$backup_timezone" date +%u)" == "7" ]]; then
  weekly_filename="poker-weekly-${database_slug}-${timestamp}.dump"
  weekly_path="$output_dir/$weekly_filename"
  [[ ! -e "$weekly_path" && ! -e "$weekly_path.sha256" ]] || die "weekly backup already exists"
  ln -- "$final_path" "$weekly_path"
  (
    cd -- "$output_dir"
    sha256sum -- "$weekly_filename"
  ) >"$weekly_path.sha256"
  chmod 0600 "$weekly_path.sha256"
  log "weekly generation retained: $weekly_path"
fi
