# Remote access

How to reach this machine through the cloud server (`apps/server`) and the global
app (`apps/client`), all on one computer. This is the development setup: plain
`ws://` and `http://` on loopback, with no TLS. Docker is needed only for the
database and email services (section 5). What a real deploy adds is listed at
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
`bun run db:up`, then `bun run db:migrate` (section 5). Unset `DATABASE_URL`
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

Then turn the switch on. The dialog shows whether the tunnel is connected.

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

## 5. Database and email

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

## 6. What changes for a real deploy

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
