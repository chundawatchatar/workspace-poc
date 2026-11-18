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

The server always runs with accounts. It needs Postgres, the mail settings and
the other accounts settings (section 5), which a `.env` copied from
`.env.example` fills with dev values, and it refuses to start until each is set
and Postgres is up and migrated: `bun run db:up`, then `bun run db:migrate`.
Then `curl -s http://<SERVER_HOST>:<SERVER_PORT>/api/health` answers `{"ok":true}`. How to work
on accounts is in [accounts](accounts.md).

## 2. Connect a machine

Remote access needs an account (section 5 and [accounts](accounts.md)): a
machine opens from another browser only through the account it is connected
to, and the tunnel to the server runs exactly while it is connected to one.

1. Sign in to the client at `http://<CLIENT_HOST>:<CLIENT_PORT>` and press
   "Connect a machine" on the home page. It creates a one-time key, valid for
   15 minutes, and shows the command to run on the machine:

   ```bash
   corch connect --email <your email> --key <key> --server ws://<SERVER_HOST>:<SERVER_PORT>
   ```

   The server address is the server's `SERVER_TUNNEL_URL`. The email is quoted
   when it holds a character a shell would read otherwise.
2. On the machine, run it: `corch connect ...` for an installed `corch`, or
   `bun run host:remote connect ...` with the same flags for the dev host
   (section "From the terminal"). Or open the local app at
   `http://<WEB_HOST>:<WEB_PORT>`, pick "Remote access…" from the command palette,
   and fill in "Server address" (prefilled with the address in use), "Email" and
   "Key", then press Connect.
3. Both first show what to check: the email, the server address, with a warning
   when it isn't the built-in default, and "Key ends in" with the key's last 4
   characters, which the client showed too. Connect only to a server you run or
   trust.
4. The machine then asks the account to link it and waits. The dialog shows, in
   place of the fields, `Please approve this connect request in the client and
   check that it shows machine <fingerprint>`, with the time left on the key as
   `mm:ss` and Cancel; the command prints the same sentence and the time left,
   then waits. The fingerprint is the machine's own (Machine key in the dialog).
5. In the client, "Connect a machine" replaces "Waiting for the machine to
   connect…" with the machine's name, its Machine key fingerprint and Accept and
   Reject. The home page lists every waiting request of the account above your
   machines too. The client works the fingerprint out from the machine id
   itself. Check that it is the one the machine shows, and reject any request
   whose fingerprint isn't: someone else may hold your key.

Connect then, in this order:

1. saves the server address as `relayUrl` in the host's settings file,
   `config.json` in its data folder, unless a flag or variable sets it (the
   built-in default is saved as no address, so a later default applies);
2. clears the approved and waiting browsers;
3. opens the tunnel to that address at once, with no restart, and waits for it
   to connect;
4. sends the key with the email over the tunnel (`enroll.request`). Once the
   server holds the request for you, it answers `enroll.waiting` with the key's
   time left, and Connect returns with the request waiting (`connectRequest` in
   the status);
5. on Accept, the server uses up the key, links the machine and tells it
   (`enroll.redeemed`); the host saves the account in `linked-account.json`,
   and the dialog shows the account, its server and "Connected".

On any failure before the request waits (the server can't be reached, the key
or the email is refused, too many tries, a timeout) nothing is linked and the
tunnel is stopped. The answer never holds the key or the email.

A waiting request ends unlinked on any of these, and the host then stops the
tunnel and records why in the status (`connectOutcome`), which the dialog shows
above the fields again:

- Reject in the client (`rejected`): the key is used up.
- The key's time running out (`expired`): the host gives up on its own clock,
  from the time left the server sent, so the two clocks don't need to agree.
- Cancel in the dialog, `routes.remoteAccess.cancelConnect`, or Ctrl-C in the
  command (`cancelled`). Stopping the tunnel ends the request on the server, so
  no cancel frame is needed. Cancel also ends a Connect still on its way, and
  changes nothing when none is.
- The tunnel dropping, or the server restarting, which forgets waiting requests
  (`failed`).

A new Connect clears the outcome; a second one while a request waits gets a 409.
A key whose request ended without an answer stays unused and keeps this
machine's id, so the same machine can connect again with it, and any other gets
`invalid_key`. An Accept can race a Cancel, an expiry or a dropped tunnel by one
round trip: the account then lists a machine that isn't connected, and you
remove it in the client.

