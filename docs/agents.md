# Agent status

This is the design for tracking what the coding agent in each terminal is doing: AG-1 to AG-5 in
[REQUIREMENTS.md](REQUIREMENTS.md). Each Claude Code and Codex tab shows whether its agent is working, waiting for
the user or idle (AG-1), the sidebar counts agents per state for each workspace (AG-2), and the user is notified when
an agent finishes, asks a question or needs permission (AG-3). Tracking never edits the user's agent settings, asks
once where the agent wants the user to trust it (AG-4), and can be turned off for one terminal (AG-5).

It is a proposal for the eight jobs listed under [Build order](#build-order). Where it depends on agent behaviour
that has not been checked yet (exact settings keys, payloads, prompts), it says so and lists the point under
[Open questions](#open-questions). Those are checked in the hooks jobs, and this document is corrected then.

It builds on the [terminal daemon](terminal-daemon.md): shells run in the shared daemon (`apps/ptyd-bun`), which
outlives the host, and the host inspects each shell's foreground program to detect agents.

## States

An agent's state is one of three, or none:

| State | Meaning |
| --- | --- |
| `working` | The agent is running a turn: thinking, writing or running a tool. |
| `waiting` | The agent stopped for the user: a question, a permission prompt for a tool, or, about a minute after a finished turn, Claude Code's reminder that it is waiting for input. |
| `idle` | The agent finished its turn, or has not started one, and sits at its own prompt. |
| none (`null`) | No agent is detected in the foreground, tracking is off for the terminal, the terminal is interrupted or its shell is not alive. The UI shows no agent state, only the progress a program reports with OSC 9;4. |

Each state comes from one of two sources. Both always exist; the precedence rule below picks one.

### Baseline: signals the terminal already has

These work for every agent that `packages/terminal/src/agents.ts` recognises, with or without hooks, and are what is
left whenever hooks are missing:

- **`SessionInfo.agent`** (from `detectAgent` in `agents.ts`, run by `SessionManager.inspect`): whether an agent is
  in the foreground at all. When it is null, the state is null.
- **OSC 9;4 `progress`** (`parseProgress` in `packages/terminal/src/core.ts`, kept as `TerminalCore.progress`):
  `busy` means the program reports work in progress. Neither Claude Code nor Codex sent it to a terminal with
  `TERM_PROGRAM=workspace-poc` in the checks recorded below.
- **Attention** (`TerminalCore.attention`, raised by the bell, an OSC 9 notification or an OSC 777 notification, and
  cleared by `ack` when the user looks at the terminal): the agent asked for the user, without saying why.

The baseline derivation, in order:

1. `agent` is null, tracking is off, `interrupted` is set or `alive` is false: no state.
2. `progress` is `busy`: `working`, reason `progress`.
3. `attention` is set: `waiting`, reason `attention`. The baseline can't tell a question from a permission prompt or
   a finished turn, so it uses this one reason for all three. Attention with `from: 'agent'` doesn't count: it is a notification
   the hooks raised (see [Notifications](#notifications-ag-3)).
4. `progress` is `error`: `idle`, reason `error`.
5. Otherwise: `idle`, reason `detected`.

An agent that sends neither progress nor notifications therefore derives `idle` all the time from the baseline, even
mid-turn: the product only knows the agent is there. So the UI shows the `idle` mark only when `source` is `'hooks'`.
A baseline `idle` shows no agent mark: the tab and sidebar row fall back to their progress and other signals, except
`progress` `error`, which still shows failed. `working` and `waiting` show from either source.

### Precise: the agent's own hooks

Claude Code hooks and the Codex `notify` program (see [Attaching hooks](#attaching-hooks-per-session-ag-4)) report
events over the [reporting channel](#local-reporting-channel). Each event carries a state and a fixed reason, so the
hook source sets the state directly:

- `working` with reason `prompt` (the user submitted a prompt) or `tool` (a tool is about to run or just ran).
- `waiting` with reason `permission` or `question`.
- `idle` with reason `started` (a session began) or `finished` (a turn ended).

The daemon keeps the last hook event per session, with the time it arrived. Two events can arrive out of order when
two hooks fire for one moment, so a `working` event with reason `tool` never replaces a `waiting` set less than one
second earlier. A `waiting` always replaces a `working`.

### Which source wins

- **Hooks win** for the current agent run once at least one hook event has arrived for it. A run is one agent process:
  the host sees the foreground program change (another pid, or the shell back at its prompt) and tells the daemon to
  forget the hook state, so a later agent in the same terminal starts from the baseline again.
- **The baseline fills in what hooks can't say.** For Codex, whose `notify` only reports the end of a turn (see
  [Codex](#codex)), `working` and `waiting` come from the baseline and the hook source only sets `idle`/`finished`. The
  combined state is reported with `source: 'hooks'` only when the hook event is the one shown.
- **Interrupt by the user.** Pressing Esc in Claude Code ends a turn without a `Stop` hook. To keep a tab from showing `working` forever: when the hook state is `working`, `progress` was `busy` during the turn and
  goes back to null, and no hook event arrives within 3 seconds, the state becomes `idle` with reason `interrupted`.
  An agent that never sent progress in the turn is not affected by this rule. The host records when `progress` left
  `busy` and passes it to `deriveAgentState`; only a hook event older than that moment counts. A host timer recomputes
  the state after the 3 seconds, because nothing else would then. Claude Code 2.1.316 sent no OSC 9;4 at all to a
  terminal with `TERM_PROGRAM=workspace-poc`, so today this rule does not fire there and an interrupted turn shows
  `working` until the next event. See [the record](#claude-code-check-record).
- **The agent exits.** Process inspection sees the shell back at its prompt, `agent` becomes null, and the state
  becomes null. The host sends `{ type: 'agentExited' }` to the daemon, which drops the hook state. The daemon can't
  see when the next agent starts, so for 1 second after that it ignores events (still answering 204), except reason
  `started`, which always begins a new run. A `SessionEnd` hook (reason `exited`) drops the hook state from the agent's
  side. The host inspects every 2 seconds, so if one agent exits and another starts inside that gap, `agentExited`
  can drop the new agent's `started` event; the tab shows the baseline until its next event.
- **The host restarts.** The daemon keeps receiving events while the host is down and keeps the hook state in memory.
  On reattach the daemon's status carries it, and the host computes the state again from that status plus its own
  fresh inspection. Nothing about agent state is stored on disk by the host.
- **The daemon restarts.** Hook state lives only in daemon memory, so it is lost with the sessions. A terminal that
  had an agent comes back **interrupted** (see [terminal-daemon.md](terminal-daemon.md)) and has no state. A resumed
  agent starts from the baseline and gets a new token.

## Attaching hooks per session (AG-4)

Tracking must not depend on the user's own settings, so nothing is installed into the agent. Instead, terminals the
product starts get a command shim that adds hooks for that one invocation only.

### The shim

- At start-up the daemon writes a product-owned folder in its runtime directory, next to its socket:
  `<runtime>/agent/bin/` holds `claude`, `codex` and `orch-agent-hook`, all small POSIX `sh` scripts,
  `<runtime>/agent/claude-settings.json` holds the generated hook settings, and `<runtime>/agent/zsh/` holds the
  startup wrapper. The folders are `0700`, so they are readable only by the user. Their contents are fixed by
  `packages/terminal/src/agent-shim.ts` (the frame), `agent-shim-base.ts` (what shims share) and each agent's own
  `agent-shim-claude.ts` or `agent-shim-codex.ts`: no token, no path from the user's projects. A failed write means no
  `PATH` change: shells still start and still get a token.
- `shellEnv` (in `core.ts`) puts `<runtime>/agent/bin` first on `PATH` and adds the token variables (see the
  [channel](#local-reporting-channel)), for terminals the product starts only (TERM-7), and only for a shell that got
  a token. `shellEnv` also removes any `PATH` entry that holds `orch-agent-hook`, wherever `ORCH_PTY_RUNTIME` put it,
  and any inherited `ORCH_AGENT_*` variable, so a host started from inside a product terminal never hands its own
  session's shim or token to the shells it starts.
- The `claude` shim execs the real Claude Code with one extra argument,
  `--settings <runtime>/agent/claude-settings.json`, then the user's own arguments unchanged.
- The `codex` shim execs the real Codex with `-c 'notify=["<runtime>/agent/bin/orch-agent-hook","codex",<the user's
  own elements>]'`, three `-c tui.*` flags that ask for a bell on an approval (see [Codex](#codex)), then the user's
  arguments.

Before adding anything, the shim asks the daemon whether to (`GET /v1/session` on the channel, with a 200 ms timeout).
It adds its flags only when the daemon answers that tracking is on for this session and this agent. In every other
case (no token, daemon unreachable, tracking off, trust not given yet, see below) it execs the real binary with the
user's arguments only. It also passes through untouched when:

- `ORCH_AGENT_SHIMMED` is set: this is a nested agent, started by an agent (for example from Claude's Bash tool).
  The shim execs it with the token variables removed (`env -u`), so it can never report as the outer agent.
- `TMUX` or `STY` is set: inside `tmux` or `screen`, a pane's environment comes from whichever terminal started the
  server, so its token may belong to another tab.
- The user's arguments already contain `--settings` or `--settings=...` (Claude) or a `notify` override in any
  spelling (Codex), so the two never conflict.
- For Codex, anything could choose a `notify` the shim can't see or can't keep: `-p`/`--profile`, `-C`/`--cd` or
  `--remote`, a config it can't read or can't take for certain (see [Codex](#codex)), a `.codex/config.toml` from the
  working directory upward that has a `notify` line, or a runtime path holding `"` or `\`.
- `claude-settings.json` is missing, for example cleaned from `/tmp`, because Claude Code exits with an error on a
  missing file. `curl` being missing counts as the daemon being unreachable. A `noexec` `/tmp` never runs the shim at
  all, so the shell goes on to the next `claude` on `PATH`.
- The agent's version doesn't support the flag. The shim checks this once per binary (by its `--help` output) and
  caches the answer in `<runtime>/agent/cache/`, keyed by the binary's path and modification time, so an unsupported
  version is started as is instead of failing on an unknown flag.

For the real agent the shim sets `ORCH_AGENT_SHIMMED=1`. Hooks inherit it along with the token, which is what they
need.

### Finding the real binary

The shim walks `$PATH` in order, skips every entry that resolves (`cd -P`) to its own folder, also one reached twice
or through a symlink, and runs the first executable named `claude` (or `codex`) that is not itself. If none is found
it prints the shell's usual `command not found` message to stderr and exits 127. It uses `exec`, so the agent keeps the shim's pid and process
inspection sees the agent's own program, as today.

### No settings file is ever written

The product never writes to `~/.claude`, `~/.claude.json`, `~/.codex`, a project's `.claude/` or `.codex/` folder, or
any other file the agent reads as settings. Everything it adds lives in the daemon's runtime directory and on the one
command line. Removing the shim folder leaves the user's setup exactly as it was.

### Claude Code hook events

The generated settings add only these hooks, each running `orch-agent-hook claude <state> <reason>` with fixed
arguments and a 2-second hook timeout:

| Hook event | Matcher | State | Reason |
| --- | --- | --- | --- |
| `SessionStart` | `startup\|resume\|clear` | `idle` | `started` |
| `UserPromptSubmit` | any | `working` | `prompt` |
| `PreToolUse` | `AskUserQuestion` | `waiting` | `question` |
| `PreToolUse` | every tool (`*`) | `working` | `tool` |
| `PostToolUse` | every tool (`*`) | `working` | `tool` |
| `Notification` | `permission_prompt` | `waiting` | `permission` |
| `Notification` | `elicitation_dialog` | `waiting` | `question` |
| `Notification` | `idle_prompt` | `waiting` | `question` |
| `Stop` | any | `idle` | `finished` |
| `SessionEnd` | any | `idle` | `exited` (drops the hook state) |

`PostToolUse` is there so a granted permission leaves `waiting` as soon as the tool has run. `SessionStart` leaves out
`compact`, which can happen mid-turn and would set `idle`.

`idle_prompt` is the reminder that Claude Code is waiting for input, about a minute after a finished turn, so an
unattended tab goes from `idle` to `waiting` then. It uses reason `question` because a reason of its own would change
`agentEvent`, `daemonStatus` and `AgentReason`. Notifications exclude it: a `question` entered from `idle` raises
nothing, so a finished turn isn't announced a second time as "has a question". To drop it, remove its row here and in
`CLAUDE_HOOKS`.

No matcher excludes a tool, so both `PreToolUse` hooks fire for `AskUserQuestion`, in either order. The daemon's rule
that `tool` never replaces a fresh `waiting` keeps the right state. Known gaps: `StopFailure` and `PostToolUseFailure`
exist and are not hooked, so a failed API call can leave `working`, and a tool failing after a granted permission can
leave `waiting`, until the next event. An answer within 1 second of `waiting` also keeps `waiting` until the next
event, and so does declining a prompt with Esc, which fires nothing.

Claude Code passes each hook a JSON description on stdin, which can hold the prompt or the tool input. The hook
script never reads it: it redirects stdin from `/dev/null` first. It prints nothing, because some hooks add their
output to the agent's context, and it always exits 0, because some exit codes block the agent.

### Codex

Codex's `notify` runs a program after a turn, with a JSON argument that includes the user's messages and the agent's
last answer. `-c notify=...` replaces the configured value, so a plain flag would stop the user's own `notify`. So:

- **The hook chains.** The `codex` shim reads the user's `notify` array and passes its elements on inside the value.
  `orch-agent-hook codex <user argv...> <json>` reports first, then runs the user's program with its own arguments and
  the JSON last, as Codex would, without `ORCH_AGENT_TOKEN`, `ORCH_AGENT_SOCKET` or `ORCH_AGENT_SHIMMED`. The shim
  stores nothing and the hook reads no file.
- **The arguments are opaque.** The hook never parses, logs or sends them, and always reports `idle` with reason
  `finished`, so the JSON goes only to the program the user already gave it (SEC-3). A channel that never answers
  delays the user's program by about a second, and the hook hides that program's output and exit code.
- **The reader is narrow on purpose.** `sh` has no TOML parser, so in `${CODEX_HOME:-$HOME/.codex}/config.toml` it takes
  one line, `notify = [ ... ]` of plain strings, above the first line starting with `[`. No key spelled `notify` means
  there is no user program. Anything else that mentions it as a key could, including under a table, quoted, on a second
  line, across lines, with a trailing comment, in an inline table, or after a multi-line string, passes through, and so
  does a line that only has the word in its value or comment. Losing tracking is always better than silently losing the
  user's `notify`. A word inside a path, as in `[projects."/work/notify"]`, doesn't count. A project's file comes from
  whatever repository was cloned, and this all runs before the agent starts, so more than 64 KB of config in total, or a line
  over 4 KB, passes through rather than hold `codex` up. The size is counted by reading at most one byte past the limit,
  because a symlink can point at a proc file, which reports size 0 and can run for terabytes. A failed read passes
  through, and so does a link that reads as nothing, since `/proc/self` files can look empty and then fail.
- **Approvals ring the bell.** The shim adds `-c 'tui.notifications=["approval-requested"]'`,
  `-c 'tui.notification_method="bel"'` and `-c 'tui.notification_condition="always"'`, and leaves all three out when the
  config sets any `notifications`, `notification_method` or `notification_condition` key. The list is approvals only
  because a bell after each finished turn would read as `waiting`, and `always` because the default may skip a focused
  terminal. A bell carries no text, and the baseline already turns it into `waiting`/`attention` until the user looks.
  This costs Codex's default finished-turn notification in that terminal; "Codex finished" comes from `notify` instead
  (see [Notifications](#notifications-ag-3)).
- **Any `-c` keeps the session off the shared server.** Interactive Codex connects to a long-lived shared app server,
  where a `notify` would run with the server's environment and no token. With any `-c` flag it runs in-process instead,
  even when the server is up, so `notify` runs in the terminal's own Codex, with the token. No `--no-daemon` is needed,
  but this depends on that behaviour, and a tracked session has no place in `codex agents` and can't be reconnected.
  If a later Codex applies `-c` on the server, tracking stops and the rule is to add `--no-daemon`, guarded by
  `supports_flag`. The token never goes on a command line or in a file to get round it. A run passing `--remote` passes
  through, because its `notify` runs elsewhere.
- Codex gets no hook `working` or `waiting`. Those come from the baseline only, and Codex sends no OSC 9;4, so a turn
  shows no `working` here. A later turn shows `idle`/`finished` until the next signal: `combine` trusts the baseline
  during a turn, and Codex has no turn-start event in `notify`.
- **An early `finished`.** The title Codex generates for a new session is a turn of its own, which fires `notify` too,
  so the first prompt reports `finished` twice and the first of them can come while the real turn is still running.
  The hook can't tell them apart without reading the JSON, which it never does. A bell still wins (`combine` prefers a
  baseline `waiting`). So the first `finished` of an agent run never notifies (see
  [Notifications](#notifications-ag-3)).

**Candidates for later.** Codex's real hook system (`PermissionRequest`, `Stop` and others) would give precise events
and leave `notify` alone, but hooks need review: Codex shows a "Hooks need review" dialog and stores trust in
`hooks.state` in `config.toml`. `--dangerously-bypass-hook-trust` must never be used (AG-4), and whether `-c` can declare
hooks is unknown, so this belongs after step 8, which owns the ask-once question. Codex also sends
`OSC 7501;state=working|idle|done:app=codex` and `state=blocked:app=codex:kind=permission`, which `TerminalCore`
ignores today: a terminal-side source of the states `notify` can't give, needing no shim. It is undocumented, so reading
it would be a job of its own.

### Other agents

OpenCode, Cursor Agent, pi and Command Code get no shim and no hooks. Their baseline signals still apply, so a tab
running one shows `working` from progress and `waiting` from attention when the agent sends them.

#### Adding an agent

Tracking lives in one definition, an `AgentTracker` (`packages/terminal/src/agent-tracker.ts`), so a new agent takes one
file and one field:

1. Add `packages/terminal/src/agent-shim-<kind>.ts`, directly in `src`, since `daemonBuild` reads only the top level.
   It exports the definition: `program` (the name on `PATH`), `shim` (starting with `shimStart(program, kind)`),
   `hookBranch` (the `case` arm of `orch-agent-hook`, which sends only literals, see SEC-3), and `files` or
   `turnEndOnly` when they apply. Import `AgentEvent` from `agent-channel.ts` as a type only: `agents.ts` imports this
   file, and `agent-channel.ts` reads `AGENTS` while it loads.
2. Set `tracking` on the agent's adapter in `agents.ts`.

`writeAgentShim`, `agentEvent`, `agentTracking`, `GET /v1/session`, the daemon's `tracking` request, `agentHook.agent` and
the host's default all derive from that, and a test can pass its own list (`agent-tracking.test.ts` does). `agentTracking`
keeps every key required, so a new daemon refuses a `hello` from a host that predates the agent. A host is normally the
same age or newer, but the job adding the agent has to decide this. Any change here alters `daemonBuild`, so running
daemons need `bun run terminals:stop`, which ends their shells.

## When the shim is missed

The shim only works when the shell finds it first under the plain program name. It is missed when:

- the user runs the agent by an absolute path, a shell alias or function that points elsewhere, or `npx`/`bunx`;
- the user's startup files put another folder before the shim on `PATH`. On macOS `path_helper` in `/etc/zprofile`
  reorders `PATH` for login shells, and many users prepend folders (for example Homebrew's) in their own files, so
  this is likely, not rare;
- the agent runs inside `ssh` (the remote machine has no shim, and `ssh` does not forward the token variables), inside
  `tmux` or `screen` (the shim passes through on purpose), or in a container;
- the agent's version lacks `--settings` or `-c`, or the user's own settings turn hooks off.

The fallback is always the baseline signals. Nothing breaks and nothing is reported as wrong: the tab shows the
baseline state, whose `source` is `'signals'`, and no mark while that state is `idle`. The UI doesn't warn about a missed shim, since many of these cases are
deliberate. The tab's tooltip names the source ("terminal signals" or "agent hooks") whenever it shows a state, so a user who
expects hooks can see they are not active.

The `PATH` order is the one case fixed in the build: the shell itself rewrites it. A login zsh on macOS did not keep a
folder first on `PATH`, and `~/.local/bin`, where Claude Code's own installer puts `claude`, came ahead of it. So for
zsh `shellEnv` sets `ZDOTDIR` to `<runtime>/agent/zsh`, whose four startup files source the user's own unchanged, with
the user's `ZDOTDIR` in place while each runs, and write nothing. After the last one the shim folder goes first again.
At the prompt `ZDOTDIR` is the user's value, or unset, and is never the wrapper; `HISTFILE` is put right if macOS's
`/etc/zshrc` derived it from the wrapper. If a wrapper file is gone, `shellEnv` leaves `ZDOTDIR` out, since zsh would
otherwise skip the user's files. Other shells keep the `PATH` prepend only.

## Trust (AG-4)

Two kinds of trust are involved, and the product keeps them apart.

**The agent's own trust checks.** Claude Code asks whether to trust a folder the first time it runs there, and hooks,
including those from `--settings`, run only once the folder is trusted. It asks for no separate review of those
hooks (see [the record](#claude-code-check-record)). Codex has its own approval and sandbox settings. These prompts appear in the terminal and the user
answers them there. The product never pre-accepts them, never answers them, never types into the terminal on the
user's behalf, and never writes the agent's trust state (for example the trust entries in `~/.claude.json`). If the
user declines, the agent runs without the hooks and the tab falls back to the baseline.

**The product's question.** Before the shim adds anything for an agent kind, the product asks the user once, in the
web UI: "Track Claude Code's status with hooks? This adds hooks to Claude Code sessions started in this app, for
those sessions only. Your settings are not changed." with **Track** and **Not now**. The notice goes on to say that
it applies to agents started after the answer, and that a terminal already open gets it once its shell starts again
or in a new tab (see the gap below). It is a strip above the terminal (`TrustNotice` in `packages/terminal-ui`),
not a modal or an overlay: the terminal gives up rows for it, so the agent's own prompts stay visible and usable. Codex gets the same question
with its own name.

- It shows on every terminal whose `SessionInfo.agent.kind` is `claude` or `codex` while that kind's answer is null,
  and never for other agents, an answered kind or a terminal whose switch is off. It has no separate dismiss: closing it means answering.
- The answer is remembered per machine and per agent kind in the host's data folder, in
  `apps/host/.data/agent-tracking.json` (`0600`, written aside and renamed): `{ "claude": "on" | "off", "codex":
  "on" | "off" }`. A missing entry means not asked yet, which behaves as off; a missing or damaged file reads as all
  unasked. The file holds no tokens. The `agent-tracking` host module owns it.
- The web reads and changes the answers through `routes.agentTracking`: `status` (GET, `{ claude, codex }` with null
  for not asked) and `update` (POST `{ agent, answer }`, strict, so an unknown agent or an extra field gets 400).
  `update` is a POST, not a PUT, because host contracts are GET or POST only and state changes use POST. Remote
  clients may answer too, like `ack`; they only ever see the answers.
- **Not now** stores `off`; the question is not shown again. Both answers can be changed later from the command
  palette ("Track Claude Code with hooks", "Stop tracking Claude Code with hooks", and the same for Codex). There is
  no host settings page for them yet.
- The host passes the answers to the daemon with every terminal (see [Protocol change](#protocol-change)), and sends
  every open terminal a new `tracking` request whenever an answer changes. Until the answer is `on`, the shim adds no
  flags for that agent; the baseline still works.
- The development flag `ORCH_AGENT_HOOKS` that turned hooks on before this prompt existed is gone. Developers get
  hooks by answering Track once.

**Known gap: a running shell gets no token.** The daemon issues a shell its token only when some kind is tracked at
the shell's start, and turning tracking on never gives a running shell one. So the terminal where the user first
answers Track, any shell started while every answer was off or unasked, and any shell started with its switch off get
hooks only after the shell starts again (exit and press Enter) or in a new tab. The notice and the switch's tooltip
say so. Open question: issue a token whenever the switch is on and let `GET /v1/session` gate per kind, which needs a
daemon change and a daemon restart.

## Local reporting channel

### Transport: a Unix socket owned by the daemon

Hook events go to a second Unix socket of the shared daemon, `<runtime>/agent.sock`, next to `host.sock` in the
daemon's runtime directory (`/tmp/orchpty-<uid>-<app>` by default, see `daemon.repository.ts`). It speaks plain HTTP/1.1
(Bun's `serve` with `unix`), so the hook script can use `curl --unix-socket`.

Why this transport:

- **The daemon outlives the host.** It is the only process that is always there while an agent runs, so events sent
  while the host is down are not lost; the host reads the result on reattach.
- **The daemon starts the shells,** so it can create a session's token and put it in that shell's environment without
  the host ever sending it anywhere.
- **A Unix socket is same-machine only by construction (SEC-1).** There is no TCP port, so no browser page, DNS
  rebinding or other machine can reach it. The socket and its folder are created with `umask 077`, so other users
  can't connect.
- **It is outside the host's `routes` registry.** The tunnel and the server's `/m/<id>` relay only ever reach the
  host's own HTTP server, which serves that registry. The channel is a different process on a different socket, so
  it can't be relayed, and it is never added to `routes`. Remote clients see only the derived `agentState` in
  `SessionInfo`, like `attention` today.

A loopback route on the host was rejected: it would not receive events while the host is down, every loopback port
is reachable by browser pages unless guarded, and it would sit in the same server that the tunnel relays.

`agent.sock` is a separate socket from `host.sock` so a shell can never speak the daemon's control protocol: it only
gets the channel's address, and the channel accepts only the two requests below.

### Per-session token

When the daemon spawns a session's shell with tracking on, it creates a random 32-byte token (hex) and adds two
variables to that shell's environment through `shellEnv`:

- `ORCH_AGENT_TOKEN`: the token, for example `ORCH_AGENT_TOKEN=<64 hex characters>`.
- `ORCH_AGENT_SOCKET`: the path of `agent.sock`.

The daemon maps the token to that session only. Every request carries it (`Authorization: Bearer <token>`); an
unknown token gets 401. A token therefore reports only for the session whose shell received it. When the shell
exits (and is restarted with Enter), the session closes, or tracking is turned off, the token is forgotten and a new
shell gets a new one. Tokens are never written to disk, logged, sent to the host or put in `SessionInfo`.

The hook script passes the token to `curl` through a config on stdin (`printf` is a shell builtin), never on the
command line, so other sessions can't read it from the process list.

### Requests

| Request | Use | Answer |
| --- | --- | --- |
| `GET /v1/session` | The shim asks whether to add its flags. | `200 { "claude": boolean, "codex": boolean }` |
| `POST /v1/state` | A hook reports an event. | `204` |

Errors are `400` (bad body, or an `agent` the session doesn't track), `401` (missing or unknown token), `404` (any
other method or path), `413` (body over 256 bytes, with or without `Content-Length`), `429` (rate limited). They are
checked in the order 401, 413, 400, 429, so only valid events are kept as the newest dropped one. None carries a body
beyond `{ "error": "<code>" }`.

### Payload

The body of `POST /v1/state` is validated with a strict Zod schema (unknown keys are rejected):

```ts
const agentEvent = z.strictObject({
  agent: z.enum(['claude', 'codex']),
  state: z.enum(['working', 'waiting', 'idle']),
  reason: z.enum(['started', 'prompt', 'tool', 'permission', 'question', 'finished', 'exited']),
})
```

`agent` must match the tracking the session allows. `reason` is a short fixed enum, and every value the hook script
sends is a literal in the generated settings or the shim. **Prompts, messages, tool names, tool input or output,
file paths, folder names and anything else from the agent's stdin or arguments are never sent (SEC-3).** The script
never reads them, and the schema has no field to carry them. The one thing done with Codex's JSON argument is to
forward it, unread, to the `notify` program the user configured.

### Rate limit

Per session, a token bucket of 20 events with a refill of 10 per second; across all sessions, 200 per second. Over
the limit the channel answers 429 and drops the event, except that the newest dropped event of each session is kept
and applied when the bucket next has room, so a burst can delay the final state by up to a second but never leave it
wrong. A normal turn sends a few events per tool call, well under the limit. The daemon counts dropped events per
session and logs the count once a minute when it is non-zero, without the session's token.

### When the channel is down

`orch-agent-hook` runs `curl` with `--connect-timeout 0.2 --max-time 1`, discards all output and exits 0 whatever
happens, including when `curl` is missing or `ORCH_AGENT_SOCKET` is unset. The 2-second hook timeout in the
generated settings is a second guard. A hook never blocks, slows down noticeably or fails the agent; the only effect
of a down channel is a stale or baseline state.

## Protocol change

### `SessionInfo` (host to web)

In `packages/shared/src/protocol.ts`:

```ts
export type AgentStateName = 'working' | 'waiting' | 'idle'

/** Why the agent is in its state. The first group comes from hooks, the second from terminal signals. */
export type AgentReason =
  | 'started'
  | 'prompt'
  | 'tool'
  | 'permission'
  | 'question'
  | 'finished'
  | 'progress'
  | 'attention'
  | 'error'
  | 'interrupted'
  | 'detected'

export interface AgentState {
  state: AgentStateName
  reason: AgentReason
  /** Whether the agent's own hooks or the terminal's signals decided the state. */
  source: 'hooks' | 'signals'
  /** When the agent entered this state, in epoch milliseconds. */
  since: number
}

export interface SessionInfo {
  // ...existing fields
  /** What the agent in the foreground is doing. Null with no agent, tracking off or the session interrupted. */
  agentState: AgentState | null
  /** The per-session switch (AG-5). False only when the user turned tracking off for this terminal. */
  agentTracking: boolean
  /** `from: 'agent'` marks attention the agent's hooks raised; absent means a terminal signal. */
  attention: { at: number; message: string; from?: 'agent' } | null
}
```

The host copies `attention` from the daemon's status unchanged. An older daemon never sends `from`, so its
attention is always a signal's.

The events socket's client messages (`packages/shared/src/contracts/events.ts`) gain
`{ type: 'agentTracking', sessionId: string, on: boolean }`. This is the user's own control, sent by the UI like
`ack`, so it belongs in the `routes` registry; the reporting channel does not.

### Daemon protocol (host to daemon)

In `packages/terminal/src/daemon-protocol.ts`, `daemonStatus` gains one optional field, and its `attention` an
optional origin:

```ts
  /** The last hook event of the current agent run. Absent from daemons started by an older build. */
  agentHook: z
    .object({
      agent: z.enum(['claude', 'codex']),
      state: z.enum(['working', 'waiting', 'idle']),
      reason: z.enum(['started', 'prompt', 'tool', 'permission', 'question', 'finished']),
      at: z.number(),
    })
    .nullable()
    .optional(),
  /** `from: 'agent'` marks attention the agent's hooks raised; absent means a terminal signal. */
  attention: z.object({ at: z.number(), message: z.string(), from: z.literal('agent').optional() }).nullable(),
```

The daemon's request schema (`apps/ptyd-bun/src/main.ts`) gains:

```ts
// On `hello`: which agents this session may track. Absent means none, so an older host never turns tracking on.
// On an existing session it acts like a `tracking` request, so a restarted host can turn tracking off, and absent
// leaves it unchanged. Turning it on gives a running shell no token.
tracking: z.object({ claude: z.boolean(), codex: z.boolean() }).optional(),

// New requests, bound to the session like the others.
z.object({ type: z.literal('tracking'), claude: z.boolean(), codex: z.boolean() }),
/** The agent run ended (process inspection saw it leave), so its hook state is dropped. */
z.object({ type: z.literal('agentExited') }),
```

`tracking` is the trust answer from `agent-tracking.json` with the per-session switch applied: both false when the
switch is off. The changes are additive, so `DAEMON_PROTOCOL` stays 1: an older daemon strips the unknown `hello`
field and ignores the unknown requests (as it does today), issues no token and reports no `agentHook`, so its
terminals get baseline states only until it is restarted. The changed daemon code also changes `daemonBuild`, so the
host warns about the running daemon as usual.

### Who computes what

- **The daemon** keeps the raw hook state (`agentHook`) per session, applies the ordering rule between hook events,
  and raises attention for notifying transitions (see [Notifications](#notifications-ag-3)), since it owns
  `attention` and receives events while the host is down.
- **The host** computes `agentState` in `apps/host/src/modules/terminals/daemon-session.service.ts` when it builds
  `SessionInfo`, from the daemon's status (`agentHook`, `progress`, `attention`), its own `agent`, `interrupted`,
  `alive` and the switch. The derivation is one pure function, `deriveAgentState`, in a new
  `packages/terminal/src/agent-state.ts`, with tests for the precedence rules. The host keeps the previous result to
  keep `since` stable while the state doesn't change.
- **The web** only renders `agentState`; it derives nothing except the sidebar counts.

Files that must change together:

| Side | Files |
| --- | --- |
| Shared | `packages/shared/src/protocol.ts` (`SessionInfo`, `AgentState`, `attention.from`), `packages/shared/src/contracts/events.ts` (`agentTracking`) |
| Terminal package | `packages/terminal/src/daemon-protocol.ts` (`daemonStatus.agentHook`, `attention.from`), `packages/terminal/src/core.ts` (`shellEnv`, `TerminalCore.notify`), `packages/terminal/src/attention.ts` (the attention merge), new `packages/terminal/src/agent-state.ts`, and `packages/terminal/src/agent-channel.ts` (tokens, requests, rate limit, hook state), which lives here because `daemonBuild` hashes this folder and only `main.ts` of the daemon |
| Daemon | `apps/ptyd-bun/src/main.ts` (request schema, `agent.sock`, the shim folder, `onNotify` to the session's core) |
| Host | `apps/host/src/modules/terminals/daemon-session.service.ts`, `daemon.repository.ts` (the switch in each record), `apps/host/src/modules/events/events.ws.ts` (`agentTracking`) |
| Web | `packages/terminal-ui` (tab state, sidebar counts, trust notice, switch) |

Host and web change in the same job, because `SessionInfo` is shared and every place that builds one must set the
new fields. The daemon side may land first, since a host that never sends `tracking` gets no hook state.

## Turning tracking off for one session (AG-5)

- **Where the switch lives.** In the terminal's record in the host's data folder (`.data/terminal-daemons/`, next to
  `cwd` and `agent`), as `agentTracking: false`; absent means on. It persists across host and daemon restarts (the
  host reads it before `hello`), and it is removed with the terminal. The UI shows it in the terminal tab's context
  menu ("Stop tracking the agent" / "Track the agent again") and in the command palette for the focused terminal
  ("Stop tracking the agent in this terminal" / "Track the agent in this terminal again"), and reflects it from
  `SessionInfo.agentTracking`. The `agentTracking` client message reaches `DaemonSession.setAgentTracking` through
  the events socket; the method is on the host's own session class, not on `TerminalSession`, so the daemon's build
  does not change. The switch applies to both agent kinds.
- **What off disables.** The daemon issues no token to a shell started with tracking off, so its shims add no flags
  and its hooks have nothing to send with. `agentState` is null, so the tab shows nothing, the session leaves the
  sidebar counts, and hook transitions raise no attention. The existing bell and notification attention (NOTE-1 to
  NOTE-3) stays as it is: it is not agent tracking.
- **Turned off while a shell is running.** The host sends `{ type: 'tracking', claude: false, codex: false }`. The
  daemon forgets the session's token at once, so `GET /v1/session` answers 401 and the shim adds no flags to agents
  started later in that shell, and every further event is rejected and dropped. It drops the hook state, and the
  state becomes null at once.
- **An agent already running** keeps the hooks it was started with: the product can't take back a command-line flag
  without restarting the agent, and never does. Those hooks keep firing and are rejected quickly (well under the
  hook timeout), so they cost nothing visible.
- **Turned back on.** The baseline state returns at once. The running shell has no token, so hooks come back only
  after the shell starts again (exit and press Enter, or a new tab). The switch's tooltip says so.

## Per-workspace counts (AG-2)

The sidebar shows, for each workspace, how many agents are in each state, as an icon and a number per state in the
workspace's title row, since a sidebar at its minimum width has no room for words there. The icons are those of the
tab mark, and they don't spin. The words are in the accessible text and the tooltip, for example
"2 agents working, 1 waiting".

- Counted in `packages/terminal-ui` by one pure function over the workspace's layout and the sessions map: every
  terminal surface in every pane of the workspace, including tabs that are not active, counted once each.
- A session counts in the bucket of its `agentState.state`. Sessions are excluded when `agentState` is null: no agent
  in the foreground, tracking off, interrupted, or the shell not alive. A hook `idle` whose program reports an error
  counts as idle, though its row shows failed: there is no failed bucket.
- Zero counts are hidden, and the icons appear in the order waiting, working, idle, since waiting needs the user. The
  accessible text reads working, waiting, idle. The waiting count uses the same accent as attention. A workspace with no counted agents shows nothing new.
- `working` and `waiting` count the same way from both sources, but `idle` counts only from hooks. Terminal signals
  report `idle` even mid-turn, and such a terminal shows no mark, so an agent seen only through signals shows no count
  while idle. "No agents" here means no agents the UI can state.

## Notifications (AG-3)

Notifications reuse the existing attention path: an unseen `attention` gives the pane its ring, the tab its dot and
the workspace its count and message in the sidebar (NOTE-1), it is listed with the others (NOTE-2), and looking at
the terminal clears it with `ack` (NOTE-3). Nothing new is added on the web side.

Notifications follow hook state, so they need hook tracking (the user answered Track for that agent, and the
session's switch is on). Without it nothing new happens: the bell or OSC 9 attention that already
exists is the notification.

`AgentChannel` decides, for each hook event it accepts and applies, whether it is a notifying transition, comparing it
with the session's hook state before it (from the same agent; none counts as no state), and calls `onNotify(id,
message)`. The daemon passes that to the session's `TerminalCore.notify`, which raises attention with `from: 'agent'`.
The daemon raises it rather than the host because it owns `attention`, receives hook events while the host is down,
and so the notification survives a host restart. Messages are fixed strings built from `AGENT_LABELS`, never from
anything in the agent's payload.

For Claude Code:

| Transition | Message |
| --- | --- |
| `working` or `waiting` to `idle` with reason `finished` | "Claude Code finished" |
| anything else to `waiting` with reason `permission` | "Claude Code needs permission" |
| `working` or `waiting`/`permission` to `waiting` with reason `question` | "Claude Code has a question" |

A repeated event with the same state and reason raises nothing, so each transition notifies once.

For Codex (`turnEndOnly`), whose `notify` only ever reports `idle`/`finished`, every report raises "Codex finished",
except the first one of an agent run: after a new token (a shell start), `agentExited`, the hook state being dropped,
or tracking being turned back on. That one is the title turn's early report (see "An early `finished`" under
[Codex](#codex)), which can come while the real turn still runs. The cost: a resumed Codex session, which may have no
title turn, gets no notification for its first finished turn. A rule based on time since the agent started could
avoid that; it is an open question whether it is worth it.

Nothing else notifies:

- not `idle` or `waiting` to `working`, and not `started`, `exited` or `interrupted`;
- not an event the channel drops: inside the exit window after `agentExited`, a late `tool` held off by a fresh
  `waiting`, one refused by the rate limit and never applied, or one for an agent the session doesn't track;
- not `waiting`/`question` entered from `idle` or with no hook state before it. That is Claude Code's `idle_prompt`,
  about a minute after `Stop`, which would repeat "finished" as "has a question";
- no change derived from the baseline alone. On the baseline the attention that a bell or OSC 9 already raises is the
  notification, so there is never a second one for the same signal.

Attention the agent raised is a notification of the hook state, not a signal of its own: the baseline ignores
attention with `from: 'agent'`, so it never turns into `waiting`/`attention` by itself. A Codex `finished` with its
notification unseen still shows `idle`/`finished`.

Clearing is unchanged: the `ack` the UI sends when the pane is focused in a focused window clears agent attention like
any other. A notification raised while the user is looking at the terminal is cleared at once, and one raised while
they look elsewhere stays until they look.

### One attention, not two

Claude Code may also ring the bell or send OSC 9 for the same moment a hook reports. `attention` is one slot per
session, so the rule is about which message it shows and not raising again after the user has seen it:

- When a hook transition raises attention and a bell, OSC 9 or OSC 777 attention arrived less than 2 seconds
  earlier and is still unseen, the hook's message replaces the signal's, `at` keeps the earlier time and the origin
  stays the signal's (no `from`). It is one attention, and a Codex approval bell merged with a `finished` report
  still derives `waiting`, as `combine` prefers.
- A bell, OSC 9 or OSC 777 that arrives less than 2 seconds after a hook transition raised attention is dropped,
  even if the user has already looked at the terminal in between, so it doesn't come back.
- The hook source is preferred because its message says why. Outside the 2-second window both behave as today: the
  newer one replaces the older.

Known risk: a Codex approval bell that arrives within 2 seconds of a "Codex finished" notification is dropped, so that
approval shows no `waiting` until the next signal. It is accepted for now.

This merge lives in `AttentionSlot` (`packages/terminal/src/attention.ts`), which `TerminalCore` keeps as its
`attention`: `raise` (bell, OSC 9, OSC 777) and `notify` (hooks) both go through it.

## Security summary

- The reporting channel is a Unix socket of the daemon, created under `umask 077`: same user, same machine only
  (SEC-1). It has no TCP port, is not in the `routes` registry, and can't be reached through the tunnel or the
  `/m/<id>` relay.
- Each shell gets its own random token, only in its own environment, so a session can report only for itself. Tokens
  are never stored, logged or sent to the host, the web or the server, and never appear on a command line. Other
  programs of the same user can already reach the daemon's sockets, as SEC-1 allows; the token stops one terminal
  from setting another's state, not the user's own programs.
- Events carry only an agent kind, a state and a fixed reason, under a strict schema and a 256-byte limit. Prompts,
  messages, tool names, tool input and output, and paths are never sent (SEC-3). The hook script never reads its
  stdin or arguments; it forwards Codex's argument unread to the user's own `notify`, without the session's variables.
- The product never writes the user's or a project's agent settings (the `codex` shim only reads the one config file
  and the `.codex/config.toml` files above the working directory), never touches the agent's trust state, never
  answers an agent's prompt and never types into the terminal for the user.
- A hook can't block or fail the agent: it prints nothing, exits 0 and gives up within a second.
- The user's `notify` elements move from their config onto Codex's command line for the whole session, so they show in
  `ps` and in the process command a viewer of the machine sees. A secret in one, such as a webhook URL, is exposed for
  longer than the moment Codex runs it. Anyone with the machine key could read the config through a terminal anyway, so
  this gives no new access.
- A project's config is untrusted input: the `codex` shim reads a bounded amount of it, and only to decide whether to
  pass through. Nothing from it reaches the command line.
- Events are rate limited per session and overall, and the shim and hook folder is written by the daemon from fixed
  contents in a private folder.

## Open questions

These are assumptions to check in the hooks jobs. Each answer is written back into this document.

1. **Claude Code `--settings`.** Answered: it accepts a file path and its hooks add to the user's and the project's.
   The version that introduced it was not found, so the shim checks `--help` instead of a version number.
2. **Hook approval.** Answered: no separate review of hooks from `--settings`. They wait for workspace trust.
3. **Matchers.** Answered: `permission_prompt`, `idle_prompt` and the tool name `AskUserQuestion` fired as expected.
   `elicitation_dialog` is in the binary but needs an MCP server to fire, so it was not seen. Excluding one tool
   wasn't tried, because it isn't needed.
4. **Interrupt.** Answered: Esc fires no `Stop`, and Claude Code sends no OSC 9;4 here, so there is nothing to clear.
5. **Codex `notify`.** Answered: `-c notify=[...]` takes a TOML array, and `notify` reported only
   `agent-turn-complete`, for the session's title turn as well. It has no event for approvals or a turn start. Codex
   sends no OSC 9;4. `tui.notifications=["approval-requested"]` with `bel` works and is worth passing.
6. **`PATH` order.** Answered: a default macOS zsh setup does put the real agent first, so the `ZDOTDIR` wrapper is built.
7. **Notification channel.** Answered: nothing. No bell, OSC 9 or OSC 777 reached a terminal with
   `TERM_PROGRAM=workspace-poc` in a whole session, so the 2-second merge is rarely needed for Claude Code.

### Claude Code check record

Claude Code 2.1.316 on macOS, run in a pseudo-terminal through the shim against a recording channel, in throwaway
projects whose `.claude/settings.json` had its own `UserPromptSubmit` hook, an allow rule and a deny rule. The user's
real `~/.claude/settings.json` was not edited: its own `UserPromptSubmit` hook runs a script named by an environment
variable, which pointed at a recorder.

- Every prompt fired the generated hook, the project's hook and the user's hook, so `--settings` adds to both. A run
  recording event names showed the user's `SessionStart`, `UserPromptSubmit`, `Stop` and `SessionEnd` hooks all firing.
- The allow rule ran `echo allowed-marker` without a prompt and the deny rule stopped `touch denied-marker`.
- Events arrived as `idle`/`started` once the folder was trusted, `working`/`prompt`, `working`/`tool` before and after
  a tool, `idle`/`finished` and `idle`/`exited`. No dialog asked about the hooks.
- With `--permission-mode default`, `rm -f` gave `waiting`/`permission`. Without that flag, `touch` and `curl` ran on
  this machine with no prompt and no `waiting`, so a tab shows `waiting` only when Claude Code really asks.
- `AskUserQuestion` gave `working`/`tool` and then `waiting`/`question`, so the order is not fixed.
- `waiting`/`question` from `idle_prompt` came about a minute after `Stop`.
- Esc on a prompt, a question or a running turn fired no hook. The next prompt recovered the state.
- The terminal got only OSC 0 titles and an OSC 7501 query: no bell, OSC 9;4, other OSC 9 or OSC 777.

### Codex check record

Codex CLI 0.166.0 on macOS, default interactive runs in a pseudo-terminal through the shim against a recording channel,
in throwaway projects. A folder Codex hasn't seen shows a "Trust this folder?" dialog that per-run `-c`, `-s` and `-a`
flags don't skip, and its answer is saved in `config.toml`. So the turns ran with a throwaway `CODEX_HOME` that held the
trust entry and a `notify` of `"<dir>/My Notify/record", "turn-ended"`, and with that home's own shared server.

- A finished turn reached the channel as `idle`/`finished` with the token, with the shared server down and up. The
  process that ran `notify` was the TUI, the one carrying the shim's `-c` flags.
- Without the shim the risk was real: a run with no flags used the server, and `notify` ran there with no token. A run
  with one unrelated `-c` stayed in-process, with the token. So the shim needs no `--no-daemon`. This wasn't repeated
  against the server already running under the real `~/.codex`, because that needs a trusted folder there.
- The user's `notify`, with a space in its path, ran once per report with `turn-ended` and the JSON unchanged, and saw
  none of the session's variables.
- `~/.codex/config.toml` had the same sha256 after all runs.
- An approval prompt (a read-only sandbox, asked to `touch` a file) put one BEL on the terminal, and
  `OSC 7501;state=blocked:app=codex:kind=permission`. Replayed through `TerminalCore` that raised attention, and
  `deriveAgentState` gave `waiting`/`attention`, also with a `finished` hook already there. A plain turn rang no bell.
- No OSC 9;4, other OSC 9 or OSC 777 in any run. Each run had `OSC 0` titles, a `10;?`/`11;?` colour query and
  `OSC 7501;state=working|idle|done:app=codex`.
- Every `notify` was `agent-turn-complete`. The first prompt gave two, one for the title turn. During the approval
  prompt the title turn's report arrived while the real turn was blocked.
- A project's `notify` is not honoured: with a trusted project's `.codex/config.toml` naming another program and
  `--no-daemon`, the `CODEX_HOME` one ran and the project's didn't. Whether the project file was loaded at all wasn't
  checked, so the shim's project check stays, as it can only cost tracking.

## Build order

Each step is one job and leaves the product working:

1. **Terminal and protocol state.** `AgentState` and `agentState` on `SessionInfo`, `deriveAgentState` from the
   baseline signals only, computed by the host. Host and web change together; the UI shows nothing yet.
2. **Host reporting channel.** The daemon's `agent.sock`, per-session tokens in `shellEnv`, the strict schema, the
   rate limit, `daemonStatus.agentHook`, `tracking` on `hello` and the `tracking`/`agentExited` requests, and the
   hook precedence in `deriveAgentState`. Hooks were off for everyone until step 8, except with a development flag on
   the host, removed in step 8.
3. **Claude Code hooks.** The shim folder, the `claude` shim, the generated settings, `orch-agent-hook`, the version
   check, and answers to open questions 1 to 4, 6 and 7.
4. **Codex notify.** The `codex` shim and its `notify` mapping, and an answer to open question 5.
5. **Tab state.** The tab shows `working`, `waiting` or, from hooks only, `idle`, with the reason and source in its
   tooltip.
6. **Sidebar counts.** Per-workspace counts per state.
7. **Notifications.** Hook transitions raise attention in the daemon, with the 2-second merge in `AttentionSlot`.
8. **Off switch and trust prompt.** The per-session switch in the record, the `agentTracking` client message, the
   ask-once notice and `agent-tracking.json`. This turns hook tracking on for users who say yes. Done.
