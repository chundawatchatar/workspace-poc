# Architecture

How the code is split so the product can grow into the features planned in `REQUIREMENTS.md` and beyond: remote
access, integrations, user-built flows and an in-browser code editor. Everything is open source under the MIT licence
(`LICENSE`). The rules below keep the code separable, so parts could be closed later without a rewrite.

## The pieces

```
web (apps/web)                            client (apps/client)
  the local app, opened on the              the global app (Orchestrator), opened from any
  user's own machine                        browser: sign in, pick a machine
        │                                         │
        └──── both render packages/terminal-ui ───┘
        │  local transport                        │  remote transport
        ▼                                         ▼
  http://127.0.0.1                        server (apps/server) ── relays frames by machine id, never decides access
        │                                         │  one outbound WSS tunnel per machine
        ▼                                         ▼
host (apps/host) ── the product: terminals, files, git, secrets, connectors, flows
   │
   └─ terminal daemon (apps/ptyd-bun), the user's repos, .data/
```

| App | What it is | Runs where |
| --- | --- | --- |
| `apps/host` | The product's backend: terminals, files, git, and later secrets, connectors and flows. Code, credentials and flow state stay here (local first). | The user's machine |
| `apps/web` | The local app. No accounts. Talks to the host on `127.0.0.1`. | The user's browser, same machine |
| `apps/client` | The global app (Orchestrator): sign-in, the list of linked machines and whether they're online (REM-1, REM-4), and opening any of them from any browser. | Any browser |
| `apps/server` | The cloud server. Relays traffic between browsers and machines over the tunnel, and later serves `apps/client` and its accounts API. | The cloud |

## Two apps, one page: `packages/terminal-ui`

`web` and `client` are separate apps with their own shell, routing and sign-in. The page a user sees *inside* a
machine is the same in both, so it lives in one package, `packages/terminal-ui`, and the two can't drift apart (UI-5).

`terminal-ui` is the whole page: the layout with splits and tabs, terminals, the sidebar, the command palette,
shortcuts, notifications and the store behind them. Most of this lives in `apps/web` today (about 2,500 lines) and
moves into the package.

| Package | Holds | Depends on |
| --- | --- | --- |
| `packages/ui` | Presentational building blocks and themes: `TerminalView` (xterm), modals, toasts, icons. Data and callbacks come in as props. | `shared` |
| `packages/terminal-ui` | The whole workspace page, connected to a host. | `ui`, `shared` |

The differences between the two apps come in as props on the page's root component:

```ts
interface TerminalUIProps {
  transport: HostTransport      // local: 127.0.0.1 · remote: through the server, for one machine
  navigate: Navigate            // each app owns its router; the page asks it to change route
  machine?: { id: string; name: string }  // client only: which machine is open, named in the sidebar
  header?: ReactNode            // client only: back to the machine list, account menu
  offlineHint?: ReactNode       // what to do when the host is offline
  deniedHint?: ReactNode        // what to do when the host rejects the access key
  titleSuffix?: string          // follows the workspace name in the document title
  children: ReactNode           // the main area, from the app's router outlet (home, workspace or not found)
}
```

The remote transport sends requests to `/m/<machineId>/api/*` and sockets to `/m/<machineId>/ws/*` on the server.
The machine's access key goes in the `x-orch-access-key` header, or in an `{ type: 'auth', key }` first message on a
socket, never in a URL. These pieces live in `packages/shared/src/contracts/remote.ts`.

`apps/web` becomes a thin shell that renders `terminal-ui` with the local transport. `apps/client` renders it with
the remote transport for the machine the user picked. Neither app reimplements anything inside the page. When a new
difference appears, it becomes another prop, never an `if (isClient)` check inside the package.

## Rules that keep the future cheap

### 1. Dependencies point one way

```
apps/web, apps/client ─► packages/terminal-ui ─► packages/ui ─► packages/shared
apps/server ─► packages/domain ─► packages/shared
apps/host ─► packages/terminal, packages/connectors (future) ─► packages/shared
```

