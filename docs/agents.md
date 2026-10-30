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
| `waiting` | The agent stopped for the user mid-turn: a question, or a permission prompt for a tool. |
| `idle` | The agent finished its turn, or has not started one, and sits at its own prompt. |
| none (`null`) | No agent is detected in the foreground, tracking is off for the terminal, the terminal is interrupted or its shell is not alive. The UI shows nothing. |

Each state comes from one of two sources. Both always exist; the precedence rule below picks one.

### Baseline: signals the terminal already has

These work for every agent that `packages/terminal/src/agents.ts` recognises, with or without hooks, and are what is
left whenever hooks are missing:

- **`SessionInfo.agent`** (from `detectAgent` in `agents.ts`, run by `SessionManager.inspect`): whether an agent is
  in the foreground at all. When it is null, the state is null.
- **OSC 9;4 `progress`** (`parseProgress` in `packages/terminal/src/core.ts`, kept as `TerminalCore.progress`):
  `busy` means the program reports work in progress. Claude Code is known to send it; whether Codex does is an open
  question.
- **Attention** (`TerminalCore.attention`, raised by the bell, an OSC 9 notification or an OSC 777 notification, and
  cleared by `ack` when the user looks at the terminal): the agent asked for the user, without saying why.

The baseline derivation, in order:

1. `agent` is null, tracking is off, `interrupted` is set or `alive` is false: no state.
2. `progress` is `busy`: `working`, reason `progress`.
3. `attention` is set: `waiting`, reason `attention`. The baseline can't tell a question from a permission prompt or
   a finished turn, so it uses this one reason for all three.
4. `progress` is `error`: `idle`, reason `error`.
5. Otherwise: `idle`, reason `detected`.

An agent that sends neither progress nor notifications therefore shows `idle` all the time from the baseline. That
is honest: the product only knows the agent is there.

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
- **Interrupt by the user.** Pressing Esc in Claude Code may end a turn without a `Stop` hook (open question). To keep
  a tab from showing `working` forever: when the hook state is `working`, `progress` was `busy` during the turn and
  goes back to null, and no hook event arrives within 3 seconds, the state becomes `idle` with reason `interrupted`.
  An agent that never sent progress in the turn is not affected by this rule.
- **The agent exits.** Process inspection sees the shell back at its prompt, `agent` becomes null, and the state
  becomes null. The host sends `{ type: 'agentExited' }` to the daemon, which drops the hook state; a late hook event
  after that has no agent run to apply to and is ignored. A `SessionEnd` hook (reason `exited`) does the same from
  the agent's side.
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
  `<runtime>/agent/bin/` holds `claude`, `codex` and `orch-agent-hook`, all small POSIX `sh` scripts, and
  `<runtime>/agent/claude-settings.json` holds the generated hook settings. The daemon's `umask` is already `077`, so
  they are readable only by the user. Their contents are fixed by the daemon's code: no token, no path from the user's
  projects.
