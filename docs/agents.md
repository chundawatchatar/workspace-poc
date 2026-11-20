# Agent status

This describes how the product shows what the coding agent in each terminal is doing: AG-1 to AG-5 in
[REQUIREMENTS.md](REQUIREMENTS.md). A tab shows whether its agent is working, waiting for the user or idle (AG-1), the
sidebar counts agents per state for each workspace (AG-2), the user is notified when an agent finishes, fails or
needs them (AG-3), nothing touches the user's agent settings (AG-4), and it can be turned off for one terminal (AG-5).

It builds on the [terminal daemon](terminal-daemon.md): shells run in the shared daemon (`apps/ptyd-bun`), which
outlives the host, and the host inspects each shell's foreground program to detect agents.

## Status comes from the agent

Status comes from one place for every agent: the **Program Status Protocol**, OSC 7501, which the agent writes into its
own terminal output. The product installs nothing, adds no hooks, wraps no program and asks no trust question. It never
guesses a status from the screen, the title, a bell or a progress bar. An agent that doesn't speak the protocol shows
no status.

```
ESC ] 7501 ; state=<state>[:kind=<kind>][:app=<name>][:id=<record>][:progress=<0-100>][:title=…][:msg=…] ST
```

`readProgramStatus` in `packages/terminal/src/program-status.ts` is the one reader, and turns each report into the
standard status of `packages/agents/src/status.ts`: a state and a fixed reason.

