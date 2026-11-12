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

This starts the server on `<SERVER_HOST>:<SERVER_PORT>` and the Vite client on
`<CLIENT_HOST>:<CLIENT_PORT>`. In this guide, a name in angle brackets stands for
that setting's value in `.env`, the one place every address and port is set. The client proxies the accounts API and the relayed
machine requests and sockets to the server, so they share one origin, as they do
in production. It does not start the host or the local app, so run them in a
second terminal:

```bash
bun run dev
```

The other option is to let the server serve the client itself. Build the client,
then start the server:

```bash
bun run --filter @orch/client build
bun run --filter @orch/server start
```

The server then serves `apps/client/dist` on `<SERVER_HOST>:<SERVER_PORT>`, and no CORS is
needed. Without a build it only relays, and logs that it found no client build.

With a `.env` copied from `.env.example`, `DATABASE_URL` is set, so the server
turns accounts on and refuses to start until Postgres is up and migrated:
`bun run db:up`, then `bun run db:migrate` (section 6). Unset `DATABASE_URL`
(or leave it out of `.env`) to run the relay alone. Either way,
`curl -s http://<SERVER_HOST>:<SERVER_PORT>/api/health` answers `{"ok":true}`. How to work
on accounts is in [accounts](accounts.md).

## 2. Connect a machine

Open the local app at `http://<WEB_HOST>:<WEB_PORT>` and pick "Remote access…" from the
command palette. Fill in:

- "Server address": `ws://<SERVER_HOST>:<SERVER_PORT>`
- "Client address (optional)": `http://<CLIENT_HOST>:<CLIENT_PORT>` when you use the Vite
  client from `bun run dev:client`. Leave it empty when the server serves the
  client build.

Then turn the switch on. The dialog shows whether the tunnel is connected. With
no server address set, the host uses its built-in default (section 5).

The host accepts `ws://` only for a loopback host (`127.0.0.1`, `[::1]` or
`localhost`). Any other server needs `wss://`.

The other way is to set the addresses in the host's environment, by uncommenting
`SERVER_URL` and `CLIENT_URL` in `.env` and giving them the same values:

```bash
SERVER_URL=ws://<SERVER_HOST>:<SERVER_PORT>
CLIENT_URL=http://<CLIENT_HOST>:<CLIENT_PORT>
```

`SERVER_URL` and `CLIENT_URL` override the saved setting, and `SERVER_URL` turns
the tunnel on at start whatever the setting says.

The host keeps its remote access files in `apps/host/.data/` (gitignored):

- `remote-access.json`: the saved setting, so every later start reconnects on
  its own.
- `machine-key`: the machine's Ed25519 private key (PKCS#8 PEM, readable only
  by you). It never leaves the machine: the host signs the server's challenge
  with it, and the machine id is the hash of its public key. Keep it: deleting
  it gives the machine a new id, and old connect links and account links stop
  working.
- `access-keys.json`: the access keys, as hashes only.
- `linked-account.json`: the account this machine is linked to, if any
  (section 5).

## 3. Open it from a browser

The first time remote access is on, the host creates an access key and prints
the connect link once, in the host's log (the terminal running `bun run dev`):

```text
<client>/#machine=<id>&key=<key>&fp=<fingerprint>
```

Open it in a browser. The client saves the machine and opens it. The link holds
the secret key: treat it like a password, and don't paste it into issues or
chat.