- `packages/*` never import from `apps/*`, and `apps/web` and `apps/client` never import from each other.
- Code that might be closed later (accounts, billing, hosted flows, paid connectors) lives in its own app or package
  and uses only the public exports of the others. Nothing else imports it.
- Only `apps/server` imports `packages/domain` (the database schemas, migrations and client), so no browser app or
  the host ever pulls in database code.
- App code reaches the database only through `domain.forUser(principal)`, whose repositories add
  `userId = principal.userId` to every query, so a handler can't forget it. `forAuthLibrary()` is for Better Auth's
  adapter only; `skipAuthorization(reason)` needs a real reason and is logged on every call. Every new table with a
  `userId` column must be registered in `scopedTables`, which a test enforces.
- `packages/shared/src/contracts` is the boundary. Any two parts talk only through a contract defined there.
- The cloud server's own API lives under `/api` on the server and is defined in `serverRoutes`, a registry separate
  from the host's `routes`. Host routes are relayed under `/m/<id>/api/*` and checked only by the host; server routes
  are served by `apps/server` itself, default to `auth: 'user'`, and refuse a non-GET request without a same-site or
  trusted `Origin` and a JSON `Content-Type`. `/api/auth/*` is Better Auth's and is never in `serverRoutes`. The
  accounts modules are mounted only when `DATABASE_URL` is set, and the server refuses to start against an
  unreachable or unmigrated database.
- An `auth: 'user'` endpoint reads its session only through Better Auth's `auth.api.getSession`
  (`apps/server/src/modules/auth/auth.middleware.ts`), never by reading the cookie, after the origin and content-type
  checks, so a cross-site request costs no database read. No valid session means 401 `unauthorized`, and a failed
  lookup (a database outage) means 500 `internal`, never a pass; the reported error keeps only the cause's name and
  code, since a database error quotes the session token. The handler gets `principal` (`userId`, `email`, `name`)
  and `data`, the principal's scoped repositories from `forUser`, and never the `Domain`, `forAuthLibrary()` or
  `skipAuthorization`: the router is given `forUser` as a closure, not the domain. The lookup passes
  `disableRefresh`, so it never extends a session; Better Auth's own `/api/auth/get-session` extends the session and
  its cookie together.
- Better Auth (pinned at 1.7.14, the version `packages/domain` generates its tables with) owns `/api/auth/*`, in
  `apps/server/src/modules/auth/`. It gives email-and-password sign-up with required email verification, sign-in,
  sign-out and password reset, and sends its emails through the mailer. It reaches the database only through
  `domain.forAuthLibrary()`. Sessions live in the database, and the cookie cache is off, so every request reads the
  session there and a sign-out or a password reset (which revokes every session) ends a session on its very next
  request. Accounts never replace a machine's access key.
- Sessions can be listed and ended, and each revocation takes effect on the session's very next request, both in
  Better Auth and in our `auth: 'user'` endpoints. A user has Better Auth's core endpoints:
  `GET /api/auth/list-sessions` (their own sessions only), `POST /api/auth/revoke-session` (one session by its token,
  only if it is theirs), `POST /api/auth/revoke-other-sessions` (all but the current one) and
  `POST /api/auth/revoke-sessions` (all, including the current one). The revoke endpoints go through the same origin
  check as every other `POST`. An operator signs one user out everywhere with
  `bun run --filter @orch/server sessions:revoke-user <email>` (or `bun apps/server/scripts/revoke-user-sessions.ts
  <email>`), which deletes the user's `session` rows through `skipAuthorization` and prints only the count.
- Accepted risk, freshness: `list-sessions` refuses a session older than `session.freshAge` (one day, set in
  `createAuth`) with 403 `SESSION_NOT_FRESH`, while the revoke endpoints only need a valid session. A page that lists
  devices must ask for a fresh sign-in first.
- Open question, tokens: Better Auth's `list-sessions` answers each session's `token`, which `revoke-session` takes.
  That hands the secrets of the user's other sessions to page JavaScript and weakens `HttpOnly`. We keep the stock
  behaviour for now; dropping the tokens means our own revoke-by-id endpoint in `serverRoutes`.
