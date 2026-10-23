# Terminal daemon

Every terminal's shell runs in one shared Bun daemon (`apps/ptyd-bun`), not in
the host. The daemon outlives the host, so updating or restarting the app
leaves shells and agents running, which is `TERM-8` in
[REQUIREMENTS.md](REQUIREMENTS.md). The host talks to it over a Unix socket:
JSON control messages and binary terminal output.

## Starting and stopping

The host starts the daemon on demand and reattaches to it after a restart. To
stop the daemon and every session it owns, stop `bun run dev` first, then run
`bun run terminals:stop`. It refuses while a host is listening, because that host
would start the daemon again for its open tabs. Each terminal's record is kept,
so the next host reopens shells in their folders and offers to resume agents
(see below); it ends the records of terminals no longer in its layout.

## How it fits together

```
browser ──ws──> host (apps/host)  ── unix socket ──> daemon (apps/ptyd-bun)
                      │                            │  ── PTY ──> $SHELL -l (term A)
                      │                            └─ ── PTY ──> $SHELL -l (term B)
                      └── packages/terminal: the shared core, process inspection, agents
```

- `packages/terminal` holds `TerminalCore` (the PTY, the headless emulator and a
  terminal's metadata), the host's `SessionManager`, process inspection, agent
  detection and the daemon wire protocol. Both the host and the daemon import
  it.
- `apps/ptyd-bun/src/main.ts` is one standalone process, started detached by the
  host. It reuses `TerminalCore` and owns a map of sessions, each with its own
  shell, screen and connections, all in one Bun runtime. The host opens one
  connection per terminal to the shared socket; `hello` with an `id` and `token`
  creates the session or reattaches to it.
- `apps/host/src/modules/terminals/daemon.service.ts` is the host adapter: it
  starts the shared daemon once, attaches each terminal, and forwards output to
  browser views. It is the only host code that knows the shell lives elsewhere.

## Restoring after the daemon restarts

The daemon keeps shells alive across host restarts, but it can still go away: a
change to its code (it never reloads), a crash, `terminals:stop` or a reboot.
So that this does not silently lose work, the host keeps more than the
credential in each terminal's record under `.data/terminal-daemons/`:

- `cwd`: the idle shell's working directory, saved whenever it changes.
- `agent`: the coding agent in the foreground and its own conversation id,
  saved as soon as they are identified and cleared when the shell is back at
  its prompt.

Agents are recognised by program name in `packages/terminal/src/agents.ts`,
which also knows where each one keeps its conversations:

| Agent | Program | Conversation id from | Resume |
| --- | --- | --- | --- |
| Claude Code | `claude` | `~/.claude/sessions/<pid>.json` (an id counts once `~/.claude/projects/<cwd>/<id>.jsonl` exists), else `--resume` | `claude --resume <id>` |
| Codex | `codex` | the newest rollout for this cwd written since it started, under the last 30 days of `~/.codex/sessions/`, else `resume <id>` | `codex resume <id>` |
| OpenCode | `opencode` | `--session` only (its store is SQLite) | `opencode --session <id>` / `--continue` |
| Cursor Agent | `cursor-agent` | `--resume` only (its store is undocumented) | `cursor-agent --resume <id>` / `resume` |
| pi | `pi` | `~/.pi/agent/sessions/--<cwd>--/`, else `--session` | `pi --session <id>` |
| Command Code | `cmd` | `~/.commandcode/projects/*/`, else `--session`/`--resume` | `cmd --session <id>` |

Agents only write a conversation with its first message, so an id is saved
only once its conversation is on disk: resuming one that was just opened would
fail. Without an id, Claude Code, Codex, pi and Command Code had not started a
conversation, so they start fresh; OpenCode and Cursor Agent, whose ids can't
be found, continue their latest conversation in that folder. Codex, pi and Command
Code find a conversation by folder, so when two of the same agent run in one
folder neither takes an id that way. The agent's files come before its
command line, which only names the conversation it began in, not one it
switched to with `/resume`, `/new` or `/clear`. An agent run by `node`, `bun` or
`deno` is recognised by its script. Ids are only typed into a shell if they
are plain word characters.

When the host reattaches a terminal whose record holds an agent, it sends
`hello` with `create: false`. If the daemon no longer has the session it
answers `closed`, and the terminal is shown as **interrupted** instead of
getting a fresh shell. The web app offers **Resume agent**, which starts a shell
in the agent's folder and types its resume command, or **Open shell** (also
Enter). Terminals without an agent are created again as usual, in their saved
`cwd`. The same happens when the daemon dies while the host is running.

