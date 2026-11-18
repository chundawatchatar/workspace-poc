# Accounts

How to work on accounts: the database, Better Auth, sessions, emails and the account's machine list. It is for
developers changing `apps/server`, `packages/domain` or the accounts side of `apps/client`. The rules behind it are in
[architecture](architecture.md#1-dependencies-point-one-way); this guide is the "how to work with it" view and links
there rather than repeating it. Everything here is the development setup on one computer. What a real deploy adds is
in [remote access, section 6](remote-access.md#6-what-changes-for-a-real-deploy).

## 1. Database and email setup

Accounts need Postgres and an SMTP server. `compose.yaml` runs both locally: Postgres 17 and Mailpit, which keeps
every email in a web inbox instead of delivering it. The addresses and ports are in the table in
[remote access, section 5](remote-access.md#5-database-and-email).

1. Copy the settings once: `cp .env.example .env`. `.env` is gitignored.
2. `bun run db:up` starts Postgres and Mailpit and returns once Postgres is healthy. It needs Docker with Compose v2.
3. `bun run db:migrate` applies the migrations (section 2).
4. `bun run dev:client` starts the server and the client. Read emails at http://127.0.0.1:8025.
5. `bun run db:down` stops the services and keeps the data.

`apps/server` always runs with accounts, so it always needs these variables, which `.env.example` fills with dev
values:

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | The Postgres connection string. Never log it. |
| `BETTER_AUTH_SECRET` | At least 32 bytes. Generate a real one with `openssl rand -base64 32`. Never log it. |
| `BETTER_AUTH_URL` | The app's URL, `http://127.0.0.1:3220` with `bun run dev:client`. Email links point to it. |
| `SMTP_URL` | An `smtp://` or `smtps://` URL, Mailpit's `smtp://127.0.0.1:1025` in development. |
| `MAIL_FROM` | The sender of every email. |
| `RELAY_SIGNING_KEY` | The Ed25519 key relay tickets are signed with, as `<kid>:<32-byte seed in base64url>`. Generate one with `bun apps/server/scripts/relay-key.ts`. Never log it. |
| `RELAY_EXTRA_PUBLIC_KEYS` | Optional. Comma-separated `<kid>:<public key>` entries that machines also trust when they link, ahead of a key rotation. |
| `SERVER_TUNNEL_URL` | The address machines open their tunnel to on this server: `wss://<host>`, or `ws://` on a loopback host, with no path. `ws://127.0.0.1:4600` in development. Every new enrollment key comes with it, as the `--server` of the `corch connect` command the client shows. |

The server reads them with `loadServerConfig` (`apps/server/src/lib/config.ts`) and exits at start-up with a message
naming the problem when one is missing or invalid, when the database is unreachable, or when a migration is pending.

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
- Sign-in with email and password, and sign-up only by an emailed code (below). `emailAndPassword.disableSignUp` is
  on, so `POST /api/auth/sign-up/email` answers 400 and creates nothing, and the email verification link flow was
  removed: no `emailVerification` options, and `/verify-email` and `/send-verification-email` are in `disabledPaths`
  (404). `requireEmailVerification` stays on as a guard, though no path creates an unverified user. A password reset
  ends every session of the account.
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
- The Drizzle adapter runs with `transaction: true`, so Better Auth's own transactions (sign-up, using up a code or
  token) are real ones, also on PGlite in tests.

### Sign-up by email code

The only way to create an account. The global app's `/auth/sign-up` runs it in two screens on one route: name, email
and password, then the code.

1. `POST /api/auth/email-otp/send-verification-otp` with `{ email, type: 'sign-in' }` (the `emailOTP` plugin, with
   `storeOTP: 'hashed'` and its defaults: 6 digits, 300 seconds, 3 attempts, 3 requests a minute per IP). It always
   answers `{ success: true }`. An address with no account gets a `signUpCode` email with the code. An address with
   any account, verified or not, gets an `accountExists` email with no code, linking to `/auth/sign-in` and
   `/auth/forgot-password` on the origin of `BETTER_AUTH_URL`, whatever the `type`. Nothing else is sent. The answer
   never waits for the email: the send finishes in the background, and a failure is logged by the mailer
   (`mail <template>: failed (<code>)`) and dropped, so the person asks again. A new send replaces the earlier code
   (`resendStrategy: 'rotate'`), and the `verification` row holds only the code's hash.
2. `POST /api/auth/sign-up/email-code` with `{ name, email, password, code }` (`signUpByEmailCode` in
   `auth.sign-up-code.ts`, a Better Auth plugin endpoint, so the origin check, the `/sign-up*` rate limit of 3 per
   10 seconds and the session cookie apply). It checks the password against `minPasswordLength` and
   `maxPasswordLength` before the code is touched, and hashes it. Then it runs the plugin's `sign-in/email-otp` step
   server-side, outside any transaction, so a wrong code's attempt count survives the failed request. That step uses
   the code up atomically and creates the user, with the name and `emailVerified: true`, and a session. Last, it
   saves the password as a `credential` account and answers 200 with the session cookie.

The step runs in a copy of the request's context in which no user is ever found by email, so it always takes its
create branch, and the email's unique constraint decides a race. It never signs in to, promotes or revokes the
sessions of an account that exists: an existing address, a wrong, used-up, locked or expired code all get the same
400 `INVALID_OR_EXPIRED_CODE` and no cookie. If anything fails after the step created the user (starting its
session inside the step, or the password write after it), that user is deleted with its sessions and accounts, the
answer is the same refusal, and the code stays used up, so no unfinished account is left behind. The other `emailOTP`
paths (`/sign-in/email-otp`, `/email-otp/check-verification-otp`, `/email-otp/verify-email`,
`/email-otp/request-password-reset`, `/forget-password/email-otp`, `/email-otp/reset-password`,
`/email-otp/request-email-change`, `/email-otp/change-email`) are in `disabledPaths` and answer 404. Better Auth checks
`disabledPaths` only in its HTTP router, so the server-side step still runs.

### What it owns

Better Auth owns exactly four tables, `user`, `session`, `account` and `verification`, and every route under
`/api/auth/*`. Those routes are never in `serverRoutes`, and `defineServerContract` throws for a path under
`/api/auth`. Every other endpoint under `/api` is a `serverRoutes` contract in `packages/shared/src/contracts/`:
`GET /api/health` (public), `GET /api/me` (`serverRoutes.account`) and `serverRoutes.machines`.

### Account enumeration

`sign-up/email` is closed, so it answers every address with the same 400 and creates nothing. Asking for a sign-up
code answers `{ success: true }` for every address, and never waits for the email. With `type: 'sign-in'`, the only
type the client sends, each address gets exactly one email: the code when it has no account, `accountExists` when it
has one. With another `type`, an address with an account still gets `accountExists` and one without gets nothing. The
email-code sign-up gives an existing address the same refusal as a wrong code. The accepted risk is a small timing difference: for a `type` other than `sign-in`, an address with an
account costs a second user lookup and the start of a send, where one without costs only the deletion of its code row.
See [architecture](architecture.md#1-dependencies-point-one-way) for the details.

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
check as every other `POST`. A password reset also ends every session of the account. Every session that ends this
way also sends a `session.ended` frame to the account's online machines, which close the sockets the account's
relay tickets opened (see [architecture](architecture.md)); browsers still signed in reconnect with a fresh ticket.

The client's `/settings/security` page uses them. It is reached from the account menu
(`apps/client/src/components/account/AccountMenu.tsx`), shown in the home page's title row and at the bottom left of the machine page's
sidebar. It changes the password with `change-password` and `revokeOtherSessions: true`, so every other session ends and
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
| `templates/reset-password.ts` | `resetPassword` | A user asks for a password reset. |
| `templates/sign-up-code.ts` | `signUpCode` | Someone asks for a sign-up code for an address with no account. |
| `templates/account-exists.ts` | `accountExists` | Someone asks for a sign-up code for an address that has an account. |

Every value is escaped in the HTML and no user input goes in the subject. Tests use `createCaptureTransport()` from
`mailer.testing.ts` and read a link with `lastTo(address)`; production code never imports it.

The sign-up code is the one email without a link: `signUpCode` carries the 6-digit code in its body only, never in
the subject, and `accountExists` carries two plain links with no token, to `/auth/sign-in` and
`/auth/forgot-password`. The flow is described under [Sign-up by email code](#sign-up-by-email-code). Never log a
code, an address or a password; the auth test helpers `codeTo(address)` and `accountExistsTo(address)` read them from
the capturing transport.

The password reset is the one emailed link with a token, which it carries in the fragment, so browsers never send it
to a server. `emailLinkUrl` in `auth.service.ts` builds it on the origin of `BETTER_AUTH_URL` as
`/auth/reset-password#token=…`. The email verification link was removed with the link sign-up, so `/auth/verify-email`
is no longer a page.

The client's `acceptEmailLinkToken` (`apps/client/src/lib/emailLink.ts`) reads the token before the router starts,
keeps it in memory only and removes it from the address bar. The pages that use these flows are all under `/auth`:

- `/auth/sign-up`, whose second screen ("Enter your code") creates the account from the emailed code, with
  "Resend code" (off for 30 seconds after a send) and "Use a different email".
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

It sends one `signUpCode` with a dummy code through `SMTP_URL` from `.env`.

## 7. Accounts and machine access

A machine opens from another browser only as the account it linked with an enrollment key, through a relay ticket,
and only with a proof from a browser approved on the machine. The host decides on every request and socket; the
server only signs tickets.

- The accounts API (`serverRoutes.machines`, `apps/server/src/modules/machines/`) stores and returns only machine
  ids and names. Every input is strict, so a body carrying a `key` field gets 400, and the module never reads request
  headers.
- The home page lists the account's machines, each name a link that opens it. A machine page opens a machine the account
  lists with relay tickets (`createRemoteTransport` with `relayTicket`), and only that way.
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
  reuse one.
- Device approval: a ticket is accepted through the tunnel only with a fresh device proof from a browser the machine
  approved. The client keeps one non-exportable ECDSA P-256 key pair per browser profile (`src/lib/deviceKey.ts`,
  IndexedDB `orch-device`) and passes it to `createRemoteTransport` as `device`, which signs a proof for every request
  (`x-orch-device-proof`) and socket (`device` in `{ type: 'auth', account: true, device }`). An unknown device gets a 403
  `device_not_approved` or a 4403 close and waits on the machine; the page shows the `unapprovedHint` with the
  browser's fingerprint and keeps retrying, so it opens once the owner approves that fingerprint in the machine's
  Remote access setting. See `docs/architecture.md` ("Device approval") for the format and the risks that remain.
- Key rotation: put the next key's public half in `RELAY_EXTRA_PUBLIC_KEYS`, so machines that link from then on trust
  both; switch `RELAY_SIGNING_KEY` once they have. A machine linked before the next key was announced must link
  again.
- Accepted risks: the server still says who is signed in, so it decides who owns an enrollment key and who gets
  relay tickets, but a leaked `RELAY_SIGNING_KEY` or a compromised server can't open a machine without a browser
  approved on it. It could push its own key
  into a machine's pending list and hope the owner approves it. Sessions are sealed end to end (REM-2) and the host
  refuses unsealed traffic through the tunnel, so it can't read or inject into one, but it could serve its own page
  (see `docs/architecture.md`, "Unsealed traffic", for the risks that remain). A revoked session or a machine removed on the server gets no new ticket, but an issued one works for up
  to a minute. A session that ends on the server closes the account's sockets on its online machines through a
  `session.ended` frame (section 5), except one ended by the operator script or by expiry; disconnecting on the host
  closes them too. A refused ticket sends
  `auth.failed` and counts against the browser's IP limit for refused requests; a device waiting for approval sends
  none. Each
  socket costs one ticket request.
- The home page's Connect a machine button (`apps/client/src/components/machines/ConnectMachineDialog.tsx`) creates
  an enrollment key with `serverRoutes.machines.createEnrollment`, which answers the key with the server's
  `SERVER_TUNNEL_URL` as `serverUrl`, and shows it once: the
  `corch connect --email <signed-in email> --key <key> --server <serverUrl>` command (`connectCommand` in
  `apps/client/src/lib/connectCommand.ts`, which single-quotes a value holding a character a shell would read
  otherwise) and the key alone, for the machine's Remote access dialog, each with a Copy button, the key's last 4
  characters and a countdown to its expiry. The key lives only in the dialog's state, never in the query cache,
  storage, the URL or a log, so closing the dialog forgets it and opening it again creates a new one. The answer also
  carries the key's `id`, which is the id of the request a machine makes with it. While the key is on screen the
  dialog reads `serverRoutes.machines.listRequests` every 2 seconds (`requestsQuery` in
  `apps/client/src/lib/accountMachines.ts`, an `accountQuery`), and once a request with its own `id` waits it shows
  the machine's name, its fingerprint (`machineFingerprint(machineId)`, worked out in the browser, labelled Machine
  key to compare with the one the machine shows) and Accept and Reject (`ConnectRequestRow`). Accept answers
  `<name> is connected` and reads the machine list again; Reject says the machine was not connected; a request that
  stopped waiting (`not_waiting`) says so in a toast, and nothing was linked. The home page shows every waiting
  request above the machine list with the same row, read every 10 seconds. A machine connected this way opens from
  any browser signed in to the account.
- The relay passes tickets and device proofs through unread and never stores them.
- A machine's online state comes from the server's in-memory `MachineRegistry`, the same one the relay uses. A host
  whose owner disconnects it while it runs sends `remote.off` before closing its tunnel, and the list shows it as
  Remote access off instead of Offline, until it is removed; a host that exits or crashes stays Offline. The registry keeps that mark
  in memory only, so a server restart forgets it, and with more than one server instance both would be wrong (see
  [keeping the machine connected](architecture.md#keeping-the-machine-connected)).

Linking: a machine reaches an account's list only when the owner accepts the request it makes over its own tunnel
with an enrollment key and the key owner's email (`enroll.request`), so knowing a machine's id puts it on no account,
and neither does holding a key. The server matches the email in any letter case and with any spaces around it, in
one conditional `UPDATE` that records the request on the key's row (`requestMachineId` from the tunnel's proof,
`requestName` from the frame, `requestedAt`) only while the key is unused, unexpired and asked with by no other
machine. Anything else gets the same `invalid_key` and leaves the row as it was. It answers `enroll.waiting` with the
key's time left, and holds the request in memory (`ConnectRequests` in
`modules/machines/connect-requests.service.ts`: request id, tunnel, frame id, machine id and expiry, one per tunnel,
built once in `index.ts` and shared by the tunnel side and the machines module). A request ends when its tunnel
closes or its key expires; after that it is neither listed nor acceptable, and its key stays unused for the same
machine to ask again. The owner answers through `serverRoutes.machines`, all `auth: 'user'` with strict inputs, through
`data` only:

- `listRequests` (`GET /api/machines/requests`) lists the caller's waiting requests (`id`, `machineId`, `name`,
  `requestedAt`, `expiresAt`), newest first: rows of their own keys that hold a request, unused and unexpired, whose
  request still waits on that machine's tunnel. It changes nothing.
- `acceptRequest` (`POST /api/machines/requests/:id/accept`) uses up the key, links the machine through
  `MachinesService.link` under the name it asked with, sends `enroll.redeemed` on the waiting tunnel (machine id, the
  caller's `accountId`, name and masked email, relay keys) and answers the linked `ServerMachine`.
- `rejectRequest` (`POST /api/machines/requests/:id/reject`) uses up the key, sends `enroll.failed` with `rejected`
  and answers `{ ok: true }`.

Another user's request id gets `not_found`, through the scoped repository; one that stopped waiting (tunnel closed,
key expired, already answered) gets 409 `not_waiting`. Either way nothing is linked or sent and the key is not used.
Once answered, the key gets `invalid_key` from any machine. Someone who holds a key and guesses the owner's email
within the machine's enrollment limit and the key's 15 minutes now only creates a request the owner sees, with the
fingerprint of that machine, not theirs; the owner rejects it. The accounts API has no endpoint that links a machine
by id (`POST /api/machines` answers `not_found`). A machine removes itself with the `unlink` frame on Disconnect: the
server deletes the row of the account it names for the tunnel's own machine id, through that account's scoped
`machines` repository, and answers `unlinked` whether or not there was one (`answerUnlinkFrame` in
`modules/machines/enrollment.service.ts`).
