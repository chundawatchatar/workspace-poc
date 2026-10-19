---
name: host-feature-module
description: How the host (`apps/host`) is organized into feature modules — `<feature>.routes.ts`, `.ws.ts`, `.service.ts`, `.repository.ts` — with every HTTP and WebSocket route defined once in the shared `routes` registry (`packages/shared/src/contracts/`) and called with `callApi`/`buildSocketUrl`. Use when adding or changing a host endpoint, WebSocket, service or feature, or when the web app needs new data from the host.
---

The host is a modular monolith. Each feature is a folder in `apps/host/src/modules/`, and each file in it has **one responsibility**, named by suffix so you can find it by search (`git.service`, `layout.repository`).

```
packages/shared/src/contracts/
  contract.ts                 # Endpoint/Socket types, define*, buildRequest, buildSocketUrl
  git.ts                      # git schemas + gitContract (one file per feature)
  terminals.ts                # terminalSocket: path + URL input schema
  index.ts                    # `routes`: the registry both sides use
apps/host/src/
  index.ts                    # composition root: creates services, starts the server
  app.ts                      # createApp(deps): middleware + mounts every module
  lib/                        # cross-cutting infrastructure (createRouter, localOrigin)
  modules/
    git/
      git.routes.ts           # HTTP binding only
      git.service.ts          # business logic
      git.service.test.ts
    layout/
      layout.repository.ts    # persistence
    terminals/
      terminals.service.ts
      terminals.ws.ts         # WebSocket binding only
    events/  fs/  system/
apps/web/src/lib/api.ts       # callApi(endpoint, input)
```

## What goes in which file

| File | Responsibility | Must not |
|---|---|---|
| `<feature>.routes.ts` | Bind the feature's contract to the service: `createRouter(contract, { op: async (input) => service.op(input) })` | Contain logic, touch the filesystem/processes, or shape data beyond mapping to the response |
| `<feature>.ws.ts` | Bind a WebSocket: parse messages, call services, send events. Exports `create<Feature>Socket(deps)` returning a Hono app | Hold state of its own beyond the connection |
| `<feature>.service.ts` | Business logic. Plain functions when stateless (`getGitStatus`), a class when it holds state (`SessionManager`, `EventHub`) | Know about HTTP, Hono or WebSockets |
| `<feature>.repository.ts` | Persistence: load, save, cache | Contain business rules |
| `<file>.test.ts` | Tests next to the file they test, mostly services | — |

Add only the files a feature needs. `system` has just routes, and `events` has no repository.

## Rules

- **Dependencies point inward:** routes/ws → service → repository. A module may import another module's **service** (git uses `fs.service`), never its routes or ws.
- **Stateful services are created once in `index.ts`** and passed down through `createApp(deps)` and the `create…Socket(deps)` factories. Never create them at import time or use them as module-level singletons. Stateless services are plain imports.
- **Routes are defined once, in shared.** Every HTTP endpoint and WebSocket is declared in `packages/shared/src/contracts/<feature>.ts` and added to the `routes` registry in `contracts/index.ts`. **No route string (`/api/…`, `/ws/…`) is written anywhere else.** The host serves `routes.<feature>`, and clients call `routes.<feature>.<op>`.
  - HTTP: `defineContract({...})` entries with method, the **full path** (`/api/<feature>/<action>`, kebab-case, `:id` for params) and description, plus Zod schemas named `<op>Query`/`<op>Body`/`<op>Response` and exported `z.infer` types. `createRouter(routes.<feature>, …)` won't compile until every operation has a handler, and it rejects invalid input with a 400.
  - WebSocket: `defineSocket({ path: '/ws/…', description, input })`, where `input` is the URL's params and query. The `.ws.ts` validates it the same way (see `terminals.ws.ts`). Message types stay in `protocol.ts`, and the socket's doc comment names them.
- GET input comes from the query string, so fields are strings: use `z.coerce`. Use POST for anything that changes state.
- In React components, call endpoints through TanStack Query with the helpers in `apps/web/src/lib/api.ts`: `useQuery(apiQuery(routes.git.status, { cwd }))` for reads, `useMutation(apiMutation(routes.<feature>.<op>))` for actions. Outside React, use `callApi(routes.git.status, { cwd })`. All three parse the response with the contract's output schema. Open sockets with `` `${HOST_WS}${buildSocketUrl(routes.sockets.terminal, {...})}` `` (this also works in `@orch/ui`). No hand-written URLs, and no casting JSON.
- `lib/` is for infrastructure shared by every module. Feature logic never goes there.

## Adding an endpoint

1. Schema + contract entry in `packages/shared/src/contracts/<feature>.ts`. A new feature file also gets an entry in the `routes` registry in `contracts/index.ts`, plus exports for the schemas and types clients need.
2. Logic in `modules/<feature>/<feature>.service.ts`.
3. Handler line in `<feature>.routes.ts`. A new module is mounted in `app.ts` with `app.route('/api', <feature>Routes)`.
4. Call it from the web app with `apiQuery`/`apiMutation` (or `callApi` outside React).
5. Tests (follow the `write-tests` skill): service behavior in `<feature>.service.test.ts`. Don't re-test validation, params or 400s per endpoint, since `lib/createRouter.test.ts` covers them once.
6. `bun test` and `bun run typecheck`. Changing a contract is a protocol change, and the typecheck shows every caller and handler to update. The `bun --watch` dev host restarts on save, which ends open shells.