| The agent writes | State | Reason |
| --- | --- | --- |
| `state=idle` | `idle` | `ready` |
| `state=working` | `working` | `turn` |
| `state=done` | `idle` | `finished` |
| `state=error` | `idle` | `error` (the tab shows failed) |
| `state=blocked:kind=permission` | `waiting` | `permission` |
| `state=blocked:kind=auth` | `waiting` | `auth` |
| `state=blocked` with `kind=question`, another kind or none | `waiting` | `question` |
| `state=clear` | none | |
| anything else, or a report with an `id` (a child record, such as a sub-agent's) | unchanged | |

Spaces around keys and values are trimmed, so `state = working` reads as `working` and a padded ` id=sub` is still a
child's record. `app`, `progress`, `title` and `msg` are not read: no text from the output is kept or shown. The
lookups are `Map`s, so text such as `state=toString` can't reach an inherited property.

### The support question

Claude Code and pi report only once the terminal says it supports the protocol. At start they write
`ESC ] 7501 ; ? ST`, and the terminal answers with the same body, `PROGRAM_STATUS_REPLY`. They take the answer only
if it arrives before the answer to the device-attributes query they send just after, which is the order a terminal
that parses its output answers in. Codex reports without asking.

`TerminalCore` (`packages/terminal/src/core.ts`), the daemon's copy of each screen, answers the question **always**.
Other queries (cursor position, device attributes, colours) it answers only while no browser view is attached, since
the view's xterm.js answers them then and a reply must not be doubled. No browser terminal knows OSC 7501, so if the
daemon left this one to the view, a tab open in the browser would make Claude Code and pi stay silent for the whole
run: they ask only once.

The answer goes out from the raw output (`statusQueries`, also for a question split across two pieces of output),
before the bytes reach the headless parser or the browser. The headless xterm parses on a later timer, and a busy
daemon can delay it, while a browser view gets the bytes at once; answering at parse time would let the view's
device-attributes answer arrive first.

### Which agents report

| Agent | Speaks OSC 7501 | Asks first |
| --- | --- | --- |
| Codex | yes (0.170.0) | no |
| Claude Code | yes (2.1.328) | yes |
| pi | yes (1.5.2; `PI_PROGRAM_STATUS=1` skips the question) | yes |
| OpenCode, Cursor Agent, Command Code | no | |

The agent folders in `packages/agents/src/<kind>/` hold what really differs per agent: its name, icon, how its process
is recognised and how its conversation is resumed. Nothing about status is per agent, so supporting a new agent's
status needs no code: it only has to speak the protocol.

## States

| State | Meaning |
| --- | --- |
| `working` | The agent is running a turn. |
| `waiting` | The agent can't go on until the user answers: a permission prompt, a question or a sign-in. |
| `idle` | The agent is at rest: ready, finished its turn, or failed (`error`). |
| none (`null`) | No agent in the foreground, the agent reports nothing, its switch is off, the terminal is interrupted or its shell is not alive. |

`SessionInfo.agentState` is `{ state, reason, since }`; `since` moves only when the state name changes. An interrupted
turn needs no rule of its own: the agent reports `idle` itself.

## Who computes what

- **The daemon** reads every byte a session prints, so it sees every report whether or not a view is attached.
  `AgentReports` (`packages/terminal/src/agent-reports.ts`) keeps each session's last report, with when it arrived,
  drops it when the agent or the shell ends (`agentExited` from the host, `state=clear`, or the shell exiting), and
  raises notifications. The daemon status carries it as `agentReport` (`packages/terminal/src/daemon-protocol.ts`).
  A repeated report changes nothing, and a program changing its status in a loop can't flood the views or the user:
  a session's status goes out at once, then at most once per 100 ms with the latest state (`STATUS_INTERVAL_MS`),
  and the same notification is raised at most once per 2 seconds (`NOTIFY_REPEAT_MS`). Every change is still judged,
  so a quick turn still says it finished.
- **The host** builds `SessionInfo.agentState` with `deriveAgentState` (`packages/terminal/src/agent-state.ts`): the
  last report, when an agent is detected in the foreground, the shell is alive, the terminal isn't interrupted and
  its switch is on.
- **The page** shows `agentState`, counts it per workspace and plays the cues. It never reads a title, a bell or a
  progress bar for an agent's state. A terminal with no agent still shows its program's OSC 9;4 progress as a plain
  "Working" or "Failed" mark.

The reports live only in the daemon's memory: they survive a host restart, and a daemon restart loses them with its
sessions.

This is daemon protocol 2 (`DAEMON_PROTOCOL`). A daemon of protocol 1, from the hook-based design, refuses a newer
host's `hello`, and the host reports it as incompatible and names `bun run terminals:stop`, leaving its shells alone
(see [terminal-daemon.md](terminal-daemon.md)).

## The tab and sidebar

A terminal with a detected agent shows its identity icon at the start of its tab or sidebar row and a status mark at
the end. `@orch/agents` supplies each agent's artwork and fallback initials; `AgentIcon` in `packages/ui` draws them,
and each agent's `icon.ts` records the artwork's source and terms.

The status mark is the same for every agent: an orange `busy` spinner for working, a `warn` hand for waiting, a faint
hollow circle for idle, and a circled exclamation mark for failed. The hand shows only while the agent says it can't
go on without the user, and goes as soon as it reports anything else. The mark's slot keeps its width with no state,
so changes move nothing. The sidebar's attention dot sits just before it; with no agent state the slot holds the
running, exited or shell dot.

The sidebar shows, per workspace, how many agents are working, waiting and idle (`agentCounts`), counting every
terminal in every pane once, active tab or not. A failed agent counts as idle. Zero counts are hidden, the icons go
waiting, working, idle, and the words are in the accessible text and tooltip ("2 agents working, 1 waiting").

## Notifications (AG-3)

Notifications reuse the attention path: an unseen `attention` gives the pane its ring, the tab its dot and the
workspace its count in the sidebar (NOTE-1), it is listed with the others (NOTE-2), and looking at the terminal clears
it (NOTE-3). `AgentReports` calls `onNotify` for a change that needs the user, and the daemon raises it on the
session's `TerminalCore.notify`, as attention with `from: 'agent'`:

| Change | Message |
| --- | --- |
| into `waiting` / `permission` | "Needs permission" |
| into `waiting` / `question` | "Has a question" |
| into `waiting` / `auth` | "Needs you to sign in" |
| `working` or `waiting` to `idle` / `finished` | "Finished" |
| `working` or `waiting` to `idle` / `error` | "Failed" |

The messages are fixed words, never text from the report; the tab beside them says which agent it is. A bell, OSC 9
or OSC 777 still raises its own attention, merged with an agent's within 2 seconds (`AttentionSlot` in
`packages/terminal/src/attention.ts`), but never a state.