`fp` is the machine key's fingerprint, such as `ABCD-EFGH-JKMN-PQRS`: the first
10 bytes of the machine id (the SHA-256 of the machine's public key) in the same
groups as a device fingerprint. The host printed it, so the browser can trust
the id without the server: it refuses a link whose `fp` isn't its id's, or that
has none, and removes it from the address bar unsaved. A link made before
fingerprints were added stops working; make a new one (section 4). The same
fingerprint shows beside the machine id in the "Remote access…" dialog
(`Machine key ABCD-…`) and on the `Machine key:` line of `bun run host:remote status`.

Before the page opens any terminal, the browser asks the machine for its public
key (`GET /api/machine-key`, through the relay with the same key or ticket and
device proof as every other request) and checks that it hashes to the machine
id. The first time, it pins that key in IndexedDB beside its device key; every
later open checks the key against the pin.

If the page says **"The machine key doesn't match"**, the key it got isn't the
one this browser trusts for that machine: something between them, such as a
compromised server, may be posing as it. The page stops there, with no Retry,
and opens no terminal socket. Check the fingerprint with
`bun run host:remote status` on the machine and don't open it from that browser
until you know why. A relinked machine with a new key has a new id, so it gets a
new pin rather than this warning.

The `<client>` part is picked in this order:

1. `CLIENT_URL`.
2. The saved client address.
3. The server address, with `ws` swapped for `http` (and `wss` for `https`).

The trap: with `bun run dev:client` and no client address, the link points at
`http://<SERVER_HOST>:<SERVER_PORT>`, which serves the app only after a client build. Enter
`http://<CLIENT_HOST>:<CLIENT_PORT>` as the client address, press "Save", and make a new connect
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

A signed-in user links this machine to their account with a one-time
enrollment key, the only way to put a machine on an account's list. A connect
link only opens the machine in the browser that holds its key: it adds nothing
to the account, even when that browser is signed in. Create the key on the
client's home page, then, on this machine, open "Remote access…", paste it into "Link key"
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
account (name, masked email, server address, when it was linked, the
account's user id and the server's relay public keys, never the key) in
`apps/host/.data/linked-account.json`, and the dialog shows it with an "Unlink"
button. The user id and the public keys stay on the machine: the dialog and the
status never show them. A linked machine must unlink before it links again.

Once linked, any browser signed in to that account opens the machine from the
client's home page, with no connect link. The first time a browser opens it this
way, nothing printed by the host vouches for the machine id the server listed,
so once the machine answers its key the page asks you to type the fingerprint
the machine shows: Machine key in its "Remote access…" dialog, or
`bun run host:remote status`. The page doesn't show the fingerprint itself, so
it can only come from the machine. Confirm stays disabled until the typed
fingerprint matches (dashes, spaces and case don't matter), so a stray click
can't pin a key; "It doesn't match" pins nothing and shows the warning above.
After that the browser checks the key against its pin and doesn't ask again. The browser asks the server for a
relay ticket: a short-lived Ed25519 signature saying "this account may open
this machine for 60 seconds", issued only for a machine in the account's list.
It sends the ticket in the `x-orch-relay-ticket` header on requests and as a
WebSocket subprotocol on sockets, never in a URL or a cookie. The server relays
it unchanged; the host checks it:

- the signature verifies against one of the public keys it saved for the
  ticket's key id;
- it names this machine and the linked account, and hasn't expired (30 seconds
  of clock skew are allowed);
- the account was linked through the server address in use;
- on a socket, the ticket hasn't opened another socket already.

A ticket alone opens nothing. Each browser profile keeps its own device key
(a non-exportable ECDSA P-256 key pair in IndexedDB) and signs a fresh proof
for every request (`x-orch-device-proof`) and socket (`device` in its first
message), naming this machine, the method, the path, the body's hash, the time
and a random nonce. The host also checks:

- the proof verifies under the public key it carries, and matches this request;
- its time is within 5 minutes of the machine's clock, and its nonce is unused;
- the device is approved on this machine.

A valid ticket and proof from a device that isn't approved yet get a 403
`device_not_approved` on a request, or close a socket with 4403, and the device
waits in the Remote access setting's Devices list (at most 5, for 15 minutes
each), by the fingerprint its browser shows, such as `ABCD-EFGH-JKMN-PQRS`. The
browser's page says which fingerprint to approve, and opens by itself once it
is. A waiting row has only Dismiss: to approve, type the fingerprint your
browser shows into "Fingerprint shown in your browser" under the list and press
Approve or Enter, or run `bun run host:remote devices approve <fingerprint>`
from a terminal on the machine (see "From the terminal" below). Case, dashes
and spaces don't matter. The host checks the typed fingerprint against the
waiting list itself: one that matches no waiting browser (unknown, expired or
mistyped) approves nothing and gets `No browser with the fingerprint <typed> is
waiting. Open this machine in your own browser and type the fingerprint it
shows.`, and one that more than one waiting browser shares approves none of
them. Type it from your own browser, never from the list. Approved devices are
kept in `apps/host/.data/devices.json` (public keys only; delete it to approve
again); Revoke takes one away and closes what it has open. Every browser must
be approved once, and an older page, which sends no proof, is refused.

