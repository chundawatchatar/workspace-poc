# Accounts

How to work on accounts: the database, Better Auth, sessions, emails and the account's machine list. It is for
developers changing `apps/server`, `packages/domain` or the accounts side of `apps/client`. The rules behind it are in
[architecture](architecture.md#1-dependencies-point-one-way); this guide is the "how to work with it" view and links
there rather than repeating it. Everything here is the development setup on one computer. What a real deploy adds is
in [remote access, section 7](remote-access.md#7-what-changes-for-a-real-deploy).

## 1. Database and email setup

Accounts need Postgres and an SMTP server. `compose.yaml` runs both locally: Postgres 17 and Mailpit, which keeps
every email in a web inbox instead of delivering it. The addresses and ports are in the table in
[remote access, section 6](remote-access.md#6-database-and-email).

1. Copy the settings once: `cp .env.example .env`. `.env` is gitignored.
2. `bun run db:up` starts Postgres and Mailpit and returns once Postgres is healthy. It needs Docker with Compose v2.
3. `bun run db:migrate` applies the migrations (section 2).
4. `bun run dev:client` starts the server and the client. Read emails at http://127.0.0.1:8025.
5. `bun run db:down` stops the services and keeps the data.

`apps/server` turns accounts on only when `DATABASE_URL` is set. It then also needs these variables, which
`.env.example` fills with dev values:

| Variable | What it is |
| --- | --- |
| `BETTER_AUTH_SECRET` | At least 32 bytes. Generate a real one with `openssl rand -base64 32`. Never log it. |
| `BETTER_AUTH_URL` | The app's URL, `http://127.0.0.1:3220` with `bun run dev:client`. Email links point to it. |
| `SMTP_URL` | An `smtp://` or `smtps://` URL, Mailpit's `smtp://127.0.0.1:1025` in development. |
| `MAIL_FROM` | The sender of every email. |
| `RELAY_SIGNING_KEY` | The Ed25519 key relay tickets are signed with, as `<kid>:<32-byte seed in base64url>`. Generate one with `bun apps/server/scripts/relay-key.ts`. Never log it. |
| `RELAY_EXTRA_PUBLIC_KEYS` | Optional. Comma-separated `<kid>:<public key>` entries that machines also trust when they link, ahead of a key rotation. |

The server reads them with `loadServerConfig` (`apps/server/src/lib/config.ts`) and exits at start-up with a message
naming the problem when one is missing or invalid, when the database is unreachable, or when a migration is pending.
Without `DATABASE_URL` the server runs as a relay alone: no `/api/auth/*`, no `/api/me`, no `/api/machines`. The
client needs accounts, so with the relay alone it sends you to a sign-in that can't work.

## 2. Migrations

The schemas live in `packages/domain/src/schemas/`, one table per file.

1. Edit or add a schema file. Export a new one from `src/schemas/index.ts`.
2. `bun run db:generate` writes a new migration into `packages/domain/migrations/`.
3. Commit the migration with the schema change. Never hand-edit a generated migration; change the schema and generate
   again.
4. `bun run db:migrate` applies pending migrations to `DATABASE_URL`.

Tests never need Docker or `DATABASE_URL`. `createTestDomain()` and `createTestDb()` from `@orch/domain/testing` give
an in-memory PGlite database with every migration applied.

Better Auth's four tables come from its CLI, not from hand-written schemas. After bumping Better Auth or enabling a
feature that adds columns, regenerate them as the [domain README](../packages/domain/README.md#better-auth-tables)
describes, then run `bun run db:generate`.

`"user"` is a reserved word in Postgres, so quote it in any hand-written SQL.

## 3. Authorized data layer

`createDomain(url)` hands out no raw Drizzle client. A `Domain` has three doors (details in the
[domain README](../packages/domain/README.md#reaching-the-database)):

- `domain.forUser(principal)` is the one app code uses. It returns one repository per table in `scopedTables`
  (`packages/domain/src/scoped-tables.ts`). Every query is ANDed with `userId = principal.userId`, so a `where` can
  narrow the rows but never reach another user's; `insert` takes the `userId` from the principal, and `update`
  rejects a `userId`, so a row never moves to another user. A principal without a `userId` throws.
- `domain.forAuthLibrary()` returns the raw client for Better Auth's `drizzleAdapter` and nowhere else.
- `domain.skipAuthorization(reason)` returns the raw client, which sees every user's rows.

An `auth: 'user'` handler in `serverRoutes` gets only `principal` (`userId`, `email`, `name`) and `data`, the
principal's scoped repositories. It never gets the `Domain`, `forAuthLibrary()` or `skipAuthorization`: the router is
given `forUser` as a closure, not the domain.

A new table with a `userId` column must be registered in `scopedTables` under the name handlers will use, as in
`machines: machines` today. `packages/domain/src/scoped-tables.test.ts` fails when a table with a `userId` column is
neither registered nor one of Better Auth's tables. See
[adding a table](../packages/domain/README.md#adding-a-table-with-a-userid-column).

### When `skipAuthorization` is allowed

Only in operator scripts and server start-up checks, never in a request handler. The reason must be real, since it is
logged on every call, and must hold no secrets (no email, token or URL). The current callers are:

| Caller | Reason |
| --- | --- |
| `apps/server/scripts/revoke-user-sessions.ts` | Signs one user out everywhere (section 5). |
| `apps/server/src/index.ts` | The start-up check of the connection and pending migrations. |

Add a row here when you add a caller. To find them all:
`grep -rn "skipAuthorization(" apps packages --exclude-dir=node_modules`, ignoring tests and `domain.ts`.

## 4. Better Auth

Better Auth is pinned at **1.7.14**, the version `packages/domain` generates its tables with. It is set up in
`apps/server/src/modules/auth/`: `createAuth` in `auth.service.ts` builds it, and `auth.routes.ts` mounts it, only when
accounts are on.

- It reaches the database through the Drizzle adapter on `domain.forAuthLibrary()`.
- Email and password, with required email verification. Sign-up sends a verification email, and a password reset ends
  every session of the account.
- Sessions live in the database and the cookie cache is off, so every request reads the session there.
- The session cookie is `Path=/api`, `HttpOnly`, `Secure` and `SameSite=Lax`, so browsers never send it to relayed
  machines under `/m/*`. Its name has the `__Secure-` prefix when `BETTER_AUTH_URL` is `https://`, and none on
  `http://`.
- Its origin check accepts `SERVER_TRUSTED_ORIGINS` plus the origin of `BETTER_AUTH_URL`. Its rate limits are in
  memory (per process, reset on restart) and keyed by the `x-orch-client-ip` header, which `auth.routes.ts` sets from
  the server's own client IP reader, replacing whatever the client sent.
- Better Auth turns off its origin check and rate limits when `NODE_ENV=test`, so `createAuth` sets both on
  explicitly (`disableOriginCheck: false`, `rateLimit.enabled: true`). Keep it that way, so tests see what production
  does.
- Its logger masks emails, URL paths and tokens, and drops error details beyond a name and code.

### What it owns

Better Auth owns exactly four tables, `user`, `session`, `account` and `verification`, and every route under
`/api/auth/*`. Those routes are never in `serverRoutes`, and `defineServerContract` throws for a path under
`/api/auth`. Every other endpoint under `/api` is a `serverRoutes` contract in `packages/shared/src/contracts/`:
`GET /api/health` (public), `GET /api/me` (`serverRoutes.account`) and `serverRoutes.machines`.

### Account enumeration

With required verification, Better Auth answers a sign-up for an already registered email exactly like a new one: the
same status, a user of the same shape, no cookie and no `USER_ALREADY_EXISTS`, and it creates nothing. The accepted
risk is timing: a new sign-up waits for the verification email to send and a duplicate sends nothing, so response
times can still differ. See [architecture](architecture.md#1-dependencies-point-one-way) for the details.

## 5. Sessions and signing out everywhere

Sessions are rows in the `session` table. Since the cookie cache is off, a revoked session is refused on its very next
request, both by Better Auth and by our `auth: 'user'` endpoints. Those read the session only through
`auth.api.getSession` with `disableRefresh` (`createAuthenticate` in `auth.middleware.ts`), so they never extend it.

A signed-in user has Better Auth's four session endpoints:

| Endpoint | What it does |
| --- | --- |
| `GET /api/auth/list-sessions` | Lists the user's own sessions. |
| `POST /api/auth/revoke-session` | Ends one session by its token, only if it is the user's. |
| `POST /api/auth/revoke-other-sessions` | Ends every session but the current one. |
| `POST /api/auth/revoke-sessions` | Ends every session, the current one included. |

`list-sessions` refuses a session older than `freshAge`, one day (set in `createAuth`), with 403
`SESSION_NOT_FRESH`; the revoke endpoints need only a valid session. The revoke endpoints go through the same origin
check as every other `POST`. A password reset also ends every session of the account.

The client's `/settings/security` page uses them. It is reached from the account menu
(`apps/client/src/components/account/AccountMenu.tsx`), shown in the home page's title row and in the machine page's sidebar
header. It changes the password with `change-password` and `revokeOtherSessions: true`, so every other session ends and
this browser stays signed in under a new session. It lists the sessions in a table, marks this browser's as
"This device" and revokes any other row. "Sign out from all devices" asks for confirmation, then calls
`revoke-sessions`. A 401 from any of these calls reads the session again, so a session revoked elsewhere lands on
sign-in.

On 403 `SESSION_NOT_FRESH` the page says a recent sign-in is needed to see the devices, and its "Sign in again" button
signs out and opens `/auth/sign-in?redirect=%2Faccount`. Changing the password and signing out from all devices still
work without a fresh session. Revoking one session needs one, since it lists the sessions again to find the token. See
[architecture](architecture.md#1-dependencies-point-one-way) for the details.

An operator signs one user out everywhere, for example for a compromised account, with:

```bash
bun run --filter @orch/server sessions:revoke-user <email>
```

It deletes the user's `session` rows through `skipAuthorization` (`revokeUserSessions` in `auth.sessions.ts`) and
prints only the count, never the email, a token or `DATABASE_URL`.

Resolved for now: `list-sessions` answers each session's `token`, which `revoke-session` takes. The client keeps them
out of the query cache: `sessionsQuery` (`apps/client/src/lib/accountSessions.ts`) returns rows without the token, and
`revokeSession` lists the sessions again at revoke time and keeps the token only inside that call. The tokens still
reach page JavaScript briefly in those responses, which weakens `HttpOnly`; removing them means our own revoke-by-id
endpoint in `serverRoutes`.

## 6. Email flows

The server sends email only through the mailer (`apps/server/src/modules/mailer/`). `createMailer({ transport, from })`
is built in `apps/server/src/index.ts` when accounts are on. Each email is one template file in `templates/`, listed in
`templates/index.ts`, with a `name` and a `render(data)` that returns the subject, text and HTML:

| File | Template name | Sent when |
| --- | --- | --- |
| `templates/verify-email.ts` | `verifyEmail` | A user signs up or asks to resend the verification link. |
| `templates/reset-password.ts` | `resetPassword` | A user asks for a password reset. |

Every value is escaped in the HTML and no user input goes in the subject. Tests use `createCaptureTransport()` from
`mailer.testing.ts` and read a link with `lastTo(address)`; production code never imports it.

Emailed links carry their token in the fragment, so browsers never send it to a server. `emailLinkUrl` in
`auth.service.ts` builds them on the origin of `BETTER_AUTH_URL`:

- `/auth/verify-email#token=…`
- `/auth/reset-password#token=…`

The client's `acceptEmailLinkToken` (`apps/client/src/lib/emailLink.ts`) reads the token before the router starts,
keeps it in memory only and removes it from the address bar. The pages that use these flows are all under `/auth`:

- Sign-up's in-page "Check your inbox" (`CheckInbox`), with a button to send the link again.
- `/auth/verify-email`, which verifies the link's token once and never signs in. With a refused token or none it
  shows a resend form.
- `/auth/forgot-password`, which asks for a reset link and gives the same answer whether or not the address has an
  account.
- `/auth/reset-password`, which sets the new password with the link's token. The reset ends every session.

Never logged: the link, a token, the recipient, the subject, the body or `SMTP_URL`. The mailer logs only the
template name and `sent` or `failed (<code>)`. Never put an email token in storage, a query key, a URL or a log.

To read the emails locally, open Mailpit at http://127.0.0.1:8025. As a smoke test of the mailer alone, which reads
the accounts settings from `.env` but never connects to the database:

```bash
bun apps/server/scripts/send-test-mail.ts you@example.com
```

It sends one `verifyEmail` with a dummy link through `SMTP_URL` from `.env`.

## 7. Accounts and machine access keys

A machine opens either with its access key from a connect link, or as the account it linked with an enrollment key,
through a relay ticket plus a proof from a browser approved on the machine. The host decides both on every request
and socket; the server only signs tickets.

- The accounts API (`serverRoutes.machines`, `apps/server/src/modules/machines/`) stores and returns only machine
  ids and names. It never receives or stores an access key: every input is strict, so a body carrying a `key` field
  gets 400, and the module never reads request headers.
- Keys stay in the browser's `localStorage` (`orch-machines`), saved when a connect link is opened. Opening a connect
  link adds nothing to the account: it sends no request to the server, so the machine opens in that browser only and
  joins the account's list once it is linked with an enrollment key. The home page lists the account's machines, each
  with an Open link. A machine page uses a saved key when this browser holds one;
  otherwise it opens a machine the account lists with relay tickets (`createRemoteTransport` with `relayTicket`).
- Relay tickets: `serverRoutes.machines.relayTicket` (`POST /api/machines/:machineId/relay-ticket`, `auth: 'user'`)
  signs one only when the machine is in the caller's scoped list, and answers `not_found` otherwise. A ticket is a
  compact JWS (`alg: EdDSA`, `typ: orch-relay`, `kid`) over `{ sub: userId, aud: machineId, exp: now + 60 s, jti }`,
  signed with `RELAY_SIGNING_KEY` (`modules/machines/relay-ticket.service.ts`, `node:crypto`, no new dependency). The
  browser sends it in `x-orch-relay-ticket` on requests (one ticket reused until 15 seconds before it expires) and, for
  each socket, a fresh one as the second subprotocol (`orch.relay`, `orch.ticket.<ticket>`; the server's socket
  upgrade echoes `orch.relay`, the first one offered). It is never in a URL, a cookie, the query cache or a log. The
  session cookie stays on `Path=/api`, the relay never reads a session, and `/m/*` sends no
  `Access-Control-Allow-Credentials`, so a cross-site link to `/m/*` carries nothing that opens a machine.
- The host learns the server's public keys from `enroll.redeemed` (with the owner's `accountId`) and keeps them in
  `linked-account.json`. It accepts a ticket only when it verifies under a saved key for its `kid`, `aud` is its own
  machine id, `sub` is the linked account, `exp` is in the future (30 seconds of skew), and the account was linked
  through the server address in use. A socket spends its ticket's `jti`, so a replay opens nothing; HTTP requests may
  reuse one. A request with an access key is judged by the key alone.
- Device approval: a ticket is accepted only with a fresh device proof from a browser the machine approved. The
  client keeps one non-exportable ECDSA P-256 key pair per browser profile (`src/lib/deviceKey.ts`, IndexedDB
  `orch-device`) and passes it to `createRemoteTransport` as `device`, which signs a proof for every request
  (`x-orch-device-proof`) and socket (`{ type: 'auth', account: true, device }`). An unknown device gets a 403
  `device_not_approved` or a 4403 close and waits on the machine; the page shows the `unapprovedHint` with the
  browser's fingerprint and keeps retrying, so it opens once the owner approves that fingerprint in the machine's
  Remote access setting. See `docs/architecture.md` ("Device approval") for the format and the risks that remain.
- Key rotation: put the next key's public half in `RELAY_EXTRA_PUBLIC_KEYS`, so machines that link from then on trust
  both; switch `RELAY_SIGNING_KEY` once they have. A machine linked before the next key was announced must link
  again.
- Accepted risks: the server still says who is signed in, so it decides who owns an enrollment key and who gets
  relay tickets, but a leaked `RELAY_SIGNING_KEY` or a compromised server can't open a machine without a browser
  approved on it. It could push its own key into a machine's pending list and hope the owner approves it, and until
  end-to-end encryption (REM-2) it can read and inject into a session an approved browser opens. A revoked session or a machine unlinked on the server gets no new ticket, but an issued one works for up
  to a minute and an open socket stays until it closes (unlinking on the host closes them). A refused ticket sends
  `auth.failed` and counts against the browser's bad-key limit; a device waiting for approval sends none. Each
  socket costs one ticket request.
- The home page's Connect a machine button (`apps/client/src/components/machines/ConnectMachineDialog.tsx`) creates
  an enrollment key with `serverRoutes.machines.createEnrollment` and shows it once: the key and the
  `bun run host:remote link <key>` command, each with a Copy button, its fingerprint and a countdown to its expiry.
  The key lives only in the dialog's state, never in the query cache, storage, the URL or a log, so closing the dialog
  forgets it and opening it again creates a new one. While it is open the machines list is read every 2 seconds, and
  the first machine that wasn't listed when the key was created is taken to be the one that redeemed it. A machine
  linked this way opens from any browser signed in to the account.
- The relay still sees access keys in transit, in the header and first socket message it forwards, until end-to-end
  encryption (REM-2). It never checks or stores them.
- A machine's online state comes from the server's in-memory `MachineRegistry`, the same one the relay uses. Offline
  can also mean a host that is up with remote access off. With more than one server instance this would be wrong (see
  [keeping the machine connected](architecture.md#keeping-the-machine-connected)).

Linking: a machine reaches an account's list only by redeeming an enrollment key over its own tunnel, so knowing a
machine's id no longer puts it on an account. The accounts API has no endpoint that links a machine by id
(`POST /api/machines` answers `not_found`).
