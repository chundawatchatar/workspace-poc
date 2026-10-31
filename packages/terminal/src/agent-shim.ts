import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { AgentEvent } from './agent-channel'

/** The name of the hook program, which also marks a `PATH` entry as a shim folder. */
const HOOK_PROGRAM = 'orch-agent-hook'
const CLAUDE_SETTINGS = 'claude-settings.json'
const ZSH_FILES = ['.zshenv', '.zprofile', '.zshrc', '.zlogin']
/** How long Claude Code lets a hook run, in seconds. The hook itself gives up after one. */
const HOOK_TIMEOUT = 2
/** Asks Codex to ring the bell for an approval and nothing else, since a bell after each turn would read as waiting. */
const CODEX_APPROVAL_FLAGS = [
  'tui.notifications=["approval-requested"]',
  'tui.notification_method="bel"',
  'tui.notification_condition="always"',
]

/** The hooks added to Claude Code, in order: event, matcher, and what each one reports. */
const CLAUDE_HOOKS: [event: string, matcher: string | null, AgentEvent['state'], AgentEvent['reason']][] = [
  ['SessionStart', 'startup|resume|clear', 'idle', 'started'],
  ['UserPromptSubmit', null, 'working', 'prompt'],
  ['PreToolUse', 'AskUserQuestion', 'waiting', 'question'],
  ['PreToolUse', '*', 'working', 'tool'],
  ['PostToolUse', '*', 'working', 'tool'],
  ['Notification', 'permission_prompt', 'waiting', 'permission'],
  ['Notification', 'elicitation_dialog', 'waiting', 'question'],
  ['Notification', 'idle_prompt', 'waiting', 'question'],
  ['Stop', null, 'idle', 'finished'],
  ['SessionEnd', null, 'idle', 'exited'],
]

/** The settings file passed to Claude Code with `--settings`. It adds hooks and nothing else. */
export function claudeSettings(): string {
  const hooks: Record<string, unknown[]> = {}
  for (const [event, matcher, state, reason] of CLAUDE_HOOKS) {
    const entry = { type: 'command', command: `${HOOK_PROGRAM} claude ${state} ${reason}`, timeout: HOOK_TIMEOUT }
    hooks[event] ??= []
    hooks[event].push({ ...(matcher === null ? {} : { matcher }), hooks: [entry] })
  }
  return `${JSON.stringify({ hooks }, null, 2)}\n`
}

/**
 * Reports one fixed event and can't affect the agent: it gives up its stdin and
 * output first, sends only values from these lists, and always exits 0. The
 * token goes to `curl` as a config on stdin, because `printf` is a builtin and
 * arguments are visible in the process list. `-q` keeps out the user's `.curlrc`.
 * The `codex` form treats what follows as opaque: the last argument is Codex's
 * JSON, and anything before it is the user's own `notify`, which gets all of it
 * after the report, without the session's variables.
 */
export const AGENT_HOOK_SCRIPT = `#!/bin/sh
exec </dev/null >/dev/null 2>&1
case \${1:-} in
  claude)
    case \${2:-} in working|waiting|idle) ;; *) exit 0 ;; esac
    case \${3:-} in started|prompt|tool|permission|question|finished|exited) ;; *) exit 0 ;; esac
    agent=claude state=$2 reason=$3
    shift $#
    ;;
  codex)
    agent=codex state=idle reason=finished
    shift
    ;;
  *) exit 0 ;;
esac
case \${ORCH_AGENT_TOKEN:-} in
  ''|*[!a-f0-9]*) ;;
  *)
    if [ -n "\${ORCH_AGENT_SOCKET:-}" ]; then
      printf 'header = "Authorization: Bearer %s"\\n' "$ORCH_AGENT_TOKEN" |
        curl -q --silent --config - --connect-timeout 0.2 --max-time 1 --output /dev/null \\
          --unix-socket "$ORCH_AGENT_SOCKET" --header 'Content-Type: application/json' \\
          --data "{\\"agent\\":\\"$agent\\",\\"state\\":\\"$state\\",\\"reason\\":\\"$reason\\"}" http://agent/v1/state
    fi
    ;;
esac
[ "$#" -gt 1 ] || exit 0
unset ORCH_AGENT_TOKEN ORCH_AGENT_SOCKET ORCH_AGENT_SHIMMED
"$@"
exit 0
`

/**
 * What every agent shim starts with: finding the real binary past its own
 * folder, handing a nested agent on without the session's variables, and the
 * `tracked` and `supports_flag` checks.
 */
