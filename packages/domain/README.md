# @orch/domain

The cloud server's database code: Drizzle table schemas (`src/schemas/`), the migrations drizzle-kit generates from
them (`migrations/`), `createDb(url)` on Bun's built-in SQL driver, and `createTestDb()` (`@orch/domain/testing`), an
in-memory PGlite database with every migration applied. Only `apps/server` imports this package.

## Commands (from the repo root or this folder)

- `bun run db:generate` writes a new migration after a schema change. Never hand-edit a generated migration.
- `bun run db:migrate` applies pending migrations to `DATABASE_URL` (from the root `.env`).

## Better Auth tables

`user`, `session`, `account` and `verification` are Better Auth's tables. They were generated with `better-auth` and
its CLI (the `auth` package, which replaces the deprecated `@better-auth/cli`) at **1.7.14**, both pinned exactly in
`package.json`, from the config in `scripts/auth-schema.ts` (Drizzle adapter, provider `pg`, `emailAndPassword`
enabled):

```sh
cd packages/domain
bunx auth generate --config scripts/auth-schema.ts --output /tmp/auth-schema.ts --yes
```

The output was split by hand into one file per table in `src/schemas/`, keeping the export names, which Better Auth's
Drizzle adapter looks tables up by. After bumping Better Auth, or enabling a feature or plugin that adds columns,
update `scripts/auth-schema.ts` to match the server's config, regenerate, re-split, then run `bun run db:generate`.
