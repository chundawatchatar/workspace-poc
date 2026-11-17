# `corch`: installing and running the host

`corch` is the host (`apps/host`) packaged as one executable. The same file holds the host, the terminal daemon and
the local UI, so a machine needs no Bun, no repo and no `.env` to run it. This guide is for people who install it.
The last section, [Packaging](#packaging), is for contributors who build it.

Running the host from the repo (`bun run dev`) is described in the [README](../README.md). Where this guide says
"dev", it means that.

## Install

Requirements:

- macOS or Linux, on x64 or arm64: `darwin-arm64`, `darwin-x64`, `linux-arm64` or `linux-x64`. Windows and Linux with
  musl are not supported.
- npm, with Node 18 or later, which runs the small `corch` launcher.
- `curl`, for agent tracking: the hooks report to the terminal daemon with `curl --unix-socket`. Without it the
  terminals work, but agents show no working, waiting or idle state from hooks.
- The host runs `git`, `ps` and `lsof` from its `PATH`, as a terminal would.

No release is published yet, so today you build the npm packages from the repo and install their tarballs:

```sh
bun install
bun run package:host
npm i -g --offline --ignore-scripts \
  dist/package/tarballs/corch-<version>.tgz dist/package/tarballs/corch-<os>-<arch>-<version>.tgz
```

`package:host` builds this machine's platform and prints the two tarball names, such as `corch-0.1.0.tgz` and
`corch-darwin-arm64-0.1.0.tgz`. The first is the launcher, the `corch` command; the second holds the executable for
this platform. The launcher runs that executable with the same arguments and terminal, and exits as it did.

Keep `--offline`. The launcher lists all four `corch-<os>-<arch>` packages as optional dependencies, and none is
published yet, so without it npm asks the public registry for those names, this platform's included. Anyone could
publish a package under one of them, and npm would install it and run its install scripts; one under this
platform's name could even be run as `corch` in place of the one you built. With `--offline` npm installs the two tarballs, skips the other platforms' packages and never looks a name up.
`--ignore-scripts` is a second guard: neither package has scripts.

Once a release is published, installing will be one command, and npm will pick the platform package itself:

```sh
npm i -g corch
```

If the platform package is missing, `corch` says so and exits 1:
`corch could not find its executable: the package corch-<os>-<arch> is not installed.`, followed by the command that
reinstalls it.

## Start, run and flags

```sh
corch            # the same as corch start
corch start      # start the host in the background and print its URL
corch run        # run it in the foreground, logging to the terminal; Ctrl+C stops it
corch restart    # stop it, then start it again
corch help       # print the usage
```

`corch start` returns once the host answers, and prints `corch is running at http://127.0.0.1:4599 (pid <pid>)`. Open
that URL in a browser: the local UI is served on the host's own port. A new workspace opens in your home folder. If
the host exits or doesn't answer within 15 seconds, `start` fails and prints the end of the log, stopping the host it
started in the second case. A host that already runs is reported instead (`corch is already running at ...`).

The host listens on `127.0.0.1` only. Each data folder has at most one host, guarded by `corch.lock`; two data
folders can run two hosts on different ports, each with its own terminal daemon.

These options set a setting for the host that starts. They work with `start`, `run` and `restart` only, and are not
saved (see [Settings](#settings-and-corch-config) to keep a value):

| Option | Setting |
| --- | --- |
| `--port <port>` | The port to listen on, on `127.0.0.1` |
| `--relay-url <url>` | The relay server's address |
| `--client-url <url>` | The client app's address |
| `--log-level <level>` | `error`, `warn`, `info` or `debug` |

`--data-dir <dir>` chooses the data folder (next section) and works with every command, anywhere among its arguments,
`corch remote`'s included. A value comes as the next argument or after `=` (`--port=4600`).

A host that runs keeps the settings it started with, so `corch start --port 4600` against it prints
`--port not applied: the running host keeps its settings. Run corch restart with them instead.`

`corch` never reads a `.env` or `bunfig.toml`, from the working folder or anywhere else, and ignores the dev host's
`HOST_HOST`, `HOST_PORT`, `SERVER_URL` and `CLIENT_URL`.

Exit codes: 0 when the command did what it says, 1 when it failed, 2 for arguments that make no command (it prints the
usage), and 3 from `corch status` when no host runs.

## The data folder

Everything the host keeps is in one folder:

| Platform | Default |
| --- | --- |
| macOS | `~/.corch` |
| Linux | `$XDG_DATA_HOME/corch`, or `~/.local/share/corch` when `XDG_DATA_HOME` is unset, blank or not an absolute path |

`--data-dir <dir>` chooses another one, else `CORCH_DATA_DIR`, else the default. A relative path is taken from the
current folder. Every command acts on one data folder's host, so give the same folder to each.

`corch start`, `corch run` and `corch service install` create the folder with mode 0700 when it is missing, then check
it. They refuse it when it is a symbolic link, not a folder, owned by another user, or open to the group or other
users in any way, for example:

```text
corch will not use the data folder /home/me/.local/share/corch: other users have access to it (mode 0755). Run: chmod 700 /home/me/.local/share/corch
```

`corch` never changes the folder's mode itself, and checks only the folder, not its parents.

| File | What it is for |
| --- | --- |
| `config.json` | The settings (next section). |
| `corch.log`, `corch.log.1` | The background host's log. Past 5 MB, `corch.log` is moved to `corch.log.1`. |
| `corch.lock` | Who owns the folder: the host's pid, its instance id and when it started. One host per folder. |
| `corch.run.json` | The running host's pid, instance id and URL, written once it listens. Other commands find the host through it. |
| `corch.service.log` | macOS service only: what the host prints before its own log starts. |
| `state.json` | The layout: workspaces, panes and tabs. Delete it, with the host stopped, to reset the layout. |
| `terminal-daemons/` | One record per terminal: how to reattach to it, its last folder and the agent to resume. |
| `agent-tracking.json` | Your ask-once answers for agent tracking. Delete it to be asked again. |
| `remote-access.json` | The old on/off switch for remote access. No longer read; you can delete it. |
| `machine-key` | The machine's Ed25519 key. The machine id is the hash of its public key, so deleting it gives a new id. |
| `access-keys.json` | The remote access keys, as hashes only. |
| `linked-account.json` | The account this machine is connected to, if any. Its tunnel runs exactly while it exists. |
| `devices.json` | The browsers approved to open this machine remotely (public keys only). |
| `remote-audit.jsonl` | Who opened this machine through the relay, and who was refused. |

`corch.lock` and `corch.run.json` exist only while a host runs; a command that finds them left by a host that is gone
removes them. The files appear as they are needed, so a new folder holds only a few.

The terminal daemon's socket and agent shims are not in the data folder but in a runtime folder of their own,
`/tmp/orchpty-<uid>-<hash>`, one per data folder.

The dev host keeps the same files, apart from the `corch.*` ones, in `apps/host/.data/`.

## Settings and `corch config`

| Setting | Default | Flag | Variable | Value |
| --- | --- | --- | --- | --- |
| `port` | `4599` | `--port` | `CORCH_PORT` | A whole number from 1 to 65535 |
| `relayUrl` | `wss://orch.example.com` | `--relay-url` | `CORCH_RELAY_URL` | `wss://<host>`, or `ws://` on `127.0.0.1`, `[::1]` or `localhost` |
| `clientUrl` | Derived from `relayUrl` | `--client-url` | `CORCH_CLIENT_URL` | An `http://` or `https://` URL |
| `logLevel` | `info` | `--log-level` | `CORCH_LOG_LEVEL` | `error`, `warn`, `info` or `debug` |

- The default `relayUrl` is a placeholder until there is a real deploy.
- A `clientUrl` set nowhere is derived from the `relayUrl` in use: `wss://` becomes `https://` and `ws://` becomes
  `http://`.
- `logLevel` is checked, but nothing reads it yet: the log holds the same lines at every level.

Each setting is picked on its own, in this order: its flag, then its `CORCH_*` variable, then `config.json`, then the
default. An empty flag or variable counts as unset. A value that isn't valid stops the host before it starts, naming
the setting and where it came from, such as `CORCH_PORT (port) must be a whole number from 1 to 65535`.

A host reads its settings once, when it starts. A change applies after `corch restart`.

`config.json` is a JSON object holding only these keys, each optional, such as `{ "port": 4600 }`. You can edit it by
hand, or use `corch config`:

```sh
corch config list                    # each setting, its value and where the value comes from
corch config get <key>               # one setting's value
corch config set <key> <value>       # save a setting in config.json
corch config unset <key>             # remove it from config.json, so its default applies
corch config path                    # where config.json is
```

- `list` and `get` show what a host started from this shell would use: the `CORCH_*` variables, then the file, then
  the defaults. `list` names each source: `env CORCH_PORT`, `file`, `default` or `derived`.
- `set` checks the value and the file first, and writes nothing when either isn't valid. It changes only that key,
  and replaces the file in one step. It prints `Saved <key> <value> in <path>`. With a host running, it adds
  `The running host uses the change after corch restart.` When the variable for that setting is set in your shell, it
  says that the variable overrides the file for a host started from there.
- `set` and `unset` also work while a host runs. While the machine is connected to an account, which the running
  host says, or `linked-account.json` when none runs, they refuse to change `relayUrl` and print
  `This machine is connected to an account through its server address. Run corch disconnect first.`
- `unset` prints the value that now applies: `Removed <key> from <path>. It is now <value> (<source>).`

The dev host reads `relayUrl` and `clientUrl` from `apps/host/.data/config.json`, but takes its port from `HOST_PORT`
and its addresses from `SERVER_URL` and `CLIENT_URL` in `.env` first. It reads no `CORCH_*` variable.

## Stop, status and logs

```sh
corch stop          # stop the host; the terminal daemon and its shells keep running
corch status        # whether the host runs, its URL, its pid, the terminal daemon and the account
corch logs          # the last 200 lines of the background host's log
corch logs --all    # all of it
```

`corch stop` sends the host SIGTERM and waits up to 10 seconds for it to save its state and exit. It never sends
SIGKILL. It prints `Stopped corch (pid <pid>). The terminals keep running; corch terminals stop ends them.`, or
`corch is not running`. The shells keep running, and the next host reattaches to them.

`corch status` exits 0 when the host runs and 3 when it doesn't:

```text
corch is running
  URL: http://127.0.0.1:4599
  pid: 51782
  terminal daemon: current, 2 live terminal(s), up 12 s
  remote access: connected to Ada (a***@example.com) through wss://orch.example.com
  service: not installed
```

The terminal daemon is `current` when it runs this host's build, `outdated` when it runs another build of the same
protocol, `incompatible` when it speaks another protocol, and `not heard from` before the host has reached it (see
[Upgrading](#upgrading)). The `remote access:` line says whether the machine is connected, and to which account and
server, or `not connected`; with no host running it reads `linked-account.json` and adds `(host not running)`. The
`service:` line names the [login service](#the-login-service) and its state.

`corch logs` reads `corch.log.1` and then `corch.log`, so the last 200 lines may span both. Each line starts with the
time in UTC. Control characters other than line breaks and tabs show as `?`, so the log can't send escapes to your
terminal. A host started with `corch run` logs to its terminal instead, and writes no log file.

## `corch terminals stop`

```sh
corch stop
corch terminals stop
```

`corch terminals stop` ends the data folder's terminal daemon and every shell in it, and with them every program
running there: an agent's turn in progress, a dev server. It prints `Stopped the terminal daemon and every shell in it`,
or `No terminal daemon was running`.

It refuses while a host runs, since that host would start the daemon again for its open tabs:
`A host is at <url> (pid <pid>). Run corch stop first: it would start the terminal daemon again.`

Each terminal's record is kept, so the next host reopens the shells in their last folders and offers to resume the
agents that were running (see [terminal daemon](terminal-daemon.md)).

## The login service

```sh
corch service install      # run the host as a service of your user, at login and again after a crash
corch service uninstall    # remove the service; the host stops and the terminals keep running
```

`corch service install` uses your own user's service manager, never root, and refuses to run under `sudo`:

| | macOS | Linux |
| --- | --- | --- |
| Manager | launchd, as an agent in your `gui/<uid>` domain | The systemd user manager |
| Unit file | `~/Library/LaunchAgents/corch.host.plist` | `corch.service` in `${XDG_CONFIG_HOME:-~/.config}/systemd/user/` |
| Raw output | `corch.service.log` in the data folder | `journalctl --user -u corch.service` |

A data folder other than the default gets its own service, so each folder has at most one: `corch.host.<hash>` on
macOS and `corch-<hash>.service` on Linux, where `<hash>` is the first 12 hex digits of the SHA-256 of the folder's
absolute path.

The service runs `corch run --data-dir <dir>` in the background, and nothing else: no setting flags and no
environment. So it takes its settings from `config.json` only, and the `CORCH_*` variables in your shell don't reach
it. While it is installed, `corch start` and `corch restart` refuse setting flags:

```text
--port not used: the service always starts corch with the settings in config.json.
Save them with corch config set <key> <value>, then run corch restart.
```

The unit names the executable by its full path, the `bin/corch` of the platform package, not the launcher.

What it does:

- It starts the host at once, and again at each login. A host that crashes or is killed is started again; one that is
  stopped is not.
- A host already running without the service is stopped first; its terminals keep running.
- Running `install` again rewrites the unit and reloads it.
- While it is installed, `corch start`, `stop`, `restart` and `status` act through the manager, so the manager knows
  whether the host should run.
- Stopping or restarting the host, through the manager or not, leaves the terminal daemon and its shells running:
  launchd leaves the host's process group alone (`AbandonProcessGroup`), and systemd signals only the host's own
  process (`KillMode=process`).
- `corch service uninstall` stops and unloads the service and removes its unit. The terminals keep running, and
  `corch start` runs the host without the service from then on.

On Linux the systemd user manager runs only while you are logged in, unless your user lingers. Logging out then stops
the host and its shells with it. `install` says so when lingering is off; to keep them running, run:

```sh
loginctl enable-linger <user>
```

On macOS the agent runs in your login session's domain, and starts again at your next login.

### The service's `PATH`

The unit sets no environment, so the host gets the manager's own `PATH`:

- launchd gives its agents `/usr/bin:/bin:/usr/sbin:/sbin` (its default environment, read with
  `launchctl print gui/<uid>/<label>` on macOS 27.2). On that `PATH` the host finds `/usr/bin/git` (the Command Line
  Tools' git), `/bin/ps`, `/usr/sbin/lsof` and `/usr/bin/curl`. A tool found only in `/opt/homebrew/bin` or
  `/usr/local/bin`, such as a Homebrew git, is not found by the host. This was checked by running the packaged
  `corch` with exactly that `PATH`, not as a launchd service.
- On Linux the host gets the systemd user manager's environment: its default `PATH`, plus anything set in
  `~/.config/environment.d/`. This has not been checked; a tool outside it is not found by the host.

The shells are login shells (`$SHELL -l`), so your profile builds their `PATH` as it would in a new terminal window.
When the manager sets no `SHELL`, the host uses `/bin/zsh` on macOS and `/bin/sh` on Linux.

## Remote access

Remote access works as the [remote access guide](remote-access.md) describes, with `corch` commands in place of the
repo's scripts:

| `corch` | In the repo |
| --- | --- |
| `corch connect --email <email> --key <key> [--server <url>]` | `bun run host:remote connect ...` |
| `corch disconnect` | `bun run host:remote disconnect` |
| `corch remote <command>` | `bun run host:remote <command>` |
| `corch rotate-key` | `bun run host:rotate-key` |

To connect this machine to your account, sign in to the client, press "Connect a machine" and run the command it
shows on the machine:

```sh
corch connect --email <email> --key <key> --server <url>
```

Without `--server` it uses the built-in default (the `relayUrl` default above), or the address `--relay-url` or
`CORCH_RELAY_URL` gave the running host, which a different `--server` can't change. It checks the email, the key and
the address before it calls the host, and refuses a malformed one without repeating it. It prints the server (with a
warning when it isn't the default), the email and the key's last 4 characters, then asks
`Connect this machine to this account? [y/N]`; any answer but y or yes sends nothing and exits 1, and `--yes` skips
the question. The running host then saves the address as `relayUrl` in `config.json`, opens the tunnel at once and
sends the key, and the server holds the request until you answer it in the client. `corch connect` prints
`Please approve this connect request in the client and check that it shows machine <fingerprint>` and the time left
on the key, as `mm:ss`, then waits. In the client, check that the request shows the same Machine key fingerprint and
press Accept; reject any request whose fingerprint isn't the one this machine shows.

It exits 0 with `Connected to <name> (<masked email>) through <server>` once you accept, and 1 with the reason when
you reject it, cancel it in the Remote access dialog, the key expires, the tunnel drops or the host stops. Ctrl-C,
while it waits or while the Connect call is on its way, cancels the request, says nothing was linked and exits 1.
`--yes` skips only the question: the command still waits for your answer. Nothing either command prints holds the
key.

`corch disconnect` asks `Disconnect this machine from <name> (<masked email>)? [y/N]` (or not, with `--yes`), asks the
server to remove the machine from the account's list, and forgets the account on the machine either way. When the
server didn't remove it, it says to remove it in the client. Both commands need the running host, and say so when none
runs.

`corch remote` takes the same commands (`status`, `connect`, `disconnect`, `devices`, `sessions`, `log`); `corch remote
help` lists them. They act on the data folder's running host when there is one, and on the files in the data folder
when there isn't. The old `link`, `unlink`, `server`, `on` and `off` print the usage.

What differs from dev:

- The relay and client addresses are the `relayUrl` and `clientUrl` settings in `config.json`. Connect, from the
  Remote access dialog or `corch connect`, saves the relay address there; `corch config set` saves either, but
  `relayUrl` only while the machine is not connected. A changed client address applies from the next start.
- The tunnel runs exactly while the machine is connected: a host started with `linked-account.json` opens it, and one
  without never does. `SERVER_URL` and `CLIENT_URL` are ignored.
- A relay address given with `--relay-url` or `CORCH_RELAY_URL` is the one Connect uses; the dialog shows it
  read-only.
- The connect link the host prints is in its log: `corch logs`, or the terminal of `corch run`.

## Upgrading

Install the new tarballs over the old ones, the same way as in [Install](#install). A running host and terminal daemon
keep running the old executable until they are replaced. `corch restart` replaces the host. What happens next depends
on the terminal daemon that still runs.

**(a) The new host speaks the same daemon protocol** (`DAEMON_PROTOCOL` in `packages/terminal/src/daemon-protocol.ts`).
This is the usual case. The new host attaches to the old daemon, the shells keep running and the terminals work. The
daemon still runs the old build, so `corch status` shows it as `outdated`, the log warns that it runs different code,
and the local UI's daemon line (at the bottom of the Keyboard shortcuts dialog) says "out of date". It stays that way
until you replace it:

```sh
corch stop
corch terminals stop
corch start
```

That ends the shells. Agents can be resumed on their conversations; other programs are lost. Do it when it suits you.

**(b) The protocol differs.** The new host leaves the old daemon and its shells running, untouched, and no terminal
attaches to it. It reports this in `corch status` (`incompatible`), in the log (`terminal daemon speaks protocol <n>,
this host speaks <m>, so no terminal can attach to it.`) and in the local UI, where the daemon line says
`incompatible (protocol <n>)` and each terminal says it can't attach. The same three commands, `corch stop`,
`corch terminals stop`, `corch start`, are the only way to replace it.

**(c) With the service installed**, the steps are the same: `corch restart`, `corch stop` and `corch start` go through
the manager, and a host stopped through it stays stopped until `corch start`. The unit names the executable by its
path, which an upgrade in the same npm prefix keeps. If it moves, for example to another Node version's prefix, run
`corch service install` again to rewrite the unit.

To skip the outdated state, stop everything before you upgrade: `corch stop`, `corch terminals stop`, install, then
`corch start`.

## Uninstalling

In this order:

1. `corch service uninstall`, when a service is installed.
2. `corch stop`.
3. `corch terminals stop`, which ends every shell.
4. `npm rm -g corch`. A tarball install also installed the platform package on its own, so remove it too:
   `npm rm -g corch-<os>-<arch>`.
5. Delete the data folder: `~/.corch` on macOS, `~/.local/share/corch` (or `$XDG_DATA_HOME/corch`) on Linux, or the
   one you chose. **It holds `machine-key`: deleting it gives the machine a new id**, so its connect links and its
   link to an account stop working. Run `corch disconnect` first if it is connected.

The terminal daemon's runtime folder, `/tmp/orchpty-<uid>-<hash>`, is left behind; delete it too, or let the next
reboot clear `/tmp`.

## Security notes

- The host listens on `127.0.0.1` only. Nothing on the network reaches it; remote access goes out through the relay
  tunnel, never in.
- The host answers only `Host` headers of `127.0.0.1:<port>`, `localhost:<port>` and `[::1]:<port>`. An `/etc/hosts`
  alias or a local reverse proxy gets 403. This stops DNS rebinding, where a web page renames its own site to this
  machine.
- It also refuses requests from pages that weren't served from this machine (their `Origin`). Programs on this
  machine can still call it: the host has no sign-in, which is enough for a local tool only.
- The data folder must be yours and private (0700), and the process files and the log are readable by you only. The
  log can hold a connect link, which carries an access key, so don't paste it anywhere.
- `corch` reads no `.env` or `bunfig.toml`, so a folder you start it from can't change its settings or run code in it.
- The service runs as your user, never as root.
- Until a release is published, install only with `--offline`, as in [Install](#install), so npm never fetches an
  unpublished `corch-<os>-<arch>` name from the public registry.

## Packaging

For contributors. `apps/host/src/main.ts` is the executable's one entry point. With `__daemon` as its first argument
it runs the terminal daemon; with a build id compiled in it runs the `corch` command (`apps/host/src/cli/`); otherwise
it is the dev host (`apps/host/src/index.ts`). Building lives in `apps/host/packaging/` and `scripts/package-host.ts`.

```sh
bun run package:host                        # this machine's platform
bun run package:host --target linux-x64     # the ones named; --target can repeat
bun run package:host --all                  # all four
bun run test:package                        # install this platform's tarballs and smoke-test them
```

`bun run package:host`:

1. Builds the local UI (`apps/web`) and generates an entry point that embeds its files, then runs `main.ts`.
2. Compiles it once per target, with `bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig
   --target=bun-<os>-<arch> --define=ORCH_BUILD_ID=...`.
3. Signs each darwin executable ad hoc and checks the signature.
4. Lays out the npm packages in `dist/package/npm/` (the `corch` launcher and one `corch-<os>-<arch>` per target)
   and packs them into `dist/package/tarballs/`.

The four targets are `darwin-arm64`, `darwin-x64`, `linux-arm64` and `linux-x64`. A darwin target builds only on
macOS, since only macOS can sign it. Cross-compiling downloads Bun's runtime for the target, so it needs the network.

The build id is `<version>+<commit>`, with `.dirty` when the working tree had changes. The version is the launcher's,
in `apps/host/packaging/npm/corch/package.json`, and every platform package shares it.

The launcher, `apps/host/packaging/npm/corch/bin/corch.js`, is plain JavaScript for Node 18 or later, or Bun. It finds
`corch-<os>-<arch>/bin/corch` from its own folder, runs it with the same arguments and terminal, and exits with its
code, or dies from the same signal.

`bun run test:package` installs this platform's tarballs as a user would, into a temporary npm prefix with no
registry to reach, with a temporary `HOME` and data folder, from a folder whose `.env` and `bunfig.toml` would change
the host if it read them. It runs `start`, the served UI, a terminal, `stop` and `terminals stop`, builds the tarballs
first when they are missing, and ends with a `PASS` line. CI runs it on all four platforms
(`.github/workflows/package-smoke.yml`).

What a compiled executable needs, as found when the host was first compiled:

- **macOS binaries must be signed.** Bun's darwin output carries an invalid signature, and macOS kills it at start
  with exit 137 and no output. `package:host` signs each one ad hoc (`codesign --force --sign -`) and checks it.
- **No `.env` or `bunfig.toml` autoload.** By default a compiled executable loads both from its working folder, and a
  `bunfig.toml` preload runs its code inside the binary. Builds pass `--no-compile-autoload-dotenv
  --no-compile-autoload-bunfig`.
- **The UI and the build id are compiled in.** The built `apps/web` is embedded and served on the host's own port.
  The build id is compiled in with `--define`, since the sources the dev host hashes aren't in an executable; a host
  and the daemons it starts compare it to tell whether a daemon runs their code.
- **Nothing may resolve paths from `import.meta.dir`.** Inside the binary it is `/$bunfs/root`, a read-only folder
  inside the executable. The data folder is passed in, and the project folder is the home folder.
- **The daemon is a subcommand.** A compiled executable always runs its own code, whatever its arguments, so it can't
  start a script. The host starts the daemon by running itself with `__daemon`.
- **The runtime folder is per data folder.** Each compiled host's daemon runtime folder is named after its data
  folder, so two hosts never share a daemon.
- **No native dependencies.** The pseudo-terminal is Bun's own, and every dependency is plain JavaScript. At runtime
  the host still runs `git`, `ps` and `lsof` from `PATH`, and the agent hooks need `/bin/sh` and `curl`. The hooks are
  scripts the daemon writes into its runtime folder, not files of the package.