- The session cookie is `Path=/api`, `HttpOnly`, `Secure` and `SameSite=Lax`. Browsers never send it to the relayed
  machines under `/m/*`, and the relay drops `Cookie` there as well. Its name has the `__Secure-` prefix when
  `BETTER_AUTH_URL` is `https://` and none on `http://`.
- Better Auth checks the `Origin` of non-GET requests against `SERVER_TRUSTED_ORIGINS` plus the origin of
  `BETTER_AUTH_URL`, and rate limits by client IP in memory (per process, reset on restart). The IP comes from the
  `x-orch-client-ip` header the auth routes set from the server's own client IP reader, replacing any value a client
  sent, so a spoofed `X-Forwarded-For` counts only when `SERVER_TRUST_PROXY` is on.
- Account enumeration: with `requireEmailVerification` on, Better Auth 1.7.14 answers a sign-up for an already
  registered email exactly like a new one (the same status, a synthetic user of the same shape, no cookie, no
  `USER_ALREADY_EXISTS`) and creates nothing (`sign-up.mjs`, `shouldReturnGenericDuplicateResponse`). The accepted
  risk is timing: a new sign-up waits for the verification email to send and a duplicate sends nothing, so response
  times can still differ. If the mailer fails during sign-up, Better Auth logs the failure and still answers 200; the
  user exists unverified and recovers through a later "resend" page.
- The server sends email only through the mailer (`apps/server/src/modules/mailer/`), one template file per email,
  as plain text plus HTML over SMTP (Mailpit in development). Tests read emails from the capturing transport in
  `mailer.testing.ts` instead of a network. Emails carry single-use links, so the link, tokens, the recipient, the
  subject and `SMTP_URL` are never logged: a send logs only its template name and outcome, and a failure keeps only
  the SMTP error code.
- Server-side config comes from the root `.env` through `loadRootEnv()` (`@orch/shared/env`, Node-only, kept out of
  the browser entry), which never overrides variables already set.

### 2. The host is a set of modules, assembled in one place

Today `apps/host/src/app.ts` mounts each module by hand. Change it to a list of modules, each implementing one
interface:

```ts
interface HostModule {
  name: string
  routes?(deps: AppDeps): Hono   // HTTP and WebSocket routes from the shared `routes` registry
  start?(deps: AppDeps): void    // background work: watchers, schedulers, tunnel
  stop?(): Promise<void>
}
```

`index.ts` builds the list. A different build (a closed distribution, a test) passes a different list. Connectors,
flows and the editor's file access each arrive as a module, never as edits to other modules. `apps/server` follows
the same pattern.

### 3. The page is a set of surfaces

`SurfaceKind` in `packages/shared/src/model.ts` is a closed union (`terminal | pulls | issues`). Turn it into a registry
in `terminal-ui`: each surface kind (terminal, editor, flow, pull request…) registers its title, icon and component.
The layout model stores only the kind's id and its own small state, so a new kind needs no changes to the layout code,
and an app can register kinds this repo doesn't ship.

### 4. One transport, swappable

All host calls already go through `callApi` and `buildSocketUrl`. Put them behind a `HostTransport` (base URL and how
the access key is attached) with two implementations, local and remote. The app passes one into `terminal-ui`, and
nothing inside the page knows which one is in use. End-to-end encryption (REM-2) later becomes a third
implementation, not a rewrite.

### 5. Identity is a list of keys, not one key

Accounts and device approval (REM-1, REM-5) come later, but store remote access keys as a list from the start:
`{ id, name, hash, createdAt, lastUsedAt }`. Store only the hash. The host checks every tunneled request with one
function, `authorize(request) → principal | null`. One key with "rotate" is then the special case of the list, and
per-device keys, revoking a single device or linking to an account change data, not the design.

### 6. Persistence behind repositories, on SQLite

