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
- How to run and change accounts (database, migrations, Better Auth, sessions, emails, machine keys) is in
  [accounts](accounts.md); the rules below are what it must keep.
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
  `createAuth`) with 403 `SESSION_NOT_FRESH`, while the revoke endpoints only need a valid session. The client's
  `/account` page then says a recent sign-in is needed to see devices, and its "Sign in again" button signs out and
  opens `/auth/sign-in?redirect=%2Faccount`. Changing the password and signing out from all devices still work there.
  Revoking one session needs a fresh session too, since it lists the sessions again to find the token, but the table
  only shows once a list succeeded.
- Resolved for now, tokens: Better Auth's `list-sessions` answers each session's `token`, which `revoke-session`
  takes. The client keeps them out of the query cache: `sessionsQuery` (`src/lib/accountSessions.ts`) returns rows
  without the token, and `revokeSession` lists the sessions again at revoke time and keeps the token only in that
  call. The tokens still reach page JavaScript briefly in those responses, which weakens `HttpOnly`; removing them
  means our own revoke-by-id endpoint in `serverRoutes`.
- The session cookie is `Path=/api`, `HttpOnly`, `Secure` and `SameSite=Lax`. Browsers never send it to the relayed
  machines under `/m/*`, and the relay drops `Cookie` there as well. Its name has the `__Secure-` prefix when
  `BETTER_AUTH_URL` is `https://` and none on `http://`.