const shimStart = (agent: string) => `#!/bin/sh
self_dir=$(CDPATH= cd -P -- "\${0%/*}" 2>/dev/null && pwd -P) || self_dir=
agent_dir=\${self_dir%/*}

real=
ifs=$IFS
IFS=:
set -f
for dir in $PATH; do
  [ -n "$dir" ] || continue
  [ -f "$dir/${agent}" ] && [ -x "$dir/${agent}" ] || continue
  [ "$(CDPATH= cd -P -- "$dir" 2>/dev/null && pwd -P)" != "$self_dir" ] || continue
  if [ "$dir/${agent}" -ef "$0" ]; then continue; fi
  real=$dir/${agent}
  break
done
set +f
IFS=$ifs

if [ -z "$real" ]; then
  printf '%s\\n' '${agent}: command not found' >&2
  exit 127
fi

# A nested agent, started by an agent, must never report as the outer one.
if [ -n "\${ORCH_AGENT_SHIMMED:-}" ]; then
  unset ORCH_AGENT_TOKEN ORCH_AGENT_SOCKET
  exec "$real" "$@"
fi

# Whether the daemon wants hooks for this session. Anything but a quick yes is a no.
tracked() {
  case \${ORCH_AGENT_TOKEN:-} in ''|*[!a-f0-9]*) return 1 ;; esac
  [ -n "\${ORCH_AGENT_SOCKET:-}" ] || return 1
  command -v curl >/dev/null 2>&1 || return 1
  answer=$(printf 'header = "Authorization: Bearer %s"\\n' "$ORCH_AGENT_TOKEN" |
    curl -q --silent --config - --max-time 0.2 --unix-socket "$ORCH_AGENT_SOCKET" \\
      http://agent/v1/session 2>/dev/null)
  case $answer in *'"${agent}":true'*) return 0 ;; esac
  return 1
}

# Whether this binary has the flag, remembered per path, modification time and flag. \`stat\` flags
# differ between GNU and BSD. Without a cache entry it just asks again.
supports_flag() {
  entry=
  mtime=$(stat -L -c %Y "$real" 2>/dev/null || stat -L -f %m "$real" 2>/dev/null) || mtime=
  if [ -n "$mtime" ]; then
    sum=$(printf '%s %s %s' "$real" "$mtime" "$1" | cksum 2>/dev/null) || sum=
    if [ -n "$sum" ]; then entry=$agent_dir/cache/\${sum%% *}-\${sum##* }; fi
  fi
  known=
  if [ -n "$entry" ] && [ -r "$entry" ]; then IFS= read -r known <"$entry" || known=; fi
  case $known in
    yes) return 0 ;;
    no) return 1 ;;
  esac
  help=$("$real" --help 2>/dev/null </dev/null) || return 1
  case $help in
    *"$1"*) known=yes ;;
    *) known=no ;;
  esac
  if [ -n "$entry" ]; then { printf '%s\\n' "$known" >"$entry"; } 2>/dev/null; fi
  [ "$known" = yes ]
}
`

/**
 * Runs the real Claude Code, adding the generated settings only when the daemon
 * wants them and nothing can conflict. Every other path ends in the same binary
 * with the user's arguments alone, so a failure here costs tracking, never
 * `claude`. It always leaves through `exec`, so the agent keeps this pid.
 */
export const CLAUDE_SHIM_SCRIPT = `${shimStart('claude')}
settings=$agent_dir/${CLAUDE_SETTINGS}
add_settings=yes
[ -z "\${TMUX:-}" ] && [ -z "\${STY:-}" ] || add_settings=
for arg do
  case $arg in --settings|--settings=*) add_settings= ;; esac
done
[ -f "$settings" ] || add_settings=
if [ -z "$add_settings" ] || ! tracked || ! supports_flag --settings; then
  exec "$real" "$@"
fi

ORCH_AGENT_SHIMMED=1
export ORCH_AGENT_SHIMMED
exec "$real" --settings "$settings" "$@"
`

/**
 * Runs the real Codex with `notify` pointing at the hook, which chains to the
 * user's own `notify`, and with a bell for approvals, on this command line
 * alone. `-c notify=...` replaces the configured value, so the user's array has
 * to be read from their config. There is no TOML parser here, so the reader takes
 * one exact form and anything else that mentions the key passes through: losing
 * tracking is always better than silently losing the user's `notify`.
 */