`state.json` suits the layout but not run logs, credentials or flow history. Move to `bun:sqlite` in `.data/` before
flows or connectors land. Modules already reach storage through `<feature>.repository.ts`, so only the repositories
change.

### 7. Secrets are a module of their own

A host `secrets` module stores credentials (connector tokens, flow secrets) encrypted at rest. The browser can create,
replace and delete a secret but never read one back. Connectors and flows refer to secrets by name, and secret values
never appear in logs, events or tunnel frames to the browser. Using a secret from an event-started agent needs the
user's approval (AG-7).

## Planned features on this base

### Remote access (in progress, see the factory backlog)

**Decision:** the first version relays plain frames inside TLS, so the server can read the traffic. End-to-end
encryption (REM-2) comes later, by adding a sealed frame type: its payload is an inner frame encrypted between the
browser and the host, with keys from a handshake the server passes along but can't read. Only the browser and the
host change; the server keeps routing the same way.

That only stays easy if every remote access job keeps these rules:

- **The server routes on the envelope, never the contents.** It may read the machine id, the frame type, the request
  or channel id, and frame sizes. It never reads, rewrites or decides anything from the method, path, headers, body or
  response status. The only responses it makes up itself are 403 (an `Origin` it does not allow), 429 (a rate
  limit), 502 (machine offline) and 504 (timeout), plus its own answers to CORS preflights, which never reach the
  machine. Origin checks, CORS and rate limits read only the outer request: its `Origin` and `Host` headers, the
  socket address and the machine id in the URL. Dropping the machine's `Access-Control-*` headers is a filter on
  header names, like the hop-by-hop list. So is dropping `Cookie` from every relayed request and socket upgrade, and
  `Set-Cookie` from every machine response: machines share the server's origin, where the account session cookie
  lives, so they never see or set account cookies. Cookie values are never read.
- **Only the host checks access.** The access key travels in a header and the first socket message, and the server
  never checks it.
- **The host reports problems the server must react to as control frames.** Rate-limiting bad access keys must not
  work by the server reading a 401. The host sends a control frame such as `auth.failed` for the request, which keeps
  working once the request itself is encrypted.
- **One choke point in the browser.** All remote traffic goes through the remote `HostTransport` (rule 4), so the
  browser side of encryption goes in one place.
- **The protocol is versioned.** The `hello` frame already carries a version. Adding sealed frames means a new version,
  and a server that doesn't know it rejects the connection clearly instead of misreading frames.
- **`apps/client`'s build stays static.** It is a TanStack Start app in SPA mode: the build prerenders only the root
  shell into `index.html` next to its assets, and no server bundle runs at request time. It gets no configuration
  injected by the server, so it can later be served from an origin the server doesn't control. A server that serves the app could also serve modified JavaScript, which
  would defeat end-to-end encryption.

#### Keeping the machine connected

The machine keeps one **always-on outbound WebSocket** to the server over port 443, as ngrok, VS Code Remote Tunnels
and Cloudflare Tunnel do. Polling adds up to a whole interval of delay to every keystroke, so it's unusable for
terminals. An idle socket costs one TCP connection and a small ping, and one small VM holds thousands of them.

- **Heartbeats from both sides.** The server pings and drops a silent machine (job 005). The host also needs its own
  timeout: after sleep or a network switch a TCP connection can look open while it's dead, and only the host's side
  notices. Ping every 20–25 seconds, because many proxies and NATs drop idle connections after 30–60 seconds.
- **Reconnect with backoff and full jitter.** Start at about 1 second and double up to 30 seconds, randomized so
  thousands of machines don't reconnect at once after a server restart. Reset the backoff once a connection has been
  stable for a while.
- **Fail fast while disconnected.** In-flight requests get a 502 at once instead of hanging. The browser shows
  "reconnecting" and reattaches terminals when the tunnel is back.
- **Don't let one transfer block typing.** All channels share one socket. Split large bodies into chunks, send terminal
  frames first, and give each channel flow control, so a big download doesn't delay keystrokes and a slow browser
  doesn't fill the server's memory.