A host started with a valid `linked-account.json` counts as connected and opens
the tunnel at start, so it reconnects on its own. One without it never opens a
tunnel, whatever `SERVER_URL` says. The status line reads "Not connected",
"Connecting…", "Waiting for approval…", "Connected", "Reconnecting…", or "Connection lost" when the
machine is connected but its tunnel stopped (another host took over its
machine key, or the server speaks another protocol version).

The host accepts `ws://` only for a loopback host (`127.0.0.1`, `[::1]` or
`localhost`). Any other server needs `wss://`.

The packaged `corch` reads the same `relayUrl` key (see
[the `corch` guide](corch.md#settings-and-corch-config)). While the machine is
connected, its server address stays as it is: `corch config set relayUrl` and
`corch config unset relayUrl` refuse and say to run `corch disconnect` first.

In dev, `SERVER_URL` in `.env` fixes the server address:

```bash
SERVER_URL=ws://<SERVER_HOST>:<SERVER_PORT>
```

It no longer turns the tunnel on: only connecting does. With `SERVER_URL` set,
the dialog shows the server address read-only ("Set by SERVER_URL."), Connect
uses it, and a different one is refused. A packaged host doesn't read it: it
takes its server address from `--relay-url`, the `CORCH_RELAY_URL` variable, or
`config.json`, in that order.

Disconnect, in the dialog (it asks first), with `corch disconnect` or with
`bun run host:remote disconnect`, asks the server to remove the machine from the
account's list when it can (section 4), then forgets the account and its
approved and waiting browsers, closes the sockets the account opened, and stops
the tunnel. When the server didn't remove it (the tunnel was down, the server
didn't answer or failed, or `linked-account.json` predates account ids), the
dialog and the command say to remove it from the list in the client.

The host keeps its remote access files in its data folder, `apps/host/.data/`
in dev (gitignored) and `~/.corch` or `~/.local/share/corch` for `corch` (see
[the `corch` guide](corch.md#the-data-folder)):

- `config.json`: the saved server address, among the host's other settings. A
  `clientUrl` left there by an older host is ignored.
- `machine-key`: the machine's Ed25519 private key (PKCS#8 PEM, readable only
  by you). It never leaves the machine: the host signs the server's challenge
  with it, and the machine id is the hash of its public key. Keep it: deleting
  it gives the machine a new id, so the account's list no longer names it and
  every browser must check its new key again.
- `linked-account.json`: the account this machine is connected to, if any
  (section 4).
- `devices.json`: the browsers approved for that account (section 4).

`remote-access.json`, which held the old on/off switch, and `access-keys.json`,
which held the old access keys, are no longer read, and you can delete them. A
data folder from before `config.json` that still keeps its addresses there has
them moved into `config.json` once, as before.

The host itself stays local. It listens on a loopback address only
(`127.0.0.1` for `corch`), and answers only
`Host` headers of `127.0.0.1:<port>`, `localhost:<port>` and `[::1]:<port>`. An
`/etc/hosts` alias or a local reverse proxy gets 403. Requests that come
through the tunnel are checked by their relay ticket and device proof instead
(section 4), so the tunnel is the only way in from another machine.

## 3. Open it from a browser

Once the machine is connected, any browser signed in to that account opens it
from the client's home page: every machine in the list has an Open link. The
browser reaches it only through the account, with a relay ticket and its own
device key (section 4).

The machine key's fingerprint, such as `ABCD-EFGH-JKMN-PQRS`, is the first 10
bytes of the machine id (the SHA-256 of the machine's public key) in the same
groups as a device fingerprint. It shows beside the machine id in the "Remote
access…" dialog (`Machine key ABCD-…`) and on the `Machine key:` line of
`bun run host:remote status`.

Before the page opens any terminal, the browser asks the machine for its public
key (`GET /api/machine-key`, through the relay with the same ticket and device
proof as every other request) and checks that it hashes to the machine id. The
first time a browser opens the machine, nothing printed by the host vouches for
the machine id the server listed, so once the machine answers its key the page
asks you to type the fingerprint the machine shows: Machine key in its "Remote
access…" dialog, or `bun run host:remote status`. The page doesn't show the
fingerprint itself, so it can only come from the machine. Confirm stays
disabled until the typed fingerprint matches (dashes, spaces and case don't
matter), so a stray click can't pin a key; "It doesn't match" pins nothing and
shows the warning below. The browser then pins that key in IndexedDB beside its
device key; every later open checks the key against the pin and doesn't ask
again.

If the page says **"The machine key doesn't match"**, the key it got isn't the
one this browser trusts for that machine: something between them, such as a
compromised server, may be posing as it. The page stops there, with no Retry,
and opens no terminal socket. Check the fingerprint with
`bun run host:remote status` on the machine and don't open it from that browser
until you know why. A relinked machine with a new key has a new id, so it gets a
new pin rather than this warning.

## 4. The account, its browsers and Disconnect

A machine joins an account's list only when the owner accepts, in the client,
the request it made over its own tunnel with a one-time enrollment key and the
account's email (section 2).

The server holds the request only when the email is the key owner's, in any
letter case and with any spaces around it. Another account's email, an email
with no account and a malformed one get the same `invalid_key` answer as an
unknown, used or expired key, or a key another machine already asked with, and
the key stays as it was, so a typo can be fixed without a new key. The machine
id is always the tunnel's own, from its signed `hello`, never anything in a
frame or the key. Each machine gets 10 tries, then one more every 30 seconds
(an `unlink` counts too). One tunnel holds one request: asking again with
another key replaces it. Waiting requests live in the server's memory only.

The host saves the account (name, masked email, server address, when it was
linked, the account's user id and the server's relay public keys, never the key
or the email) in `linked-account.json`. The user id and the public keys stay on
the machine: the dialog and the status never show them. A connected machine
must disconnect before it connects again.

Once connected, any browser signed in to that account opens the machine from the
client's home page (section 3). To do so, the browser asks the server for a
relay ticket: a short-lived Ed25519 signature saying "this account may open
this machine for 60 seconds", issued only for a machine in the account's list.
It sends the ticket in the `x-orch-relay-ticket` header on requests and as a
WebSocket subprotocol on sockets, never in a URL or a cookie. The server relays
it unchanged; the host checks it:

- the signature verifies against one of the public keys it saved for the
  ticket's key id;
- it names this machine and the linked account, and hasn't expired (30 seconds
  of clock skew are allowed);
- the account was connected through the server address in use;
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
kept in `devices.json` in the data folder (public keys only; delete it to approve
again); Revoke takes one away and closes what it has open. Every browser must
be approved once, and an older page, which sends no proof, is refused.

While the machine is connected to an account, the local page's sidebar shows
the remote access status above its footer (Connected, Connection lost,
Reconnecting…, read every 5 seconds), and clicking it opens Sessions and Recent
activity in their own dialog; the Remote access setting no longer shows them.
Sessions shows the approved browsers with sockets open
through the tunnel right now, polled every 2 seconds: one row per browser, with
its fingerprint, `Account` for what it came in with, how many sockets it holds
and when the first one opened. Sockets still waiting for
their auth message aren't counted, and tunneled HTTP requests, which hold
nothing open, aren't shown. End closes that browser's sockets with 4401 but
leaves it approved, so its page stops at "access denied" and a reload opens the
machine again; Revoke it under Devices to remove it for good. `bun run
host:remote sessions` prints the same list. Like the Remote access setting,
both are refused through the tunnel, and the list lives only in the running
host's memory. Recent activity, beside it, is the host's audit log (see
[architecture](architecture.md)); while no account is linked the status isn't
shown, so read it with `bun run host:remote log`.

Anything else is refused. A `linked-account.json` saved before this (with no user id or public
keys) still loads and shows the account, but accepts no ticket: disconnect and
connect again with a new enrollment key.

Disconnect first asks the server, when the tunnel is connected and the account's
user id is known, to remove the machine from that account's list: the host
sends `unlink` with the user id, and waits up to 10 seconds for `unlinked` or
`unlink.failed`. The server removes only the row of that account for the
tunnel's own machine id, through the account's scoped repository, and answers
`unlinked` whether or not there was one, so no frame can remove another
machine. When it fails (too many tries, or a server error) it answers
`unlink.failed`. Then, whatever the answer, the host deletes
`linked-account.json` and `devices.json`, so it forgets the account and its
browsers, closes the sockets the account has open, and stops the
tunnel, telling the server with `remote.off` so the list can show "remote
access off" until it is removed. A machine the server didn't remove stays on
the list until you remove it from the client's home page, but it refuses that
account's tickets from then on. The tunnel protocol is at version 6 for these
frames (`enroll.request`, answered by `enroll.waiting`, then `enroll.redeemed`
or `enroll.failed` with `rejected`); a host on an older version gets
"unsupported version" from the server.

Accepted risks: someone who gets hold of a live key and knows the account's
email can still put a request in front of you; the fingerprint check is the
defence, so reject any request whose fingerprint isn't the one your machine
shows. Guessing the email no longer links anything: a right guess only creates
a request you see. The server still says who is signed in, so it decides who owns
an enrollment key and who gets relay tickets, but a leaked `RELAY_SIGNING_KEY`
or a compromised server can't open a machine without an approved browser. It
can mint tickets to put its own key in the Devices list, hoping you approve it,
which is why approval takes a fingerprint typed from your own browser and
checked by the host, so a click on the list can't approve it. Copying a
fingerprint you don't recognise from the list and typing it in still would.
Requests and sockets are encrypted end to end between your browser and the
machine, and through the server the machine refuses any that aren't (logged as
"Refused: not end-to-end encrypted"), except the two that open a session:
fetching the machine's key and the handshake itself. So a compromised server
can neither read nor inject into a session. What remains: a compromised server
could serve its own page, which can't be ruled out for a web app (the open
sessions list, the activity log and Disconnect are your cover);
it still sees timing, sizes and which device connects; it sees the ticket and
the browser's proof in the clear on those two requests, though they open
nothing without an approved browser; and it can cut connections. A browser whose clock is more than 5
minutes off is refused. Revoking a session or unlinking on the server stops new tickets at
once, but a ticket already issued works for up to a minute. When a session
ends on the server (a revoke, a sign-out or a password change), the server
sends the machine a `session.ended` frame that names only the account. The
host checks that account against its own link and, if it matches, closes the
sockets that account's tickets opened with code 4410; the link and the
devices stay as they are. Browsers still signed in reconnect with a
fresh ticket, and the revoked one can't get one. The operator script
`sessions:revoke-user` and an expired session send no frame, and removing the
machine on the server closes nothing either; disconnecting on the host closes
the account's sockets. A refused ticket sends
`auth.failed`, so it counts against the browser's IP limit for refused
requests.

### From the terminal

On a machine where you don't open the host page (over SSH, a headless box, a
setup script), `bun run host:remote` does what the dialog does:

