# Contributing

Thank you for improving Poker with Friends. Keep changes focused, reviewable, and safe for a public repository.

## Development

Use Node.js 24 and the pnpm version declared in `package.json`:

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
docker compose -f infra/docker-compose.dev.yml up -d postgres
pnpm db:migrate
pnpm dev
```

Before opening a pull request, run:

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

## Pull requests

- Explain the user-visible behavior, security boundary, migrations, and rollback impact.
- Add or update tests for changed behavior.
- Do not commit `.env` files, credentials, production logs, database dumps, private card state, real user data, hostnames, IP addresses, or host-specific operational artifacts.
- Use neutral values such as `poker.example.com`, loopback addresses, and clearly marked test identifiers in fixtures and documentation.
- Keep database migrations append-only after publication. Correct a published schema with a new migration.
- Do not combine generated dependency changes with unrelated product changes.

For a vulnerability, follow [SECURITY.md](./SECURITY.md) instead of opening a public issue.
