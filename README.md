# workspace-poc

A browser prototype of a cmux-style workspace: a sidebar of workspaces, split
panes, tabs in every pane, and real terminals. It exists to show what the
browser-only design can do. The name is a placeholder.

## Run

```bash
bun install
bun run dev
```

Then open http://127.0.0.1:3210. The host listens on 127.0.0.1:4599.

## Layout

| Path | What it is |
| --- | --- |
| `apps/web` | The UI: TanStack Start, React, Tailwind, xterm.js |
| `apps/host` | The host service: Bun and Hono. Owns the shells and the layout |
| `packages/shared` | The layout model, its reducer, and the wire protocol |

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
  "System" follows the OS. To add a theme, append to `apps/web/src/lib/themes.ts`.
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
- Restarting the host ends the shells; the layout is restored with new ones.
- The host has no sign-in. It binds to the loopback address and rejects
  requests from pages on other origins, which is enough for a local demo only.
- Uses Bun's built-in pseudo-terminal support, so macOS and Linux only.
