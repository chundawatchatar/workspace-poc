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

An agent that reports its status tells you itself: see [Agent status](#agent-status) below. For an agent that doesn't, the terminal bell or an OSC 9 notification is the signal: see [Notifications](/docs/notifications). Turn on its bell or notification setting and every finished task rings its pane.

## Resuming after a restart

Agents keep running through browser and host restarts. If the terminal daemon itself restarts, Orchestrator offers to resume the agent's conversation in the same folder:

| Agent | Program | Resumed with |
| --- | --- | --- |
| Claude Code | `claude` | `claude --resume <id>` |
| Codex | `codex` | `codex resume <id>` |
| OpenCode | `opencode` | `opencode --session <id>` |
| Cursor Agent | `cursor-agent` | `cursor-agent --resume <id>` |

## Agent status

- Each tab shows whether its agent is **working, waiting for you, or idle**, and the sidebar counts agents in each state, per workspace.
- You are notified when an agent finishes, fails, asks a question, or needs permission or a sign-in.
- Status comes only from the **Program Status Protocol** (OSC 7501), which the agent writes into its own terminal. Codex, Claude Code and pi speak it. Orchestrator edits no agent settings, adds no hooks or wrappers and asks no trust question.
- Tracking can be turned off for one terminal from the tab's menu or the command palette.

Limits:

- An agent that doesn't speak the protocol (OpenCode, Cursor Agent, Command Code, or an older version of the others) shows no status. For it, the bell and OSC 9 remain the only notification.
- Reports from sub-agents are ignored.
- A daemon restart loses the last status until the agent reports again.

Later, events such as a pull request opening or a check failing will be able to start your chosen agent in a new pane, with access limited to its repository.