- `shellEnv` (in `core.ts`) puts `<runtime>/agent/bin` first on `PATH` and adds the token variables (see the
  [channel](#local-reporting-channel)), for terminals the product starts only (TERM-7). `shellEnv` also removes any
  `PATH` entry that is a product shim folder and any inherited `ORCH_AGENT_*` variable, so a host started from inside
  a product terminal never hands its own session's shim or token to the shells it starts.
- The `claude` shim execs the real Claude Code with one extra argument,
  `--settings <runtime>/agent/claude-settings.json`, then the user's own arguments unchanged.
- The `codex` shim execs the real Codex with `-c 'notify=["<runtime>/agent/bin/orch-agent-hook","codex"]'`, then the
  user's arguments.

Before adding anything, the shim asks the daemon whether to (`GET /v1/session` on the channel, with a 200 ms timeout).
It adds its flags only when the daemon answers that tracking is on for this session and this agent. In every other
case (no token, daemon unreachable, tracking off, trust not given yet, see below) it execs the real binary with the
user's arguments only. It also passes through untouched when:

- `ORCH_AGENT_SHIMMED` is set: this is a nested agent, started by an agent (for example from Claude's Bash tool).
  The shim execs it with the token variables removed (`env -u`), so it can never report as the outer agent.
- `TMUX` or `STY` is set: inside `tmux` or `screen`, a pane's environment comes from whichever terminal started the
  server, so its token may belong to another tab.
- The user's arguments already contain `--settings` (Claude) or a `notify` override (Codex), so the two never conflict.
- The agent's version doesn't support the flag. The shim checks this once per binary (by its `--help` output) and
  caches the answer in `<runtime>/agent/cache/`, keyed by the binary's path and modification time, so an unsupported
  version is started as is instead of failing on an unknown flag.

For the real agent the shim sets `ORCH_AGENT_SHIMMED=1`. Hooks inherit it along with the token, which is what they
need.

### Finding the real binary

The shim walks `$PATH` in order, skips every entry that resolves (`cd -P`) to its own folder, and runs the first
executable named `claude` (or `codex`) that is not itself. If none is found it prints the shell's usual
`command not found` message to stderr and exits 127. It uses `exec`, so the agent keeps the shim's pid and process
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
| `SessionStart` | any | `idle` | `started` |
| `UserPromptSubmit` | any | `working` | `prompt` |
| `PreToolUse` | `AskUserQuestion` | `waiting` | `question` |
| `PreToolUse` | every other tool | `working` | `tool` |
| `PostToolUse` | any | `working` | `tool` |
| `Notification` | `permission_prompt` | `waiting` | `permission` |
| `Notification` | `elicitation_dialog` | `waiting` | `question` |
| `Stop` | any | `idle` | `finished` |
| `SessionEnd` | any | `idle` | `exited` (drops the hook state) |

`PostToolUse` is there so a granted permission leaves `waiting` as soon as the tool has run. A `Notification` with
another type (for example the reminder that Claude is waiting for input) is not hooked: `Stop` already set `idle`.
The matcher names and whether a matcher can exclude one tool are assumptions (see [Open questions](#open-questions));
if exclusion is not supported, both `PreToolUse` hooks fire for `AskUserQuestion` and the daemon's rule that `tool`
never replaces a fresh `waiting` keeps the right state.

Claude Code passes each hook a JSON description on stdin, which can hold the prompt or the tool input. The hook
script never reads it: it redirects stdin from `/dev/null` first. It prints nothing, because some hooks add their
output to the agent's context, and it always exits 0, because some exit codes block the agent.

### Codex

Codex's `notify` runs a program after an event, with a JSON argument. As far as is known it reports only the end of a
turn (`agent-turn-complete`), and that JSON includes the user's messages and the agent's last answer. So:

- `orch-agent-hook codex` ignores its JSON argument entirely and always reports `idle` with reason `finished`. It
  doesn't parse the argument to find its type; if Codex later sends other types, the hooks job revisits this.
- Codex gets no hook `working` or `waiting`. Those come from the baseline only: `progress` if Codex sends OSC 9;4,
  and attention if it sends a bell or OSC 9 notification for an approval. Without either, a Codex tab shows `idle`
  until the turn ends, then `idle` with reason `finished` and a "finished" notification.
- Codex may be able to send terminal notifications for approvals itself (a TUI notification setting passed with
  `-c`). Whether that exists in the supported versions, and whether to pass it, is an open question.

### Other agents

OpenCode, Cursor Agent, pi and Command Code get no shim and no hooks. Their baseline signals still apply, so a tab
running one shows `working` from progress and `waiting` from attention when the agent sends them.

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
baseline state, whose `source` is `'signals'`. The UI doesn't warn about a missed shim, since many of these cases are
deliberate. The tab's tooltip names the source ("from terminal signals" or "from Claude Code hooks"), so a user who
expects hooks can see they are not active.

The `PATH` order is the one case worth fixing in the build: the shell itself rewrites it. The Claude Code hooks job
checks how often the shim is missed in a default macOS zsh setup. If it is, that job adds a zsh `ZDOTDIR` wrapper in
the runtime folder that sources the user's own startup files unchanged and then puts the shim folder first again.
That is how terminals usually add shell integration without editing user files. Other shells keep the `PATH`
prepend only.

## Trust (AG-4)

Two kinds of trust are involved, and the product keeps them apart.

**The agent's own trust checks.** Claude Code asks whether to trust a folder the first time it runs there, and may
ask the user to review hooks that come from a settings source (whether it does for `--settings` is an open
question). Codex has its own approval and sandbox settings. These prompts appear in the terminal and the user
answers them there. The product never pre-accepts them, never answers them, never types into the terminal on the
user's behalf, and never writes the agent's trust state (for example the trust entries in `~/.claude.json`). If the
user declines, the agent runs without the hooks and the tab falls back to the baseline.

**The product's question.** Before the shim adds anything for an agent kind, the product asks the user once, in the
web UI: "Track Claude Code's status with hooks? This adds hooks to Claude Code sessions started in this app, for
those sessions only. Your settings are not changed. Claude Code may ask you to approve them." with **Track** and
**Not now**. It is shown the first time that agent is detected in a terminal, as a dismissible notice on the tab, not
a modal. Codex gets the same question with its own wording.

- The answer is remembered per machine and per agent kind in the host's data folder, in
  `apps/host/.data/agent-tracking.json`: `{ "claude": "on" | "off", "codex": "on" | "off" }`. A missing entry means
  not asked yet, which behaves as off. The file holds no tokens.
- **Not now** stores `off`; the question is not shown again. Both answers can be changed later in the host's
  settings (and the command palette).
- The host passes the answer to the daemon with every terminal (see [Protocol change](#protocol-change)). Until the
  answer is `on`, the shim adds no flags for that agent; the baseline still works.

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

Errors are `400` (bad body), `401` (unknown token), `413` (body over 256 bytes), `429` (rate limited). None carries a
body beyond `{ "error": "<code>" }`.

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
never reads them, and the schema has no field to carry them.

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
}
```

The events socket's client messages (`packages/shared/src/contracts/events.ts`) gain
`{ type: 'agentTracking', sessionId: string, on: boolean }`. This is the user's own control, sent by the UI like
`ack`, so it belongs in the `routes` registry; the reporting channel does not.

### Daemon protocol (host to daemon)

In `packages/terminal/src/daemon-protocol.ts`, `daemonStatus` gains one optional field:

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
```

The daemon's request schema (`apps/ptyd-bun/src/main.ts`) gains:

```ts
// On `hello`: which agents this session may track. Absent means none, so an older host never turns tracking on.
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
| Shared | `packages/shared/src/protocol.ts` (`SessionInfo`, `AgentState`), `packages/shared/src/contracts/events.ts` (`agentTracking`) |
| Terminal package | `packages/terminal/src/daemon-protocol.ts` (`daemonStatus.agentHook`), `packages/terminal/src/core.ts` (`shellEnv`, hook state, attention merge), new `packages/terminal/src/agent-state.ts` and the channel |
| Daemon | `apps/ptyd-bun/src/main.ts` (request schema, `agent.sock`, the shim folder) |
| Host | `apps/host/src/modules/terminals/daemon-session.service.ts`, `daemon.repository.ts` (the switch in each record), `apps/host/src/modules/events/events.ws.ts` (`agentTracking`) |
| Web | `packages/terminal-ui` (tab state, sidebar counts, trust notice, switch) |

Host and web change in the same job, because `SessionInfo` is shared and every place that builds one must set the
new fields. The daemon side may land first, since a host that never sends `tracking` gets no hook state.

## Turning tracking off for one session (AG-5)

- **Where the switch lives.** In the terminal's record in the host's data folder (`.data/terminal-daemons/`, next to
  `cwd` and `agent`), as `agentTracking: false`; absent means on. It persists across host and daemon restarts, and
  it is removed with the terminal. The UI shows it in the tab's context menu and the command palette ("Stop tracking
  the agent in this terminal"), and reflects it from `SessionInfo.agentTracking`.
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

The sidebar shows, for each workspace, how many agents are in each state, for example "2 working · 1 waiting".

- Counted in `packages/terminal-ui` by one pure function over the workspace's layout and the sessions map: every
  terminal surface in every page and pane of the workspace, including tabs that are not active, counted once each.
- A session counts in the bucket of its `agentState.state`. Sessions are excluded when `agentState` is null: no agent
  in the foreground, tracking off, interrupted, or the shell not alive.
- Zero counts are hidden, and the counts appear in the order waiting, working, idle, since waiting needs the user.
  The waiting count uses the same accent as attention. A workspace with no counted agents shows nothing new.
- Both sources count the same way; the source only shows in the tab's tooltip.

## Notifications (AG-3)

Notifications reuse the existing attention path: an unseen `attention` gives the pane its ring, the tab its dot and
the workspace its count and message in the sidebar (NOTE-1), it is listed with the others (NOTE-2), and looking at
the terminal clears it with `ack` (NOTE-3). Nothing new is added on the web side.

Hook transitions that notify, each raised once by the daemon with a fixed message:

| Transition | Message |
| --- | --- |
| `working` to `idle` with reason `finished` | "Claude Code finished" / "Codex finished" |
| any to `waiting` with reason `permission` | "Claude Code needs permission" |
| any to `waiting` with reason `question` | "Claude Code has a question" |

Nothing else notifies: not `idle` to `working`, not `waiting` to `working`, not `started`, `exited` or
`interrupted`, and no baseline-only change. On the baseline the attention that a bell or OSC 9 already raises is the
notification, so there is never a second one for the same signal.

### One attention, not two

Claude Code may also ring the bell or send OSC 9 for the same moment a hook reports. `attention` is one slot per
session, so the rule is about which message it shows and not raising again after the user has seen it:

- When a hook transition raises attention and a bell, OSC 9 or OSC 777 attention arrived less than 2 seconds
  earlier and is still unseen, the hook's message replaces the signal's and `at` keeps the earlier time. It is one
  attention.
- A bell, OSC 9 or OSC 777 that arrives less than 2 seconds after a hook transition raised attention is dropped,
  even if the user has already looked at the terminal in between, so it doesn't come back.
- The hook source is preferred because its message says why. Outside the 2-second window both behave as today.

This merge lives in `TerminalCore.raise` in `core.ts`, which is where the bell, OSC 9 and OSC 777 already arrive.

## Security summary

- The reporting channel is a Unix socket of the daemon, created under `umask 077`: same user, same machine only
  (SEC-1). It has no TCP port, is not in the `routes` registry, and can't be reached through the tunnel or the
  `/m/<id>` relay.
- Each shell gets its own random token, only in its own environment, so a session can report only for itself. Tokens
  are never stored, logged or sent to the host, the web or the server, and never appear on a command line. Other
  programs of the same user can already reach the daemon's sockets, as SEC-1 allows; the token stops one terminal
  from setting another's state, not the user's own programs.
- Events carry only an agent kind, a state and a fixed reason, under a strict schema and a 256-byte limit. Prompts,
  messages, tool names, tool input and output, and paths are never sent (SEC-3); the hook script never reads its
  stdin or arguments.
- The product never writes the user's or a project's agent settings, never touches the agent's trust state, never
  answers an agent's prompt and never types into the terminal for the user.
- A hook can't block or fail the agent: it prints nothing, exits 0 and gives up within a second.
- Events are rate limited per session and overall, and the shim and hook folder is written by the daemon from fixed
  contents in a private folder.

## Open questions

These are assumptions to check in the hooks jobs. Each answer is written back into this document.

1. **Claude Code `--settings`.** That it accepts a file path, adds its hooks to the user's own hooks instead of
   replacing them, and is supported by the versions users have. Which version introduced it, for the shim's check.
2. **Hook approval.** Whether Claude Code asks the user to review or approve hooks that come from `--settings`, and
   whether workspace trust gates them. If it asks, the trust notice's wording mentions it.
3. **Matchers.** The `Notification` matcher values (`permission_prompt`, `elicitation_dialog`), whether a
   `PreToolUse` matcher can exclude one tool, and whether `AskUserQuestion` is the tool name for questions.
4. **Interrupt.** Whether Esc fires `Stop`, and whether Claude Code clears its OSC 9;4 progress when interrupted, which
   the `interrupted` rule relies on.
5. **Codex `notify`.** That `-c notify=[...]` takes a TOML array, that it only reports `agent-turn-complete`, and
   whether Codex has (or gains) events for approvals or a turn start. Whether Codex sends OSC 9;4 progress, and
   whether a per-invocation TUI notification setting for approvals exists and is worth passing.
6. **`PATH` order.** How often a default macOS zsh setup puts the real agent before the shim, which decides whether
   the `ZDOTDIR` wrapper is built.
7. **Notification channel.** What Claude Code sends to a terminal whose `TERM_PROGRAM` is `workspace-poc` (bell, OSC 9
   or nothing), which decides how often the 2-second merge matters.

## Build order

Each step is one job and leaves the product working:

1. **Terminal and protocol state.** `AgentState` and `agentState` on `SessionInfo`, `deriveAgentState` from the
   baseline signals only, computed by the host. Host and web change together; the UI shows nothing yet.
2. **Host reporting channel.** The daemon's `agent.sock`, per-session tokens in `shellEnv`, the strict schema, the
   rate limit, `daemonStatus.agentHook`, `tracking` on `hello` and the `tracking`/`agentExited` requests, and the
   hook precedence in `deriveAgentState`. Hooks are off for everyone until step 8, except with a development flag on
   the host (`ORCH_AGENT_HOOKS=1`).
3. **Claude Code hooks.** The shim folder, the `claude` shim, the generated settings, `orch-agent-hook`, the version
   check, and answers to open questions 1 to 4, 6 and 7.
4. **Codex notify.** The `codex` shim and its `notify` mapping, and an answer to open question 5.
5. **Tab state.** The tab shows `working`, `waiting` or `idle`, with the reason and source in its tooltip.
6. **Sidebar counts.** Per-workspace counts per state.
7. **Notifications.** Hook transitions raise attention in the daemon, with the 2-second merge in `TerminalCore.raise`.
8. **Off switch and trust prompt.** The per-session switch in the record, the `agentTracking` client message, the
   ask-once notice and `agent-tracking.json`. This turns hook tracking on for users who say yes.
