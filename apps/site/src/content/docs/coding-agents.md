---
title: Coding agents
description: Run any command-line agent side by side, and pick up where it left off after a restart.
group: Use
order: 4
---

## Bring your own agent

Orchestrator builds no agent of its own. Any agent that runs in a terminal runs in a pane: Claude Code, Codex, OpenCode, Cursor Agent, Aider, Gemini CLI, or your own script. Put each one in its own pane or workspace, next to the shell and dev server it works with.

Shift+Enter inserts a new line in agents that support it, as in a native terminal.

## Knowing when an agent is done

Today, agents tell you through the terminal bell or an OSC 9 notification: see [Notifications](/docs/notifications). Turn on your agent's bell or notification setting and every finished task rings its pane.

## Resuming after a restart

Agents keep running through browser and host restarts. If the terminal daemon itself restarts, Orchestrator offers to resume the agent's conversation in the same folder:

| Agent | Program | Resumed with |
| --- | --- | --- |
| Claude Code | `claude` | `claude --resume <id>` |
| Codex | `codex` | `codex resume <id>` |
| OpenCode | `opencode` | `opencode --session <id>` |
| Cursor Agent | `cursor-agent` | `cursor-agent --resume <id>` |

## Coming next

- Each tab shows whether its agent is **working, waiting for you, or idle**.
- The sidebar counts agents in each state, per workspace.
- A notification when an agent finishes, asks a question or needs permission.
- All of it without editing your agent's settings. Where an agent asks you to trust the tracking, Orchestrator asks once and never bypasses that check. Tracking can be turned off per session.

Later, events such as a pull request opening or a check failing will be able to start your chosen agent in a new pane, with access limited to its repository.