The page also plays a short chime (`packages/terminal-ui/src/lib/agentSound.ts`): two rising notes when a tab's status
turns `waiting`, and one lower note when a turn ends `finished` or `error`, from `working` or straight from
`waiting`. A session seen for the first time, an
interrupted turn (`ready`), an exited shell and a terminal with its switch off play nothing, and cues closer than
400 ms play once. The tones are made with Web Audio, so there is no audio file. Safari lets them sound only once audio
was unlocked inside a click, tap or key, so the page unlocks it on one whenever it isn't running, and when the user
turns the sound on; a cue while audio isn't running is skipped, never scheduled. They are on by default; the speaker
button in the sidebar header and the palette's "Mute agent sounds" turn them off in this browser (`poc-agent-sound` in
`localStorage`). Every open page plays its own.

## Turning it off for one terminal (AG-5)

The switch lives in the terminal's record in the host's data folder (`.data/terminal-daemons/`), as
`agentTracking: false`; absent means on. It outlives host and daemon restarts. The tab's context menu ("Stop tracking
the agent" / "Track the agent again") and the palette change it, through the events socket's `agentTracking` message
to `DaemonSession.setAgentTracking`.

Off, the host shows no state, the session leaves the counts, and the host tells the daemon (`reporting` in `hello`,
`{ type: 'reporting', on }` after), which keeps the reports but raises no notification. On, the last report shows
again at once.

## Security

- The product reads only what the agent prints in its own terminal. It writes no agent settings, installs no hooks
  and wraps no program (AG-4), and it has no socket for agents to call.
- A report sets one of a fixed set of states and reasons; no text from it is kept, logged or sent (SEC-3).
- Any program in the terminal can print the same bytes. A report counts only while an agent is detected in the
  foreground, and it can only change that terminal's mark and raise its fixed notifications.

## Known limits

- **Agents that don't speak the protocol show no status:** OpenCode, Cursor Agent and Command Code today, and versions
  of Claude Code, Codex or pi from before they spoke it.
- **The protocol is young.** A release that changes it shows no status, or a different reason, until
  `readProgramStatus` follows. Only `kind=permission`, `question` and `auth` are known.
- **Child records are ignored.** A report with an `id`, such as a sub-agent's, doesn't change the terminal's status.
- **Reports are lost when the daemon restarts.** A resumed agent shows no state until it reports again.

## Check record

On 2026-11-20, on macOS, each agent was started in a pseudo-terminal in this repository with no flag or variable from
the product:

- **Codex 0.170.0** wrote `ESC ]7501;state=idle:app=codex` at start, then `working` and `idle` around its startup turn,
  without asking. Its binary also holds `:kind=` and `state=clear`.
- **Claude Code 2.1.328** wrote `ESC ]7501;? ST` once at start and nothing more while unanswered. With the answer sent
  before the device-attributes answer it reported `state=idle:app=claude-code`. Its changelog names the "Program Status
  Protocol (OSC 7501)", including `waiting on you` while its folder trust prompt is open.
- **pi 1.5.2** (`@earendil-works/pi-tui`) asks the same question, and reports `working` during a run and compaction,
  `blocked` while a dialog waits, then `done`, `error` or `idle`. Its source links the protocol's description at
  `https://www.superlogical.com/rex/docs/build/program-status`.

Run inside `TerminalCore`, with no view attached, all three reported `idle`/`ready`, and Codex then `working`/`turn`
and `idle`/`ready`.