- In `apps/client`, `src/lib/auth.ts` is the one place that knows who is signed in. The session is a TanStack Query
  entry under `['session']` (`sessionQuery`, through Better Auth's client on the page's own origin), holding only the
  user's `id`, `email` and `name`, never a token; the root layout observes it, so it refetches when the window
  regains focus, which is how a sign-out in another tab is noticed. Every query that holds account data is keyed
  `['account', userId, ...]` through `accountKey` or `accountQuery` (signed-in `serverRoutes` endpoints), and
  `serverQuery` takes only `auth: 'public'` endpoints. An identity watcher on the router's query client acts
  whenever the user id changes (sign-in, sign-out, another account): it cancels in-flight queries, so a late answer
  for the old user never lands, removes every query and mutation but the session, clears the pending machine link
  (`src/lib/pendingLink.ts`) on a sign-out or an account switch but keeps it when a signed-out session signs in, and
  invalidates the router so the guards run again. A query or
  mutation that fails with `unauthorized` reads the session again, so a session revoked elsewhere takes the same
  path. Guarded routes (`/`, `/account` and `/m/$machineId` with its children) use `requireSession` as `beforeLoad`, which sends
  a signed-out user to `/auth/sign-in?redirect=<path and search>`. `/auth/sign-in` itself is never guarded, and
  after signing in it goes to `safeRedirect(redirect)`: the value only when it is a path on this origin (one leading
  `/`, not `//` or `/\`, no control characters) and not a page under `/auth`, else `/`. The `/auth` check runs on the
  decoded, lowercased path with trailing slashes removed (dot segments already resolved), so `/AUTH/`, `/./auth` and
  `/%61uth/sign-in` are refused too, a path that fails to decode goes home, and `/authors` is still allowed. The
  prerendered shell never reads the session.
- The client's auth pages live under the `/auth` layout route (`src/routes/auth.tsx`): it draws the product's mark,
  name and subtitle (`BrandMark`, `PRODUCT_NAME` and `PRODUCT_TAGLINE` from `@orch/ui`, which the site and the
  favicon share) above the page's `AuthCard`, whose title is the page's only `h1`, using theme tokens only, so it
  reads in every light and dark theme. `/auth` itself opens `/auth/sign-in`, keeping `redirect`. The layout is
  neither guarded nor left when signed in; each page decides with its own `beforeLoad`.
- The client's `/auth/sign-in` and `/auth/sign-up` pages are never guarded; a signed-in visit to either goes straight
  to `safeRedirect(redirect)` (`leaveIfSignedIn`), and each links to the other carrying `redirect` along. Their forms
  use TanStack Form with the Zod schemas in `src/lib/authForms.ts` (Zod 4 is a Standard Schema, so no adapter) and
  the presentational `TextField`, `PasswordField`, `Button` and `FormError` from `@orch/ui`, which take plain values
  and callbacks so other apps can drive them with any form library. A field shows its error only once it has been
  left or the form submitted, a failed submit focuses the first invalid field, and a second submit while one is in
  flight sends nothing. The schemas only catch mistakes early (the password's 8 to 128 characters mirror Better
  Auth's defaults); the server stays the authority. A new submit clears the last form-level error before its request
  goes out, and a successful sign-up empties the form before showing "Check your inbox", whose heading then takes
  focus. Neither page keeps the email or password outside the form state, logs them or puts them in the URL.
- The client's email pages live under `/auth` too. Sign-up success is an in-page "Check your inbox" state
  (`src/components/CheckInbox.tsx`), so the address never enters the URL; its "Send the link again" button posts
  `/api/auth/send-verification-email` and then stays off for 30 seconds (not kept across a reload; Better Auth's limit
  of 3 a minute is the real guard). `/auth/verify-email` verifies the token from its link once, with
  `GET /api/auth/verify-email?token=…`, and never signs in; with a refused token (one message for expired, invalid and
  unknown user) or none it shows a resend form. `/auth/forgot-password` posts `/api/auth/request-password-reset`, and
  `/auth/reset-password` posts `/api/auth/reset-password` with the link's token and the new password, then reads the
  session again, since the reset ends every session of the account. Resend and forgot-password give the same
  confirmation whether or not the address has an account, as the server does. Only `/auth/forgot-password` uses
  `leaveIfSignedIn`: a verify or reset link may be opened while signed in. The sign-in page links to forgot-password
  and to verify-email's resend form.
- Emailed links carry their token in the fragment: the server builds them from the origin of `BETTER_AUTH_URL` and
  the token Better Auth hands its email callbacks (`emailLinkUrl` in `auth.service.ts`), as
  `/auth/verify-email#token=<t>` and `/auth/reset-password#token=<t>`, never Better Auth's own `url`. Browsers never
  send a fragment, so the token stays out of server logs and `Referer`. `acceptEmailLinkToken` (`src/lib/emailLink.ts`)
  runs in `getRouter()` next to `acceptConnectLink`, and again on `popstate` (registered before the router's own
  listener) for a link opened in a tab already on its page: it keeps the token in a module variable and replaces the
  URL with the same path and search, so the token never enters the router's location or history, a query key or
  storage. The page takes it once with `takeEmailLinkToken(page)`, and calls `verifyEmailToken` or `resetPassword`
  directly, never as a query. A reload finds no token and shows the page's no-token state. Better Auth's
  `/api/auth/reset-password/<token>` GET endpoint stays mounted, but no email links to it.
- Accepted for development, accounts are required by the client: with `DATABASE_URL` unset the server answers 404
  for `/api/auth/*`, the session reads as signed out, and the user is sent to a sign-in that can't work.
  `.env.example` sets `DATABASE_URL`.
- The client's home page lists the signed-in account's machines (`src/lib/accountMachines.ts`, `machinesQuery`:
  `accountQuery` on `serverRoutes.machines.list`, so its key is `accountKey(userId, ...)`), in the server's order,
  each marked Online or Offline. It refetches every 10 seconds while the page is open, since `online` changes without
  any client action. `online` reflects only the relay's tunnel registry, so Offline can also mean a host that is up
  with remote access off. Rename (an inline TanStack Form with `machineNameSchema`) and unlink invalidate the list;
  unlink also forgets the machine's local key, since the list no longer shows local-only machines and a key left
  behind could never be seen or removed. Open question: whether unlink should ask for confirmation.
- The client's `/account` page is reached from the account menu (`src/components/AccountMenu.tsx`: the user's email
  as a button opening "Account" and "Sign out"), shown in the home page's title row and in the machine page's sidebar
  `header`. It changes the password with Better Auth's `change-password` and `revokeOtherSessions: true`: Better Auth
  1.7.14 deletes every session of the user and starts a new one for this browser, so the user stays signed in under a
  new session id (the user id is unchanged, so the identity watcher does nothing), and the token it answers is
  dropped. Its sessions table (TanStack Table) shows each session's device (parsed from the user agent), IP address
  (from `x-orch-client-ip`, so a proxy's address without `SERVER_TRUST_PROXY`), created and last active times, and
  marks the one whose id matches `get-session` as "This device". "Last active" is Better Auth's `updatedAt`, which
  moves only when the session is renewed (`updateAge`, a day), so it is approximate. Every other row can be revoked;
  "Sign out from all devices" asks for confirmation, then calls `revoke-sessions` (this session included) and marks
  the session as signed out. A 401 from any of these calls reads the session again, so a session revoked elsewhere
  lands on sign-in.
- Resolved, saved machines: the access keys saved in `localStorage` (`orch-machines`) are still per browser, not
  per user, but they no longer decide what the home page lists. They only decide whether a listed machine has an
  Open link; a machine without a key here says "Open the connect link on this device", as its `/m/<id>` page does.
  A machine saved locally that the account doesn't have is not listed (linking those is not done). The keys stay in
  `localStorage`, readable by any script on this origin, and the host still checks the key on every request.
- A connect link opened in the client saves the key locally and records a pending link in `localStorage`
  (`orch-pending-machine-link`, `src/lib/pendingLink.ts`): `{ machineId, name, savedAt }` with the default name and
  never the key. It is in `localStorage` rather than `sessionStorage` because the verification email opens a new tab,
  which must see it after the user signs in there. Reading it ignores and removes a corrupt entry, one with a `key`
  field and one older than 24 hours. The root layout calls `sendPendingMachineLink` whenever the session holds a user
  (loading a page while signed in, signing in, and a connect link opened on an open page), after the identity watcher
  has decided whether to clear it, so a link left while user A was signed in is never sent for user B. It posts
  `{ machineId, name }` to `serverRoutes.machines.link`, one send at a time, and clears the link on success (then
  invalidates the list) or on a 4xx, such as a malformed id; a network error or 5xx keeps it for the next session
  read. Linking is idempotent and keeps an existing name, so a duplicate send never overwrites a rename. Accepted
  risk: a link opened while signed out and never followed by a sign-in can be picked up by the next user to sign in
  in this browser within 24 hours; it holds only an id, and the key check still guards the machine.
- The machines module (`apps/server/src/modules/machines/`, `serverRoutes.machines`) lists, links, renames and
  unlinks the signed-in user's machines in the `machines` table (one row per user and machine id), only through
  `data.machines`. The accounts API stores and returns only machine ids and names, never access keys: no schema has a
  key field and every input is strict, so a body carrying `key` gets 400, and the module never reads request headers
  or logs input. Linking a machine again keeps its name and refreshes `lastOpenedAt`, which is when its connect link
  was last opened; a link that loses a race to the unique index returns the winning row. Each listed machine is
  `online` when the in-memory `MachineRegistry` holds its tunnel, so `index.ts` builds the registry before the
  accounts modules and hands the same one to both; with more than one server instance this would be wrong (see
  "More than one server instance" below).
- Accepted risk, linking: the server can't prove that a user holds a machine's key, so anyone who knows a machine id
  can link it. That reveals only whether the machine is online. Ids are SHA-256 hashes of 32-byte secrets, so they
  can't be guessed, but they do appear in `/m/<id>` URLs and connect links. The host's access-key check still guards
  every request to the machine, and the account list never replaces it. Open question: a cap on linked machines per
  user would limit probing; there is none yet.
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

Accounts (sign-in, sessions, emails and the account's machine list) are described in [accounts](accounts.md).

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

### Agent status

Tabs show whether their Claude Code or Codex agent is working, waiting for the user or idle, with per-workspace
counts and notifications (AG-1 to AG-5). The design, including the per-session hook shim and the daemon's local
reporting channel, is in [agents](agents.md).

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