The setting's Sessions list shows the approved browsers with sockets open
through the tunnel right now, polled every 2 seconds: one row per browser, with
its fingerprint, `Account` and/or `Key <name>` for what it came in with, how
many sockets it holds and when the first one opened. Sockets still waiting for
their auth message aren't counted, and tunneled HTTP requests, which hold
nothing open, aren't shown. End closes that browser's sockets with 4401 but
leaves it approved, so its page stops at "access denied" and a reload opens the
machine again; Revoke it under Devices to remove it for good. `bun run
host:remote sessions` prints the same list. Like the rest of the setting, both
are refused through the tunnel, and the list lives only in the running host's
memory.

Anything else gets the same refusal as a wrong key. Access keys from connect
links need the same approval: through the tunnel a request that carries a key
is judged by the key (a ticket never rescues a wrong one), then by a fresh
proof from an approved browser. A connect link opened in a browser that was
never approved stops at the same fingerprint hint until you approve it here. A `linked-account.json` saved before this (with no user id or public
keys) still loads and shows the account, but accepts no ticket: unlink and link
again with a new enrollment key. The server and the host must be updated
together for this, since `enroll.redeemed` now carries the account's id and the
public keys.

"Unlink" deletes that file and the approved devices, so this machine forgets
the account and its browsers (connect links opened in them must be approved again), and closes the sockets the account has open. It is local only: the server still lists the
machine until you unlink it from the client's home page, but the machine
refuses that account's tickets from then on.

Accepted risks: the server still says who is signed in, so it decides who owns
an enrollment key and who gets relay tickets, but a leaked `RELAY_SIGNING_KEY`
or a compromised server can't open a machine without an approved browser. It
can mint tickets to put its own key in the Devices list, hoping you approve it,
which is why approval takes a fingerprint typed from your own browser and
checked by the host, so a click on the list can't approve it. Copying a
fingerprint you don't recognise from the list and typing it in still would. Until
end-to-end encryption, a compromised server can read and inject into a session
an approved browser opens, and capture an access key from a connect link,
which device approval doesn't cover. A browser whose clock is more than 5
minutes off is refused. Revoking a session or unlinking on the server stops new tickets at
once, but a ticket already issued works for up to a minute. When a session
ends on the server (a revoke, a sign-out or a password change), the server
sends the machine a `session.ended` frame that names only the account. The
host checks that account against its own link and, if it matches, closes the
sockets that account's tickets opened with code 4410; key sockets, the link
and the devices stay as they are. Browsers still signed in reconnect with a
fresh ticket, and the revoked one can't get one. The operator script
`sessions:revoke-user` and an expired session send no frame, and unlinking on
the server closes nothing either; unlinking on the host closes the account's
sockets. A refused ticket sends
`auth.failed`, so it counts against the browser's bad-key limit like a wrong
key.

`bun run host:remote link <key>` does the same from a terminal (next part). It
also needs the running host with the tunnel connected.

### From the terminal

On a machine where you don't open the host page (over SSH, a headless box, a
setup script), `bun run host:remote` does what the dialog does:

```bash
bun run host:remote status             # server address, remote access, machine id and key, linked account
bun run host:remote server wss://host  # set the server address
bun run host:remote on                 # or off
bun run host:remote link <key>         # add --yes to skip the question
bun run host:remote unlink
bun run host:remote devices                         # waiting and approved devices, newest first
bun run host:remote devices approve <fingerprint>   # add --yes to skip the question
bun run host:remote devices remove <fingerprint>    # dismiss a waiting device, or revoke an approved one
bun run host:remote sessions                        # approved devices with tunneled sockets open
```

