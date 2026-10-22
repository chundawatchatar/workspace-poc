# Terminal backends

The host can own a shell in two ways, selected at runtime. Both present the same
`TerminalSession` interface, so the browser and the rest of the host do not know
which one is running.

| Backend | Who owns the shell | Survives host restart | Wire |
| --- | --- | --- | --- |
| `memory` (default) | The host process (Bun PTY) | No | browser WebSocket only |
| `bun` | One shared Bun daemon for every terminal (`apps/ptyd-bun`) | Yes | Unix socket: JSON control + binary output |

`bun` keeps shells and agents alive across a host restart, which is `TERM-8` in
[REQUIREMENTS.md](REQUIREMENTS.md).

## Switching

```bash
bun run terminals:backend bun      # persistent: one shared Bun daemon
bun run terminals:backend memory   # the default, in-process Bun PTY
```

The command writes `apps/host/.data/terminal-backend.json` and reloads a running
dev host. `ORCH_TERMINAL_BACKEND` overrides the file for one launch, so
`bun run dev:bun` selects the daemon without touching the setting. To stop the
daemon and every session it owns, run `bun run terminals:stop`.

A switch cannot migrate a shell that is already running: `memory` shells die with
the host, and a daemon shell is only reattached while the daemon lives. The
daemon keeps each session's credential, so switching back to `bun` reattaches to
its still-running sessions rather than orphaning them.

## How it fits together

```
browser ──ws──> host (apps/host)  ── unix socket ──> daemon (apps/ptyd-bun)
                      │                            │  ── PTY ──> $SHELL -l (term A)
                      │                            └─ ── PTY ──> $SHELL -l (term B)
                      └── packages/terminal: the in-process backend and the shared core
```

- `packages/terminal` holds `TerminalCore` (the PTY, the headless emulator and a
  terminal's metadata), the in-process `Session`/`SessionManager`, process
  inspection, and the daemon wire protocol. Both the host and the daemon import
  it.
- `apps/ptyd-bun/src/main.ts` is one standalone process, started detached by the
  host. It reuses `TerminalCore` and owns a map of sessions, each with its own
  shell, screen and connections, all in one Bun runtime. The host opens one
  connection per terminal to the shared socket; `hello` with an `id` and `token`
  creates the session or reattaches to it.
- `apps/host/src/modules/terminals/daemon.service.ts` is the host adapter: it
  starts the shared daemon once, attaches each terminal, and forwards output to
  browser views. It is the only host code that knows the shell lives elsewhere.

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
crash cannot hurt the others. But a bug or out-of-memory in the shared daemon
ends every terminal at once, and upgrading the daemon restarts them all. For a
local tool that is the same exposure the in-process `memory` backend already
has, and it is worth the memory.

## Differences to be aware of

- **Colour queries.** With no browser attached, a program that asks the terminal
  for its colours gets no answer. While a browser is attached, it answers.
- **Idle cost.** The daemon stays resident (about 44 MB) while the host runs,
  even if every tab is closed, until `terminals:stop`.
- **Packaging.** The daemon runs as TypeScript on the host's Bun; it is not yet
  bundled into a release artifact.

## Verification

```sh
bun run typecheck          # every workspace, including @orch/terminal and @orch/ptyd-bun
bun test                   # unit tests, including the daemon protocol codecs
bun run test:bun-daemon    # end-to-end: handshake, binary output, reconnect, resize, close
bun run terminals:stop     # end any daemon left running
```

The end-to-end check sets a shell variable, disconnects, reconnects, and reads
it back to prove the shell outlived the client — the host-restart case.