## Why output is binary

Control messages are length-prefixed JSON, but terminal output travels as raw
binary frames rather than base64 inside JSON, matching the browser connection.
A flood (`yes`, a build log) therefore pays neither base64 nor JSON on the
daemon-to-host hop.

The extra hop does not change latency: a local Unix socket round trip is a few
tens of microseconds, far below the browser WebSocket and the render frame. The
daemon exists for persistence, not speed.

## Why one daemon and not one each

A Bun process costs ~30 MB of runtime no matter how little it does. One daemon
per terminal pays that fixed cost per terminal; one shared daemon pays it once.
Measured with 11 terminals:

| | 11 daemons | 1 shared daemon |
| --- | --- | --- |
| Daemon resident memory | 382.7 MB | 43.7 MB |
| Shells | 21.1 MB | 20.8 MB |

The tradeoff is isolation. Each shell is still its own OS process, so a shell
crash cannot hurt the others. A failing request costs only its connection (the
host reconnects), and an uncaught error is logged rather than ending the
process. But out-of-memory or a crash in Bun itself ends every terminal at once,
and upgrading the daemon restarts them all (see below for how agents are then
resumed). For a local tool that is worth the memory.

## Reattaching and queries

- **Terminal queries are answered once.** Programs ask the terminal for its
  device attributes, cursor position or colours, and read the reply as input.
  Exactly one browser view answers: the one in control of the size (or any view,
  if that one is gone). The host tells each view with a `queries` message. While
  no view is attached, the session answers itself from its headless emulator,
  and colour queries from the last theme a view sent.
- **Full-screen programs repaint on attach.** When a view attaches to a program
  on the alternate screen (Codex, pi, vim), the PTY shrinks by one row for 30 ms
  and back, so the program gets SIGWINCH and redraws. A snapshot restores the
  screen and the input modes, but the program's own redraw is always right. The
  normal screen is left alone, because a resize there would reflow history.
- **Input modes survive a snapshot.** The serializer drops the mouse encoding
  (`?1006`, `?1016`), alternate scroll (`?1007`) and the cursor shape, so the
  core tracks and re-applies them. A test checks every mode a full-screen program
  sets against a terminal restored from the snapshot.
- **A daemon running old code is reported.** The daemon never reloads, so a fix
  to it reaches its terminals only after a restart. Its status carries a hash of
  its code, and the host logs a warning when that differs from the code on disk.
  Newer hosts only send requests an older daemon understands, and the daemon
  ignores request types it does not know.

## Differences to be aware of

- **Colour queries before any view.** The session can answer colour queries
  only after a view has sent its theme; a daemon started with no view attached
  leaves them unanswered until then.
- **Restarting the daemon still ends programs.** Agents can be resumed, but a
  turn in progress is cut off, and other programs and their scrollback are lost.
- **Idle cost.** The daemon stays resident (about 44 MB) while the host runs,
  even if every tab is closed, until `terminals:stop`.
- **Packaging.** The daemon runs as TypeScript on the host's Bun; it is not yet
  bundled into a release artifact.

## Verification

```sh
bun run typecheck          # every workspace, including @orch/terminal and @orch/ptyd-bun
bun test                   # unit tests, including the daemon protocol codecs
bun run test:bun-daemon    # end-to-end: handshake, binary output, reconnect, queries, redraw, resize, close
bun run terminals:stop     # end any daemon left running
```

The end-to-end check sets a shell variable, disconnects, reconnects, and reads
it back to prove the shell outlived the client — the host-restart case.