- **More than one server instance.** A browser request must reach the instance holding that machine's socket: keep a
  shared map of machine id to instance (for example Redis) and forward between instances, or use a host that can
  replay a request to the right instance. Not needed until one instance isn't enough.

**Later options, only if a real problem shows up:**
- A long-polling or Server-Sent Events fallback for networks that block WebSockets.
- A QUIC tunnel, for networks that change often.
- Peer-to-peer WebRTC or WireGuard, with the server only for signalling and as a fallback, if its bandwidth or
  latency becomes a cost.

### Code editor

- Extend the host `fs` module with read, write, stat and watch. Every path resolves (realpath) inside an open
  workspace's folder, so `..` and symlinks can't escape. Set a file size limit. Writes send the version that was read,
  and a stale write is rejected instead of overwriting.
- Add an `editor` surface to `terminal-ui`, wrapping CodeMirror 6. It is lighter than Monaco and takes colours from
  the existing themes. Both apps get it at once.
- Language features later: the host runs language servers and bridges them over a WebSocket from the `routes`
  registry. The tunnel already carries WebSocket channels, so this also works remotely.

### Integrations (connectors)

A `packages/connectors` package where each connector implements one interface:

```ts
interface Connector {
  id: string                                   // 'github', 'linear', 'slack'…
  auth: { kind: 'oauth2' | 'token' | 'none'; scopes?: string[] }
  actions: Record<string, { input: ZodType; output: ZodType; run(ctx, input): Promise<unknown> }>
  triggers: Record<string, { payload: ZodType; verify(request): Promise<unknown | null> }>
}
```

- Connectors run in the host, with credentials from the `secrets` module.
- **Webhooks** need a public URL. The server gets a route such as `/hooks/:machineId/:connectorId` and passes the
  request through the tunnel. The connector's `verify` checks the provider's signature on the host. Without the
  server, triggers fall back to polling.
- **OAuth** needs a fixed callback URL. The server hosts it and passes the code through the tunnel. Until then, use
  personal access tokens.
- Each connector has three consumers: the UI, flow steps, and agents. Exposing the actions as an MCP server from the
  host lets the user's own agents use them, in line with "bring your own agent".
- Start with GitHub and Linear. WhatsApp needs Meta business approval, so it comes last.

### Flows (user-built workflows)

Call this feature **Flows**, so it isn't confused with Orchestrator, the global app. It also covers GIT-4 (Actions
workflows) and AG-6 (events that start agents), so there is one engine, not three.

- **Definition:** a versioned JSON document validated by a Zod schema in `packages/shared`, stored in the workspace
  (for example `.orch/flows/<name>.json`), so flows live in git with the code.
- **Steps:**
  - Triggers: connector trigger, git event, schedule, manual.
  - Steps: run an agent in a pane, connector action, shell command, condition, parallel/wait-for-all, wait for a human.
- **Engine:** a host `flows` module that appends every step transition to a run log in SQLite, so a host restart
  resumes runs instead of losing them. Steps are retried, and each records its inputs and outputs.
- **Import:** GitHub Actions YAML is compiled into the same model, not run by a second engine.
- **Order:** engine and JSON first, with the factory loop (spec → build → parallel review → approve) as the first real
  flow. A visual canvas in `terminal-ui` comes after, editing the same JSON. Don't embed n8n: its licence forbids
  commercial embedding.

## Suggested order

1. Finish the server and host parts of the remote access backlog, with rule 5 applied to its access-key item.
2. Extract `packages/terminal-ui` from `apps/web` with the `HostTransport` (rule 4), then build `apps/client` on it.
   This replaces the "remote mode in the web app" item in the backlog.
3. Module list in the host (rule 2) and surface registry in `terminal-ui` (rule 3). Both are small refactors that
   unlock everything after.
4. SQLite (rule 6) and the `secrets` module (rule 7).
5. Code editor.
6. Connector interface, with GitHub and Linear.
7. Flows engine, with the factory ported onto it.
8. Visual flow builder and more connectors.
