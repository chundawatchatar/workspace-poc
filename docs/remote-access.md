# Remote access

How to reach this machine through the cloud server (`apps/server`) and the global
app (`apps/client`), all on one computer. This is the development setup: plain
`ws://` and `http://` on loopback, with no TLS. Docker is needed only for the
database and email services (section 6). What a real deploy adds is listed at
the end.

## 1. Run the server and the client

```bash
bun run dev:client
```

This starts the server on 127.0.0.1:4600, with
`SERVER_ALLOWED_ORIGINS=http://127.0.0.1:3220`, and the Vite client on
127.0.0.1:3220, with `VITE_SERVER_URL=http://127.0.0.1:4600`. It does not start
the host or the local app, so run them in a second terminal:

```bash
bun run dev
```

The other option is to let the server serve the client itself. Build the client,
then start the server:

```bash
bun run --filter @orch/client build
bun run --filter @orch/server start
```

The server then serves `apps/client/dist` on 127.0.0.1:4600, and no CORS is
needed. Without a build it only relays, and logs that it found no client build.

With a `.env` copied from `.env.example`, `DATABASE_URL` is set, so the server
turns accounts on and refuses to start until Postgres is up and migrated:
`bun run db:up`, then `bun run db:migrate` (section 6). Unset `DATABASE_URL`
(or leave it out of `.env`) to run the relay alone. Either way,
`curl -s http://127.0.0.1:4600/api/health` answers `{"ok":true}`. How to work
on accounts is in [accounts](accounts.md).

## 2. Connect a machine

Open the local app at http://127.0.0.1:3210 and pick "Remote access…" from the
command palette. Fill in:

- "Server address": `ws://127.0.0.1:4600`
- "Client address (optional)": `http://127.0.0.1:3220` when you use the Vite
  client from `bun run dev:client`. Leave it empty when the server serves the
  client build.

Then turn the switch on. The dialog shows whether the tunnel is connected. With
no server address set, the host uses its built-in default (section 5).

The host accepts `ws://` only for a loopback host (`127.0.0.1`, `[::1]` or
`localhost`). Any other server needs `wss://`.

The other way is to set the addresses in the host's environment:

```bash
SERVER_URL=ws://127.0.0.1:4600 CLIENT_URL=http://127.0.0.1:3220 bun run dev
```

`SERVER_URL` and `CLIENT_URL` override the saved setting, and `SERVER_URL` turns
the tunnel on at start whatever the setting says.

The host keeps its remote access files in `apps/host/.data/` (gitignored):

- `remote-access.json`: the saved setting, so every later start reconnects on
  its own.
- `machine-secret`: the machine's random secret. Keep it: the machine id comes
  from it. Deleting it gives the machine a new id, and old connect links stop
  working.
- `access-keys.json`: the access keys, as hashes only.
- `linked-account.json`: the account this machine is linked to, if any
  (section 5).

## 3. Open it from a browser

The first time remote access is on, the host creates an access key and prints
the connect link once, in the host's log (the terminal running `bun run dev`):

```text
<client>/#machine=<id>&key=<key>
```

Open it in a browser. The client saves the machine and opens it. The link holds
the secret key: treat it like a password, and don't paste it into issues or
chat.

The `<client>` part is picked in this order:

1. `CLIENT_URL`.
2. The saved client address.
3. The server address, with `ws` swapped for `http` (and `wss` for `https`).

The trap: with `bun run dev:client` and no client address, the link points at
`http://127.0.0.1:4600`, which serves the app only after a client build. Enter
`http://127.0.0.1:3220` as the client address, press "Save", and make a new connect
link (section 4).

## 4. Rotate the key

Lost the link, or want to cut everyone off? Press "New connect link" in the
dialog, or run:

```bash
bun run host:rotate-key
```

Both print a new link. With a running host that has remote access, both also
close every session that used the old key. With the host stopped, the script
rewrites `access-keys.json`, and the host uses the new key at its next start.

## 5. Link the machine to an account

A signed-in user can link this machine to their account with a one-time
enrollment key instead of a connect link. Create the key on the client's home
page, then, on this machine, open "Remote access…", paste it into "Link key"
and press "Preview". Linking needs remote access on and the tunnel connected,
since the key is checked over the tunnel; the host never opens a tunnel just
to check one.

The server address the key is checked with is the host's own: `SERVER_URL`,
else the saved "Server address", else the built-in default
(`DEFAULT_SERVER_URL` in `apps/host/src/modules/remote-access/remote-access.service.ts`,
a placeholder until there is a real deploy). Nothing in the key can change it,
and the host refuses a link when the address changed after the preview.

Before anything is used, the dialog shows three values to check:

- the server address, with a warning when it isn't the built-in default. Link
  only to a server you run or trust;
- the account the key belongs to: its name and masked email;
- the key's fingerprint, its last 4 characters, which the client showed when it
  created the key.

