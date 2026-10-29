---
title: Getting started
description: Install Orchestrator, start the host and open your first workspace in about two minutes.
group: Start
order: 1
---

## Requirements

- **macOS or Linux.** Terminals use Bun's built-in pseudo-terminal support. Windows is planned.
- **[Bun](https://bun.sh)**, a recent release. Orchestrator uses its built-in terminal support.
- **A current browser.** Chrome, Edge, Safari or Firefox.

## Install and run

```sh
git clone https://github.com/your-org/orchestrator
cd orchestrator
bun install
bun run dev
```

`bun run dev` starts two things:

| Service | Address | What it does |
| --- | --- | --- |
| Web app | `http://127.0.0.1:3210` | The interface you open in the browser |
| Host | `http://127.0.0.1:4599` | Owns the layout and talks to the terminal daemon |

Both listen on the loopback address only, so nothing on your network can reach them.

## Your first workspace

1. Open **http://127.0.0.1:3210**.
2. Press the **+** beside *Workspaces* in the sidebar (or `Ctrl+B` then `W`) and pick a folder. A workspace is a folder on the machine. The sidebar shows its git branch and how many files have changed.
3. A terminal opens in that folder, in your own shell with your own configuration.
4. Press `Ctrl+B` then `D` to split right, or `Ctrl+B` then `E` to split down. Start an agent in one pane and your dev server in another.

> Tip: press `⌘P` on a Mac, or `Ctrl+Shift+P` elsewhere, for the command palette. It searches workspaces, open tabs and commands.

## Next steps

- [Workspaces and panes](/docs/workspaces-and-panes): splits, tabs and full screen.
- [Coding agents](/docs/coding-agents): running Claude Code, Codex and others side by side.
- [Remote access](/docs/remote-access): reach this machine from any browser.
