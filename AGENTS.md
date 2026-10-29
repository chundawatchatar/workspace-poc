# AGENTS.md

Instructions for AI coding agents working in this repository. Shared by Claude Code (via `CLAUDE.md`), Codex and Gemini CLI.

## Commands

- Bun workspaces monorepo (`apps/web`, `apps/client`, `apps/site`, `apps/host`, `apps/ptyd-bun`, `apps/server`, `packages/shared`, `packages/domain`, `packages/terminal`, `packages/ui`, `packages/terminal-ui`). Use `bun`, never npm/yarn/pnpm. `bunfig.toml` hoists all dependencies into the root `node_modules`.
- `bun run dev` starts both apps: web on 127.0.0.1:3210 (strict port), host on 127.0.0.1:4599. It does not start the client.
- `bun run dev:client` starts the global app (`apps/client`) on 127.0.0.1:3220 and the cloud server (`apps/server`) on 127.0.0.1:4600, set up to talk to each other. To reach this machine through them, run `bun run dev` in another terminal with `SERVER_URL=ws://127.0.0.1:4600 CLIENT_URL=http://127.0.0.1:3220`.
- `bun run dev:site` starts the marketing site and docs (`apps/site`, Astro, static) on 127.0.0.1:3230. Its name, links and prices live in `apps/site/src/site.config.ts`; docs pages are Markdown in `apps/site/src/content/docs/`.
- `bun run db:up` starts the dev Postgres and Mailpit from `compose.yaml` (localhost-only ports; inbox on http://127.0.0.1:8025) and waits until Postgres is healthy. `bun run db:down` stops them and keeps the data. Copy `.env.example` to `.env` first.
- `bun run db:generate` writes a new migration into `packages/domain/migrations/` after you edit a schema in `packages/domain/src/schemas/`; commit it, and never hand-edit a generated migration. `bun run db:migrate` applies pending migrations to `DATABASE_URL` (run `bun run db:up` first).
- Server-side settings live in the root `.env` (gitignored; `.env.example` is the committed template). Server-side entry points, such as `apps/server` and a future `drizzle.config.ts`, call `loadRootEnv()` from `@orch/shared/env` before reading `process.env`, since Bun only auto-loads `.env` from the working directory. The shell environment wins over the file. Never load it in browser apps.
- Verify changes with `bun run typecheck` (runs `tsc` in every workspace) and `bun test`.
- Tests use Bun's built-in runner and live next to the source as `*.test.ts`. Keep them few and behavior-focused (see the `write-tests` skill). `bun run test:coverage` shows coverage.
- `bun run lint` / `bun run format` run Biome (`biome.json` at the root) on the whole repo. After editing, format only the files you changed: `bunx biome check --write <files>`.
- Silence a lint rule for one line with `// biome-ignore lint/<group>/<rule>: <reason>` (`{/* … */}` inside JSX), and always give the reason.

## Code style

- No semicolons, single quotes, 2-space indent, 120-column lines. Biome enforces this.
- `verbatimModuleSyntax` is on: import types with `import { type X }` / `import type`.
- `noUnusedLocals` and `noImplicitOverride` are on: remove unused bindings, and mark overrides with `override`.

## Architecture gotchas

- `packages/shared` holds the layout model, its reducer and the wire protocol (`protocol.ts`). It is consumed as raw TS (`exports: ./src/index.ts`), so it has no build step. Protocol changes must be made on both the host and the web side. Its one server-only helper, `loadRootEnv()`, is the subpath export `@orch/shared/env` and is never re-exported from `index.ts`, which browser code imports.
- `packages/domain` holds the cloud server's database code (Drizzle schemas, migrations, `createDomain`), consumed as raw TS. Only `apps/server` imports it, never `apps/client`, `apps/web`, `apps/host`, `packages/shared`, `packages/ui` or `packages/terminal-ui`. One table per file in `src/schemas/`. The Better Auth tables (`user`, `session`, `account`, `verification`) come from its CLI; regenerate them as `packages/domain/README.md` describes, never by hand. App code reaches the database only through `domain.forUser(principal)`, whose repositories scope every query to the principal's `userId`. `forAuthLibrary()` is for Better Auth's `drizzleAdapter` only, and `skipAuthorization(reason)` needs a real reason and is logged. Every new table with a `userId` column must be registered in `scopedTables` (`src/scoped-tables.ts`); a test fails otherwise. Tests get a migrated in-memory database from `createTestDomain()` / `createTestDb()` in `@orch/domain/testing` (PGlite, no Docker, never reads `DATABASE_URL`). `"user"` is a reserved word, so quote it in hand-written SQL.
- `packages/ui` holds the shared, presentational UI (components, themes, `styles.css`), consumed as raw TS like `packages/shared`. It is reused by a closed-source app, so components take data and callbacks as props and never import from an app (store, commands, router). `packages/terminal-ui` wraps them to connect its store.
- `packages/terminal-ui` holds the page inside a machine (sidebar, layout, terminals, palette, shortcuts, overlays, toasts and their store), consumed as raw TS. Its root `<TerminalUI>` takes a `HostTransport` (every request and socket goes through it) and navigation callbacks as props. Like `packages/ui`, it never imports from an app (router, app store); differences between apps come in as props, never as app checks (`isClient`, `isLocal`, …).
- `apps/web` is a thin shell: the document, the TanStack Router routes and a `<TerminalUI>` with a local transport. Page code goes in `packages/terminal-ui`.
- `apps/client` is the global app: a static Vite SPA with code-based TanStack Router routes (no Start, no SSR, no generated route tree). It renders `<TerminalUI>` with `createRemoteTransport` for a machine saved in `localStorage` from a connect link (`#machine=<id>&key=<key>`). It imports only `@orch/terminal-ui`, `@orch/ui` and `@orch/shared`, never `apps/web`.
- Both apps pass their router outlet to `<TerminalUI>` as `children`, rendering `HomeView`, `WorkspaceView` or `NotFound` from `@orch/terminal-ui`.
- Import icons from `@orch/ui/icons` (lucide-react, re-exported), never from `lucide-react` directly.
- The host is organized into feature modules (`apps/host/src/modules/<feature>/`), one responsibility per file: `.routes.ts` (HTTP), `.ws.ts` (WebSocket), `.service.ts` (logic), `.repository.ts` (persistence). Every HTTP and WebSocket route is defined once in the `routes` registry in `packages/shared/src/contracts/` (full path + Zod schemas). The host serves it, and clients call it with `callApi`/`buildSocketUrl`, so never write `/api` or `/ws` paths by hand. Follow the `host-feature-module` skill.
- The host owns the shells (Bun's built-in PTY, so macOS/Linux only) and the layout state. State persists in `apps/host/.data/state.json` (gitignored); delete it to reset the layout.
- `apps/web/src/routeTree.gen.ts` is generated by TanStack Router. Never edit it by hand.
- New themes are added to the end of `packages/ui/src/themes.ts`.

## Skills

- Agent skills live in `.agents/skills/<name>/SKILL.md` (the Agent Skills format). Add new skills there, not in a tool-specific folder.
- Claude Code reads `.claude/skills/`, so each skill also needs a symlink: `ln -s ../../.agents/skills/<name> .claude/skills/<name>`.

## Repo etiquette

- Feature branches and PRs are preferred. Before committing on `main`, ask the user whether to commit there or create a branch.
- Commit messages are a single line unless a summary body is really needed (see the `commit` skill).
- `.temp/` is the user's personal scratch area. Ignore it, and don't edit it.