"Link" redeems the key, so it can't be used again. The host then saves the
account (name, masked email, server address, when it was linked and the
account's user id, never the key) in `apps/host/.data/linked-account.json`, and
the dialog shows it with an "Unlink" button. The user id stays on the machine:
the dialog and the status never show it. A linked machine must unlink before it
links again.

Once linked, any browser signed in to that account opens the machine from the
client's home page, with no connect link. The server reads the browser's
session and, when the account lists the machine, tells the machine the
account's user id with each request and socket. The host accepts it only when
it is the linked account's id and the account was linked through the server
address in use; anything else gets the same refusal as a wrong key. Access keys
from connect links keep working, and a request that carries a key is judged by
the key alone. A `linked-account.json` saved before this (with no user id)
still loads and shows the account, but grants no account access: unlink and
link again with a new enrollment key.

"Unlink" deletes that file, so this machine forgets the account, and closes the
sockets the account has open. It is local only: the server still lists the
machine until you unlink it from the client's home page, but the machine
refuses that account from then on.

Accepted risks: the server is trusted to say who is signed in, so a compromised
server could open every linked machine of every account (until device approval
and end-to-end encryption). Revoking a session or unlinking on the server
refuses new requests at once, but a socket the account already has open stays
until it closes; unlinking on the host closes them.

`bun run host:remote link <key>` does the same from a terminal (next part). It
also needs the running host with the tunnel connected.

### From the terminal

On a machine where you don't open the host page (over SSH, a headless box, a
setup script), `bun run host:remote` does what the dialog does:

```bash
bun run host:remote status             # server address, remote access, machine id, linked account
bun run host:remote server wss://host  # set the server address
bun run host:remote on                 # or off
bun run host:remote link <key>         # add --yes to skip the question
bun run host:remote unlink
```

With the host running, every command goes through its local-only Remote access
endpoints, so the host stays the one owner of the setting. `link` prints the
server address (with the warning), the account and the fingerprint, then asks
`Link this machine to <name>? [y/N]`; `--yes` skips the question but still
prints them. `on` makes the host print a new connect link in its own log, as
the switch does. A host started with `SERVER_URL` refuses `server`: change the
variable instead.

With the host stopped, the command reads and writes `apps/host/.data/` itself,
and the host picks the change up at its next start. `status` shows the tunnel as
"host not running", and `SERVER_URL` in the command's own environment only
changes what `status` shows. `link` needs the running host. The command never
rewrites a `remote-access.json` that isn't valid, and `status` never creates the
machine secret or the access keys.

The key is passed on the command line, so it can end up in your shell history
and in `ps`. It is single-use and expires after 15 minutes, which makes that an
accepted risk.

## 6. Database and email

`apps/server` uses Postgres for accounts and sends email over SMTP. For development, `compose.yaml` at the repo root
runs both locally: Postgres 17 and [Mailpit](https://mailpit.axllent.org/), an SMTP server that keeps every email in
a web inbox instead of delivering it. This setup is for developing this repo only, not for production.

1. Copy the settings once: `cp .env.example .env`. `.env` is gitignored. Change the dev password if you like, and
   keep `DATABASE_URL` in step with the `POSTGRES_*` values by hand, because nothing expands variables in it.
2. `bun run db:up` starts both services and returns once Postgres is healthy. It needs Docker with Compose v2.
3. `bun run db:down` stops them. The data stays in the `postgres-data` volume for the next `db:up`.

| Service | Address |
| --- | --- |
| Postgres | `127.0.0.1:5432`, the `DATABASE_URL` in `.env` |
| Mailpit SMTP | `127.0.0.1:1025`, the `SMTP_URL` in `.env` |
| Mailpit inbox | http://127.0.0.1:8025 |

Every port is published on `127.0.0.1` only, so nothing is reachable from the network.

To reset the database, remove the volume as well: `docker compose down -v`, then `bun run db:up`.

The server loads the root `.env` itself through `loadRootEnv()` from `@orch/shared/env`, however it is started.
Variables already set in the shell win over the file. With `DATABASE_URL` set it also needs `BETTER_AUTH_SECRET` (at
least 32 bytes), `BETTER_AUTH_URL`, `SMTP_URL` and `MAIL_FROM`, which `.env.example` fills with dev values, and it
exits with a message naming the problem when one is missing, the database is unreachable, or a migration is pending.

Migrations, Better Auth, sessions and reading the emails are covered in [accounts](accounts.md).

## 7. What changes for a real deploy

This guide stops at one computer. The next phase ("Later: deploy" in the
factory backlog) must handle:

- TLS in front of the server.
- `wss://` server addresses and `https://` client addresses. This is also what a
  second computer needs, since `ws://` works only on loopback.
- `SERVER_HOST`, so the server listens on more than 127.0.0.1 (the default).
- `SERVER_TRUST_PROXY=1` behind a proxy that sets `X-Forwarded-For`, so the rate
  limits see the client's IP and not the proxy's.
- A single server instance, because the server keeps machines in memory. See
  "More than one server instance" in
  [architecture](architecture.md#keeping-the-machine-connected).
- `SERVER_ALLOWED_ORIGINS` only when the client is served from a different
  origin than the server.
