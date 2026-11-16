# workspace-poc

A browser prototype of a cmux-style workspace: a sidebar of workspaces, split
panes, tabs in every pane, and real terminals. It exists to show what the
browser-only design can do. The name is a placeholder.

What the product should do, and how far the prototype has got, is in
[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

## Run

```bash
bun install
bun run dev
```

Then open http://127.0.0.1:3210. The host listens on 127.0.0.1:4599. Run this
way, it keeps its files in `apps/host/.data/` (gitignored), the dev data
folder; an installed `corch` keeps the same files in its own data folder (see
[Install `corch`](#install-corch)).

Terminals run in one shared daemon, so updating or restarting the
host leaves shells and agents running. If the daemon itself restarts, plain
shells reopen in their last folder and agent terminals offer to resume the
agent's conversation. See [terminal daemon](docs/terminal-daemon.md) for how it
works.

To reach this machine through the cloud server (`apps/server`), follow the
[remote access guide](docs/remote-access.md). In short: open
"Remote access…" from the command palette in the local app. Enter the server
address, `wss://<server>` or `ws://127.0.0.1:4600` (any loopback host) for a
local server, and optionally the client address, then turn it on. The host
keeps one tunnel open to the server, and the dialog shows whether it is
connected; turning it off closes the tunnel and every remote session at once.
The addresses are saved as `relayUrl` and `clientUrl` in `config.json` in the
data folder (`apps/host/.data/` in dev), and apply from the host's next start;
the on/off switch is saved in `remote-access.json` and applies at once, so
every later start reconnects on its own. In dev, `SERVER_URL` and `CLIENT_URL`
in `.env` override the saved addresses, and `SERVER_URL` still turns the tunnel
on at start whatever the switch says; the packaged `corch` reads neither. The
host is identified by an Ed25519 key it creates in `machine-key` in the data
folder, which never leaves the machine: it signs the server's challenge when
the tunnel opens, and the machine id is the hash of its public key. Keep that
file: deleting it gives the machine a new id. A machine set up with the older
`machine-secret` file relinks once (see `docs/remote-access.md`). Terminals and
layout sync work through the tunnel as well as the HTTP API.

Every tunneled request and socket needs an access key. The first time remote
access is on, the host creates one and prints a connect link,
`<client>/#machine=<id>&key=<key>`, once: only the key's hash is kept, in
`access-keys.json` in the data folder. Open the link to reach the machine from
the global app. The client address is `CLIENT_URL` (dev only), else the saved
one, else the server address with `ws`/`wss` swapped for `http`/`https`. Lost
the link, or want to cut everyone off? Press "New connect link" in the dialog,
or run `bun run host:rotate-key` (`corch rotate-key` when installed): either
gives a new link and closes every remote session that used the old key.
`bun run host:remote` (`corch remote`) sets up remote access from a terminal
(`status`, `server <url>`, `on`, `off`, `link <key>`, `unlink`).

The server serves the global app itself, so the connect link opens on the
server's own origin and needs no CORS. Build the client with
`bun run --filter @orch/client build`, then start the server with
`bun run --filter @orch/server start` (127.0.0.1:4600). It serves the folder
in `SERVER_STATIC_DIR` (required, `apps/client/dist` in `.env.example`; a
relative path resolves from the repo root, whatever the working directory);
without a build it only relays. `SERVER_MAX_CHANNELS` (required) caps the open
channels per machine, and `SERVER_REQUEST_TIMEOUT_MS` (required) is how long a
relayed HTTP request waits for its machine. It answers cross-origin calls only
from the exact origins in the optional `SERVER_ALLOWED_ORIGINS`
(comma-separated). It rate-limits connections per IP and per machine, and
blocks an IP for a while after too many rejected keys. Behind a proxy that sets
`X-Forwarded-For`, set `SERVER_TRUST_PROXY=1` so the limits see the client's IP,
not the proxy's.

## Install `corch`

The host also ships as `corch`, one executable that holds the host, the
terminal daemon and the local UI, for macOS and Linux on x64 and arm64. It
keeps its files in its own data folder (`~/.corch` on macOS,
`~/.local/share/corch` on Linux), never in the repo. No release is published
yet, so build and install it from the repo:

```bash
bun run package:host
npm i -g --offline --ignore-scripts \
  dist/package/tarballs/corch-<version>.tgz dist/package/tarballs/corch-<os>-<arch>-<version>.tgz
corch start
```

Keep `--offline`: the platform packages aren't published yet, so without it npm
would look their names up in the public registry, where anyone could claim
them. Once a release is published, `npm i -g corch` will do. `corch` then runs the
host in the background (`start`, `stop`, `status`, `logs`), takes its settings
from `corch config`, and can run as a login service (`corch service install`).
How to install, configure, upgrade and remove it is in the
[`corch` guide](docs/corch.md).

## Layout

| Path | What it is |
| --- | --- |
| `apps/web` | The local app shell: TanStack Start and the router, rendering `packages/terminal-ui` against the local host |
| `apps/client` | The global app: a TanStack Start SPA, built to a static folder, that lists the machines linked in this browser and opens one through the cloud server. Run it with `bun run dev:client` |
| `apps/site` | The marketing site and user docs: a static Astro site styled as an Orchestrator window, reusing the app's themes and shortcut list. Run it with `bun run dev:site` |
| `apps/host` | The host service: Bun and Hono. Owns the layout and talks to terminals |
| `apps/ptyd-bun` | The Bun terminal daemon: owns the PTY and screen so shells outlive the host |
| `packages/terminal` | The PTY, the mirrored screen, process and agent detection, and the daemon wire protocol |
| `packages/shared` | The layout model, its reducer, and the browser wire protocol |
| `packages/ui` | Shared UI: themes, styles and store-free components (modal, theme picker, terminal) |
| `packages/terminal-ui` | The page inside a machine: sidebar, layout, terminals, palette and its store, reaching the host through a transport. React, Tailwind, xterm.js |

## What is real

- Terminals are real shells on the machine, started by the host.
- Sessions belong to the host. Reload the page or switch workspace and the
  terminal comes back with its screen intact.
- The layout is stored by the host (`state.json` in its data folder,
  `apps/host/.data/` in dev) and pushed to every open window, so two browser windows stay in step.
- A bell or a notification escape sequence marks the pane, its tab and its
  workspace until you look at it. Try, from an unfocused pane:
  `sleep 3; printf '\e]9;Build finished\a'`
- With the same terminal open in two windows of different sizes, it takes the
  size of the window you are typing in or last focused.
- A full screen button on every pane (also `Ctrl+B` then `Z`, or `Ctrl+Shift+F`)
  makes it fill the app window. Esc still goes to the terminal.
- Themes: eight built in (five dark, three light), each covering the interface
  and the terminal colours. The sun/moon button at the bottom of the sidebar
  switches between light and dark; the palette button beside it (or `Ctrl+B`
  then `T`) opens the picker. One theme is remembered for each side, and
  "System" follows the OS. To add a theme, append to `packages/ui/src/themes.ts`.
- Tabs can be dragged: within a tab bar to reorder them, onto another pane's tab
  bar to place them there, or onto another pane's body to add them at the end.
- The sidebar is resizable: drag its right edge (double-click to reset). `Cmd+B`
  or `Ctrl+B` then `B` hides and shows it.
- Animation: panes glide when the layout changes (split, close, full screen),
  the sidebar slides, dialogs and menus ease in, and theme colours cross-fade.
  All of it is switched off when the system asks for reduced motion.
- A command palette on `Cmd+P` (or `Ctrl+Shift+P`): search workspaces, open tabs
  and commands, Enter to run.
- Keyboard shortcuts: press `Ctrl+B` then `?` for the list.

## What is not

- The Pull requests and Issues tabs show hard-coded sample data.
- Restarting the terminal daemon (a daemon code change, a crash, a reboot) still
  ends the running programs. Agents can be resumed on their conversation, but a
  turn in progress and other programs, such as a dev server, are lost.
- The host has no sign-in. It binds to the loopback address, answers only
  loopback `Host` headers and rejects requests from pages not served from this
  machine, which is enough for a local tool only.
- `corch` is built and smoke-tested on four platforms but not published yet:
  it installs from tarballs built in the repo, and `npm i -g corch` doesn't
  work until a release is out.
- Uses Bun's built-in pseudo-terminal support, so macOS and Linux only.
