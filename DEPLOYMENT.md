# Poker with Friends production deployment

The canonical production definition is `infra/compose.yaml`. It runs the app and an independent PostgreSQL service, keeps the database on an internal Docker network, and publishes only the configured application address and port.

## 1. Prerequisites

- Docker Engine with Docker Compose v2.20 or newer and BuildKit.
- A reviewed HTTPS reverse proxy for any internet-facing deployment.
- At least one tested, independently stored database backup.

Node.js 24 and PostgreSQL 18 are pinned by the container definitions. PostgreSQL data uses the `postgres-data` named volume by default. Set `POSTGRES_DATA_PATH` to an absolute host path when database files must live on a dedicated data disk; create and back up that directory before starting Compose.

## 2. First start

Run Compose from the `infra` directory so it automatically reads `infra/.env`:

```bash
cd infra
cp .env.production.example .env
chmod 600 .env
```

Replace every `REPLACE_*` value. Generate each application secret independently:

```bash
openssl rand -base64 48 # COOKIE_SECRET
openssl rand -base64 48 # TOKEN_PEPPER
openssl rand -base64 32 # SNAPSHOT_KEY: exactly 32 bytes before Base64 encoding
```

`DATABASE_URL` uses host `postgres`, because the app connects over the Compose network. URL-encode reserved characters in its password. `POSTGRES_PASSWORD` contains the corresponding raw password.

Generate `ADMIN_PASSWORD_HASH` with `pnpm --filter @poker-with-friends/server admin:hash`, or use the production environment generator in section 4. Store only the resulting Argon2id hash in `infra/.env`, never the plaintext password. Keep the value inside single quotes so Compose does not treat the hash's `$` characters as interpolation.

Review and start the stack:

```bash
docker compose config --quiet
docker compose build --pull
docker compose up -d
docker compose ps
```

The one-shot `migrate` service must finish successfully before `app` starts. If startup is pending, inspect it with:

```bash
docker compose logs migrate
```

The compatibility file `infra/docker-compose.prod.yml` includes the canonical Compose file for operators that still pass `-f docker-compose.prod.yml`.

## 3. Network exposure

The defaults publish the app only at `127.0.0.1:3000` and do not publish PostgreSQL. Set `APP_BIND_ADDRESS` and `APP_BIND_PORT` in `infra/.env` when another bind is intentional. Binding to `0.0.0.0` exposes the app on every host interface and should be paired with a reviewed firewall and TLS termination.

The supplied Nginx template can be rendered without expanding its native variables:

```bash
export SERVER_NAME=poker.example.com
export APP_UPSTREAM=127.0.0.1:3000
export TLS_CERTIFICATE=/etc/letsencrypt/live/poker.example.com/fullchain.pem
export TLS_CERTIFICATE_KEY=/etc/letsencrypt/live/poker.example.com/privkey.pem
envsubst '${SERVER_NAME} ${APP_UPSTREAM} ${TLS_CERTIFICATE} ${TLS_CERTIFICATE_KEY}' \
  < nginx/site.conf.template > /tmp/poker-with-friends.conf
```

Validate the rendered file with `nginx -t` before installing or reloading it. Certificate issuance and the final Nginx destination are host- and distribution-specific.

## 4. Optional production environment generator

For an immutable image tagged with a Git SHA, the helper can create a new production environment and print the random administrator password once. It refuses to overwrite an existing file and must run as root so the result is created with restrictive permissions.

Build the exact revision first:

```bash
cd infra
sha="$(git -C .. rev-parse HEAD)"
docker build --pull --build-arg APP_BUILD_SHA="$sha" \
  -t "poker-with-friends-app:$sha" -f Dockerfile ..
sudo ./scripts/init-production-env.sh \
  "$sha" https://poker.example.com "$PWD/.env"
```

Store the printed administrator password in a password manager. Never put it in shell history, tickets, logs, or version control.

## 5. PostgreSQL backups

The optional host-side scripts stream `pg_dump` from the PostgreSQL container, verify the archive with `pg_restore --list`, install it atomically, and write a SHA-256 sidecar. The default destination is `/var/backups/poker/postgres`; use storage independent from the Docker volume or replicate it through a separately reviewed backup system.

The supplied systemd sandbox permits writes only to that default destination. If `PG_BACKUP_DIR` is changed, add the same absolute path to `ReadWritePaths` in a reviewed unit override.

Install only the PostgreSQL backup files:

```bash
sudo install -d -m 0755 /usr/local/libexec/poker-with-friends
sudo install -m 0755 scripts/lib.sh scripts/pg-backup.sh \
  scripts/pg-backup-retention.sh /usr/local/libexec/poker-with-friends/
sudo install -d -m 0700 /etc/poker-with-friends /var/backups/poker/postgres
sudo install -m 0600 systemd/pg-backup.env.example \
  /etc/poker-with-friends/pg-backup.env
sudo install -m 0644 systemd/poker-pg-*.service \
  systemd/poker-pg-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
```

If `POSTGRES_CONTAINER_NAME` was changed, update `PG_CONTAINER` in `/etc/poker-with-friends/pg-backup.env`. Preview, create one backup, inspect its log, and only then enable the timers:

```bash
sudo /usr/local/libexec/poker-with-friends/pg-backup.sh --dry-run
sudo systemctl start poker-pg-backup.service
sudo journalctl -u poker-pg-backup.service --since today
sudo systemctl enable --now poker-pg-backup.timer poker-pg-retention.timer
```

Retention refuses to delete anything unless the directory contains the marker created by the backup script. Preview it with:

```bash
sudo /usr/local/libexec/poker-with-friends/pg-backup-retention.sh --dry-run
```

A backup is not proven until its checksum is verified and it is restored into an isolated disposable database.

## 6. Upgrade and rollback

### v0.1 to v0.2 identity migration

v0.2 replaces disposable player sessions with permanent accounts, so this upgrade requires an empty Poker with Friends database. Stop the app and every process that can write to the database, verify a final backup, and then either recreate the dedicated database or reset both application-owned schemas:

```sql
DROP SCHEMA IF EXISTS public CASCADE;
DROP SCHEMA IF EXISTS drizzle CASCADE;
CREATE SCHEMA public;
```

Run this only against a database dedicated to Poker with Friends and only when permanent deletion was explicitly approved. Dropping `public` alone is insufficient because `drizzle.__drizzle_migrations` would retain the old migration history and cause the migration runner to skip required tables.

After the reset, continue with the build and migration commands below.

### Standard release update

Use an immutable Git SHA or release tag for `APP_IMAGE_TAG` and record `APP_BUILD_SHA`:

```bash
docker compose build --pull app migrate
docker compose up -d
docker compose ps
```

Before an upgrade, read its release notes, take and verify a database backup, and determine whether the migration is reversible. To roll application code back, restore the previous image tag and run `docker compose up -d`; if a migration is not backward-compatible, follow the release-specific database restore procedure instead of starting old code against the new schema.

Do not run `docker compose down --volumes` in production unless permanent database deletion is explicitly intended and a verified restore is available.

## 7. Operational checks

- Monitor `docker compose ps`, application and reverse-proxy error rates, database volume growth, backup age, and timer failures.
- Restrict read access to `infra/.env` and backups; neither belongs in source control.
- Rotate credentials after suspected disclosure and verify that old sessions or tokens are invalidated.
- Test upgrades and restores on a staging copy before production.
- Re-review privacy, age restrictions, and local gaming rules whenever product functionality changes.
