---
title: Terminals and sessions
description: Real shells that keep running when you close the tab, reload the page or restart the host.
group: Use
order: 2
---

## Real shells

Every terminal tab is a real shell on the host, started with your own shell and configuration. Full-screen programs such as vim, Claude Code and Codex fill the pane and follow it as it resizes. Tabs are named after what the shell reports, shortened to the current folder.

Shells started by Orchestrator don't inherit settings from the terminal or agent session that launched it.

## Sessions outlive the browser

Terminals run in a shared **terminal daemon** on your machine, not in the browser and not in the host. So:

- **Reloading or closing the tab** changes nothing. Come back and the screen is as you left it.
- **Switching workspace** keeps every shell running in the background.
- **Restarting or updating the host** leaves shells and agents running. The host reattaches when it comes back.

If a shell exits, press `Enter` in its tab to start a new one in the same place.

## When the daemon itself restarts

The daemon can still go away: a crash, a reboot, or `bun run terminals:stop`. The host saves enough to recover:

- plain shells reopen in their last folder;
- agent terminals offer to **resume the agent's conversation**.

A turn in progress, and other programs such as a dev server, are lost. See [Coding agents](/docs/coding-agents#resuming-after-a-restart) for which agents can be resumed.

## One terminal, several windows

With the same terminal open in windows of different sizes, it takes the size of the window you are typing in, or last focused. The other windows don't shrink it.