```bash
bun run host:remote status             # server address, connection, machine id and key, account
bun run host:remote connect --email <email> --key <key> [--server <url>]   # waits for your accept; add --yes to skip the question
bun run host:remote disconnect                      # add --yes to skip the question
bun run host:remote devices                         # waiting and approved devices, newest first
bun run host:remote devices approve <fingerprint>   # add --yes to skip the question
bun run host:remote devices remove <fingerprint>    # dismiss a waiting device, or revoke an approved one
bun run host:remote sessions                        # approved devices with tunneled sockets open
bun run host:remote log                             # who opened this machine through the tunnel, and who was refused
```

An installed `corch` has the same commands as `corch remote <command>`
(`corch remote help` lists them), acting on its own data folder, and
`corch connect` and `corch disconnect` with the same flags. See
[the `corch` guide](corch.md#remote-access). The old `link`, `unlink`, `server`,
`on` and `off` commands are gone and print the usage.

With the host running, every command goes through its local-only Remote access
endpoints, so the host stays the one owner of remote access. `connect` checks
the key, the email and `--server` before it calls the host, and refuses a
malformed one with a message that doesn't repeat it. Without `--server` it uses
the built-in default, or the address `SERVER_URL`, `--relay-url` or
`CORCH_RELAY_URL` sets, which a different `--server` can't change. It prints
the server (with the warning), the email and `Key ends in: <last 4>`, then asks
`Connect this machine to this account? [y/N]`; any answer but y or yes sends
nothing and exits 1, and `--yes` skips the question but still prints them.
Once the server holds the request, it prints `Please approve this connect
request in the client and check that it shows machine <fingerprint>` and the
time left once, as `mm:ss`, then reads the host's status every second. It exits
0 with `Connected to <name> (<masked email>) through <server>` once you accept,
and 1 with the reason on a reject, a Cancel in the dialog, the key expiring, a
dropped tunnel or the host stopping. Ctrl-C, while it waits or while the
Connect call is on its way, cancels the request, says nothing was linked and
exits 1; `--yes` doesn't change any of this.
`disconnect` asks `Disconnect this machine from <name> (<masked email>)? [y/N]`
the same way, and prints `Remove it in the client` when the server didn't
remove the machine from the account's list. Nothing either command prints holds
the key, and the email shows only in the line you check.

`devices` lists each device by its fingerprint, such as `ABCD-EFGH-JKMN-PQRS`,
with `waiting, seen 3 min ago` or `approved 2 days ago`, and `status` adds a
`Devices:` line with both counts. `devices approve <fingerprint>` asks
`Approve <fingerprint>? It will be able to open this machine remotely. [y/N]`;
`--yes` skips the question. It sends the typed fingerprint to
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

With the host stopped, the command reads the data folder itself. `status` shows
the tunnel as "host not running", and `SERVER_URL` in the command's own
environment only changes what `status` shows. `connect` and `disconnect` say no
host is running and exit 1, and so does `devices approve`, since waiting devices
live only in the running host's memory. `devices` then lists the approved
devices from `devices.json`, and `status` shows the waiting count as unknown.
`devices remove` rewrites `devices.json` without that device, and the host loads
it at its next start. The command never rewrites a `devices.json` that isn't
valid, never creates a missing one, and `status` never creates the machine key.

The key is passed on the command line, so it can end up in your shell history
and in `ps`. It is single-use and expires after 15 minutes, which makes that an
accepted risk.

### Relinking after the machine key change

A machine used to prove itself with a random secret in
`machine-secret` in the data folder (`apps/host/.data/` in dev), which the server hashed into its id. It now
has a machine key instead (section 2), and its id is the hash of the key's
public half, so a machine set up before the change comes back under a new id.
The account's list still names the old id, so do this once, in this order:

1. Remove the machine from the client's home page.
2. On the machine, run `bun run host:remote disconnect`.
3. Delete `machine-secret` from the data folder. The host no longer reads it.
4. Connect the machine again with a new enrollment key (section 2).

After reconnecting, each browser that opens the machine is approved again
(section 4) and pins the new machine key by typing its fingerprint (section 3).

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
| Postgres | `127.0.0.1:<POSTGRES_PORT>`, the `DATABASE_URL` in `.env` |
| Mailpit SMTP | `127.0.0.1:<SMTP_PORT>`, the `SMTP_URL` in `.env` |
| Mailpit inbox | `http://127.0.0.1:<MAILPIT_PORT>` |

Every port is published on `127.0.0.1` only, so nothing is reachable from the network.

To reset the database, remove the volume as well: `docker compose down -v`, then `bun run db:up`.

The server loads the root `.env` itself through `loadRootEnv()` from `@orch/shared/env`, however it is started.
Variables already set in the shell win over the file. It always needs `DATABASE_URL`, `BETTER_AUTH_SECRET` (at
least 32 bytes), `BETTER_AUTH_URL`, `SMTP_URL`, `MAIL_FROM`, `RELAY_SIGNING_KEY` and `SERVER_TUNNEL_URL` (the address
machines open their tunnel to, `wss://<host>` or `ws://` on a loopback host, with no path, sent with every new
enrollment key), which `.env.example` fills with dev values, and it exits with a message naming the problem when one
is missing or not valid, the database is unreachable, or a migration is pending.

Migrations, Better Auth, sessions and reading the emails are covered in [accounts](accounts.md).

## 6. What changes for a real deploy

This guide stops at one computer. The next phase ("Later: deploy" in the
factory backlog) must handle:

- TLS in front of the server.
- `wss://` server addresses and `https://` client addresses, `SERVER_TUNNEL_URL`
  among them. This is also what a second computer needs, since `ws://` works only
  on loopback.
- A `SERVER_HOST` beyond loopback, so the server is reachable from the network.
- `SERVER_TRUST_PROXY=1` behind a proxy that sets `X-Forwarded-For`, so the rate
  limits see the client's IP and not the proxy's.
- A single server instance, because the server keeps machines in memory. See
  "More than one server instance" in
  [architecture](architecture.md#keeping-the-machine-connected).
- `SERVER_ALLOWED_ORIGINS` only when the client is served from a different
  origin than the server.