With the host running, every command goes through its local-only Remote access
endpoints, so the host stays the one owner of the setting. `link` prints the
server address (with the warning), the account and the fingerprint, then asks
`Link this machine to <name>? [y/N]`; `--yes` skips the question but still
prints them. `on` makes the host print a new connect link in its own log, as
the switch does. A host started with `SERVER_URL` refuses `server`: change the
variable instead.

`devices` lists each device by its fingerprint, such as `ABCD-EFGH-JKMN-PQRS`,
with `waiting, seen 3 min ago` or `approved 2 days ago`, and `status` adds a
`Devices:` line with both counts. `devices approve <fingerprint>` asks
`Approve <fingerprint>? It will be able to open this machine through the linked
account. [y/N]`; `--yes` skips the question. It sends the typed fingerprint to
the host, which approves the one waiting device it matches, in any case, with or
without the dashes; a fingerprint the host matches to no waiting device, or to
more than one, prints the host's message and exits 1, and one already approved
prints `<fingerprint> is already approved`. Type only a fingerprint shown in
your own browser: a compromised server can put its own device in the list. `devices
remove` asks nothing; for an approved device it also closes the sockets it has
open. The commands print fingerprints only, never a device's id or public key.
`sessions` prints one line per session, such as `ABCD-EFGH-JKMN-PQRS  account,
key laptop  3 sockets  since <local time>`, or `No remote sessions are open`;
with the host stopped it says no host is running, so none are open, and exits 0.

With the host stopped, the command reads and writes `apps/host/.data/` itself,
and the host picks the change up at its next start. `status` shows the tunnel as
"host not running", and `SERVER_URL` in the command's own environment only
changes what `status` shows. `link` needs the running host, and so does
`devices approve`, since waiting devices live only in the running host's memory.
`devices` then lists the approved devices from `devices.json`, and `status`
shows the waiting count as unknown. `devices remove` rewrites `devices.json`
without that device, and the host loads it at its next start. The command never
rewrites a `remote-access.json` or `devices.json` that isn't valid, never creates
a missing `devices.json`, and `status` never creates the machine key or the
access keys.

The key is passed on the command line, so it can end up in your shell history
and in `ps`. It is single-use and expires after 15 minutes, which makes that an
accepted risk.

### Relinking after the machine key change

A machine used to prove itself with a random secret in
`apps/host/.data/machine-secret`, which the server hashed into its id. It now
has a machine key instead (section 2), and its id is the hash of the key's
public half, so a machine set up before the change comes back under a new id.
The account's list and the old connect link still name the old id, so do this
once, in this order:

1. Unlink the machine from the client's home page.
2. On the machine, run `bun run host:remote unlink`.
3. Delete `apps/host/.data/machine-secret`. The host no longer reads it.
4. Link the machine again with a new enrollment key (above).
5. Get a new connect link with `bun run host:rotate-key` (section 4), because
   the old link names the old id.

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
| Postgres | `127.0.0.1:<POSTGRES_PORT>`, the `DATABASE_URL` in `.env` |
| Mailpit SMTP | `127.0.0.1:<SMTP_PORT>`, the `SMTP_URL` in `.env` |
| Mailpit inbox | `http://127.0.0.1:<MAILPIT_PORT>` |

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
- A `SERVER_HOST` beyond loopback, so the server is reachable from the network.
- `SERVER_TRUST_PROXY=1` behind a proxy that sets `X-Forwarded-For`, so the rate
  limits see the client's IP and not the proxy's.
- A single server instance, because the server keeps machines in memory. See
  "More than one server instance" in
  [architecture](architecture.md#keeping-the-machine-connected).
- `SERVER_ALLOWED_ORIGINS` only when the client is served from a different
  origin than the server.
