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

Then open http://127.0.0.1:3210. The host listens on 127.0.0.1:4599.

Terminals run in one shared daemon, so updating or restarting the
host leaves shells and agents running. If the daemon itself restarts, plain
shells reopen in their last folder and agent terminals offer to resume the
agent's conversation. See [terminal daemon](docs/terminal-daemon.md) for how it
works.

To reach this machine through the cloud server (`apps/server`), start the host
with `SERVER_URL` set: `wss://<server>`, or `ws://127.0.0.1:4600` (any loopback
host) for a local server. The host then keeps one tunnel open to it, identified
by a random secret it creates in `apps/host/.data/machine-secret`. Keep that
file: the machine id is derived from it, and deleting it gives the machine a new
id. Terminals and layout sync work through the tunnel as well as the HTTP API.

Every tunneled request and socket needs an access key. On its first start with
`SERVER_URL`, the host creates one and prints a connect link,
`<client>/#machine=<id>&key=<key>`, once: only the key's hash is kept, in
`apps/host/.data/access-keys.json`. Open the link to reach the machine from the
global app. The client URL is `CLIENT_URL` if set, otherwise `SERVER_URL` with
`ws`/`wss` swapped for `http`/`https`. Lost the link, or want to cut everyone
off? Run `bun run host:rotate-key`: it prints a new link and closes every remote
session that used the old key.

## Layout

| Path | What it is |
| --- | --- |
| `apps/web` | The local app shell: TanStack Start and the router, rendering `packages/terminal-ui` against the local host |
| `apps/client` | The global app: a static Vite SPA that lists the machines linked in this browser and opens one through the cloud server. Run it with `bun run dev:client` |
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
- The layout is stored by the host (`apps/host/.data/state.json`) and pushed
  to every open window, so two browser windows stay in step.
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
- The host has no sign-in. It binds to the loopback address and rejects
  requests from pages on other origins, which is enough for a local demo only.
- Uses Bun's built-in pseudo-terminal support, so macOS and Linux only.
