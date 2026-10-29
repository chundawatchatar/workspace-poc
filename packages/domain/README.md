# @orch/domain

The cloud server's database code: Drizzle table schemas (`src/schemas/`), the migrations drizzle-kit generates from
them (`migrations/`), and `createDomain(url)`, the only way into the database, on Bun's built-in SQL driver. Tests use
`createTestDomain()` and `createTestDb()` from `@orch/domain/testing`, on an in-memory PGlite database with every
migration applied. Only `apps/server` imports this package.

## Commands (from the repo root or this folder)

- `bun run db:generate` writes a new migration after a schema change. Never hand-edit a generated migration.
- `bun run db:migrate` applies pending migrations to `DATABASE_URL` (from the root `.env`).

## Reaching the database

The package hands out no raw Drizzle client. `createDomain(url)` returns a `Domain` with three doors:

- `domain.forUser(principal)` is the one app code uses. It returns one repository per table in `scopedTables`
  (`src/scoped-tables.ts`), each with `list(where?)`, `find(where)`, `insert(values)`, `update(where, values)` and
  `delete(where)`. Every query is ANDed with `userId = principal.userId`, so a `where` can narrow the rows but never
  reach another user's. `insert` takes the `userId` from the principal, and `update` rejects a `userId`, so a row can
  never move to another user. `where` is a Drizzle `SQL` condition, such as `eq(schema.machines.id, id)`. A
  principal without a `userId` throws.
- `domain.forAuthLibrary()` returns the raw client with the schema attached. Pass it to Better Auth's `drizzleAdapter`
  and nowhere else. It is not logged, since Better Auth uses it on every request.
- `domain.skipAuthorization(reason)` returns the raw client, which sees every user's rows, for the rare job that needs
  it (a backfill, an admin report). The reason is required and logged on every call, so make it real and keep secrets
  out of it.

`domain.close()` closes the connection.

### Adding a table with a `userId` column

1. Add the table to `src/schemas/` and run `bun run db:generate`.
2. Register it in `scopedTables` under the repository name handlers will use, for example `machines: machine`.

`scoped-tables.test.ts` fails if a schema table with a `userId` column is neither registered nor one of Better Auth's
tables (`authLibraryTables`). Relational queries (`db.query.*`), transactions and joins are not on scoped repositories
yet.

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