export const CODEX_SHIM_SCRIPT = `${shimStart('codex')}
config=\${CODEX_HOME:-\${HOME:-}/.codex}/config.toml
edge='[][:space:].,={"'"'"'[}]'
user_notify=
add_tui=yes

trim() {
  trimmed=\${1#"\${1%%[![:space:]]*}"}
  trimmed=\${trimmed%"\${trimmed##*[![:space:]]}"}
}

# Whether the text holds the word as a key could, so not inside a path or a longer name.
mentions() {
  case .$1. in *\${edge}$2\${edge}*) return 0 ;; esac
  return 1
}

# Whether the text is only single-line TOML strings and commas. A backslash in a basic string fails,
# which also stops an escaped quote from hiding the end of a string.
plain_strings() {
  trim "$1"
  rest=$trimmed
  while [ -n "$rest" ]; do
    case $rest in
      \\"*) quote=\\" ;;
      \\'*) quote=\\' ;;
      *) return 1 ;;
    esac
    rest=\${rest#?}
    case $rest in *"$quote"*) ;; *) return 1 ;; esac
    case $quote\${rest%%"$quote"*} in \\"*\\\\*) return 1 ;; esac
    rest=\${rest#*"$quote"}
    trim "$rest"
    rest=$trimmed
    case $rest in
      '') ;;
      ,*)
        trim "\${rest#,}"
        rest=$trimmed
        [ -n "$rest" ] || return 0
        ;;
      *) return 1 ;;
    esac
  done
}

# Reads the user's config, failing when a \`notify\` isn't the one form taken for certain. A \`[\` line ends
# the top level, and three quotes may start a multi-line string, where a line isn't what it looks like.
read_config() {
  table=
  long=
  found=
  while IFS= read -r line || [ -n "$line" ]; do
    trim "$line"
    line=$trimmed
    case $line in
      ''|'#'*) continue ;;
      '['*) table=yes ;;
    esac
    case $line in *'"""'*|*"'''"*) long=yes ;; esac
    for key in notifications notification_method notification_condition; do
      if mentions "$line" "$key"; then add_tui=; fi
    done
    mentions "$line" notify || continue
    [ -z "$table$long$found" ] || return 1
    case $line in notify*) ;; *) return 1 ;; esac
    trim "\${line#notify}"
    case $trimmed in =*) ;; *) return 1 ;; esac
    trim "\${trimmed#=}"
    case $trimmed in \\[*\\]) ;; *) return 1 ;; esac
    value=\${trimmed#?}
    value=\${value%?}
    plain_strings "$value" || return 1
    trim "$value"
    user_notify=$trimmed
    found=yes
  done <"$1"
}

# Whether a project's config, from here upward, leaves \`notify\` alone. The user's own config isn't a project's.
projects_clear() {
  dir=$(pwd -P) || return 1
  while :; do
    file=$dir/.codex/config.toml
    if { [ -e "$file" ] || [ -L "$file" ]; } && ! [ "$file" -ef "$config" ]; then
      [ -f "$file" ] && [ -r "$file" ] || return 1
      while IFS= read -r line || [ -n "$line" ]; do
        trim "$line"
        case $trimmed in '#'*) continue ;; esac
        if mentions "$trimmed" notify; then return 1; fi
      done <"$file" || return 1
    fi
    [ -n "$dir" ] && [ "$dir" != / ] || return 0
    dir=\${dir%/*}
  done
}

# Whether the user's arguments choose a \`notify\`, or another config or machine that could.
arguments_clear() {
  next=
  for arg do
    if [ -n "$next" ]; then
      next=
      if mentions "\${arg%%=*}" notify; then return 1; fi
      continue
    fi
    case $arg in
      -c|--config) next=yes ;;
      --config=*)
        arg=\${arg#--config=}
        if mentions "\${arg%%=*}" notify; then return 1; fi
        ;;
      -c*)
        arg=\${arg#-c}
        if mentions "\${arg%%=*}" notify; then return 1; fi
        ;;
      -p*|--profile|--profile=*|-C*|--cd|--cd=*|--remote|--remote=*) return 1 ;;
    esac
  done
}

can_attach() {
  [ -z "\${TMUX:-}" ] && [ -z "\${STY:-}" ] || return 1
  case $self_dir in ''|*[\\"\\\\[:cntrl:]]*) return 1 ;; esac
  [ -n "\${CODEX_HOME:-\${HOME:-}}" ] || return 1
  arguments_clear "$@" || return 1
  if [ -e "$config" ] || [ -L "$config" ]; then
    [ -f "$config" ] && [ -r "$config" ] && read_config "$config" || return 1
  fi
  projects_clear
}

if ! can_attach "$@" || ! tracked || ! supports_flag --config; then
  exec "$real" "$@"
fi

if [ -n "$add_tui" ]; then
  set -- -c '${CODEX_APPROVAL_FLAGS[0]}' -c '${CODEX_APPROVAL_FLAGS[1]}' -c '${CODEX_APPROVAL_FLAGS[2]}' "$@"
fi
set -- -c "notify=[\\"$self_dir/${HOOK_PROGRAM}\\",\\"codex\\"\${user_notify:+,$user_notify}]" "$@"
ORCH_AGENT_SHIMMED=1
export ORCH_AGENT_SHIMMED
exec "$real" "$@"
`

/** The first step of every startup file but `.zshenv`: the user's own value is in place while their file runs. */
const ZSH_RESTORE = `if [[ -n \${_orch_user_zdotdir+x} ]]; then ZDOTDIR=$_orch_user_zdotdir; else builtin unset ZDOTDIR; fi
if [[ \${HISTFILE-} == "$_orch_wrapper"/* ]]; then HISTFILE=\${ZDOTDIR:-$HOME}/.zsh_history; fi
`
/** Sends zsh back to the wrapper for its next startup file, remembering the value the user's file left. */
const ZSH_CONTINUE = `if [[ -n \${ZDOTDIR+x} ]]; then _orch_user_zdotdir=$ZDOTDIR; else builtin unset _orch_user_zdotdir; fi
ZDOTDIR=$_orch_wrapper
`
/** The last step: the shim folder goes first again, and the wrapper leaves no trace at the prompt. */
const ZSH_FINISH = `_orch_bin=\${_orch_wrapper%/zsh}/bin
path=("$_orch_bin" "\${path[@]:#\${(b)_orch_bin}}")
builtin unset _orch_wrapper _orch_user_zdotdir _orch_bin
`
const zshSource = (file: string) =>
  `if [[ -r \${ZDOTDIR:-$HOME}/${file} ]]; then builtin source "\${ZDOTDIR:-$HOME}/${file}"; fi\n`

/**
 * The zsh startup files. Login shells and the user's own startup files reorder
 * `PATH`, so these source the user's files unchanged and then put the shim
 * folder first again. A variable, not a file, carries the user's `ZDOTDIR`, and
 * zsh rereads `ZDOTDIR` before each file, so it holds the wrapper only in the
 * gaps between them. macOS's `/etc/zshrc` runs in such a gap and derives
 * `HISTFILE` from it, which `ZSH_RESTORE` puts right.
 */
export const ZSH_WRAPPER: Record<string, string> = {
  '.zshenv': `_orch_wrapper=$ZDOTDIR
builtin unset ZDOTDIR
${zshSource('.zshenv')}if [[ -o rcs ]] && [[ -o login || -o interactive ]]; then
${ZSH_CONTINUE}else
${ZSH_FINISH}fi
`,
  '.zprofile': `${ZSH_RESTORE}${zshSource('.zprofile')}${ZSH_CONTINUE}`,
  '.zshrc': `${ZSH_RESTORE}${zshSource('.zshrc')}if [[ -o login ]]; then
${ZSH_CONTINUE}else
${ZSH_FINISH}fi
`,
  '.zlogin': `${ZSH_RESTORE}${zshSource('.zlogin')}${ZSH_FINISH}`,
}

/** Replaces a file whole, since a running `sh` reads its script as it goes. */
function writeFile(path: string, contents: string, mode: number) {
  const temporary = `${path}.${process.pid}`
  writeFileSync(temporary, contents, { mode })
  chmodSync(temporary, mode)
  renameSync(temporary, path)
}

/**
 * Writes the shim folder under `<runtime>/agent/` from the fixed contents above,
 * readable only by the user, and returns its `bin` folder. Nothing here holds a
 * token or a path from a project. It throws when the folder can't be written.
 */
export function writeAgentShim(runtime: string): string {
  const root = join(runtime, 'agent')
  const bin = join(root, 'bin')
  const zsh = join(root, 'zsh')
  for (const dir of [root, bin, zsh, join(root, 'cache')]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }
  writeFile(join(root, CLAUDE_SETTINGS), claudeSettings(), 0o600)
  writeFile(join(bin, HOOK_PROGRAM), AGENT_HOOK_SCRIPT, 0o700)
  writeFile(join(bin, 'claude'), CLAUDE_SHIM_SCRIPT, 0o700)
  writeFile(join(bin, 'codex'), CODEX_SHIM_SCRIPT, 0o700)
  for (const [name, contents] of Object.entries(ZSH_WRAPPER)) writeFile(join(zsh, name), contents, 0o600)
  return bin
}

/** Writes the shim folder for the daemon. Shells work without it: a failure only means their `PATH` stays as it was. */
export function prepareAgentShim(runtime: string): string | null {
  try {
    return writeAgentShim(runtime)
  } catch (error) {
    console.error('ptyd-bun: the agent shim is off', error instanceof Error ? error.message : 'unknown error')
    return null
  }
}

/** True when a `PATH` entry is a shim folder, wherever its runtime directory is. */
export function isShimFolder(dir: string): boolean {
  return existsSync(join(dir, HOOK_PROGRAM))
}

/**
 * The `ZDOTDIR` that wraps a zsh with this shim folder, or null for another
 * shell. It is null too when a wrapper file has gone, for example cleaned from
 * `/tmp`, because zsh would then skip the user's own startup files.
 */
export function zshWrapperFor(shell: string, shimDir: string): string | null {
  if (basename(shell) !== 'zsh') return null
  const wrapper = join(dirname(shimDir), 'zsh')
  return ZSH_FILES.every((file) => existsSync(join(wrapper, file))) ? wrapper : null
}
