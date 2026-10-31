import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { AgentEvent } from './agent-channel'

/** The name of the hook program, which also marks a `PATH` entry as a shim folder. */
const HOOK_PROGRAM = 'orch-agent-hook'
const CLAUDE_SETTINGS = 'claude-settings.json'
const ZSH_FILES = ['.zshenv', '.zprofile', '.zshrc', '.zlogin']
/** How long Claude Code lets a hook run, in seconds. The hook itself gives up after one. */
const HOOK_TIMEOUT = 2

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
 */
export const AGENT_HOOK_SCRIPT = `#!/bin/sh
exec </dev/null >/dev/null 2>&1
case \${1:-} in claude) ;; *) exit 0 ;; esac
case \${2:-} in working|waiting|idle) ;; *) exit 0 ;; esac
case \${3:-} in started|prompt|tool|permission|question|finished|exited) ;; *) exit 0 ;; esac
case \${ORCH_AGENT_TOKEN:-} in ''|*[!a-f0-9]*) exit 0 ;; esac
[ -n "\${ORCH_AGENT_SOCKET:-}" ] || exit 0
printf 'header = "Authorization: Bearer %s"\\n' "$ORCH_AGENT_TOKEN" |
  curl -q --silent --config - --connect-timeout 0.2 --max-time 1 --output /dev/null \\
    --unix-socket "$ORCH_AGENT_SOCKET" --header 'Content-Type: application/json' \\
    --data "{\\"agent\\":\\"$1\\",\\"state\\":\\"$2\\",\\"reason\\":\\"$3\\"}" http://agent/v1/state
exit 0
`

/**
 * Runs the real Claude Code, adding the generated settings only when the daemon
 * wants them and nothing can conflict. Every other path ends in the same binary
 * with the user's arguments alone, so a failure here costs tracking, never
 * `claude`. It always leaves through `exec`, so the agent keeps this pid.
 */
export const CLAUDE_SHIM_SCRIPT = `#!/bin/sh
self_dir=$(CDPATH= cd -P -- "\${0%/*}" 2>/dev/null && pwd -P) || self_dir=
agent_dir=\${self_dir%/*}
settings=$agent_dir/${CLAUDE_SETTINGS}

real=
ifs=$IFS
IFS=:
set -f
for dir in $PATH; do
  [ -n "$dir" ] || continue
  [ -f "$dir/claude" ] && [ -x "$dir/claude" ] || continue
  [ "$(CDPATH= cd -P -- "$dir" 2>/dev/null && pwd -P)" != "$self_dir" ] || continue
  if [ "$dir/claude" -ef "$0" ]; then continue; fi
  real=$dir/claude
  break
done
set +f
IFS=$ifs

if [ -z "$real" ]; then
  printf '%s\\n' 'claude: command not found' >&2
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
  case $answer in *'"claude":true'*) return 0 ;; esac
  return 1
}

# Whether this binary has the flag, remembered per path and modification time. \`stat\` flags differ
# between GNU and BSD. Without a cache entry it just asks again.
supports_settings() {
  entry=
  mtime=$(stat -L -c %Y "$real" 2>/dev/null || stat -L -f %m "$real" 2>/dev/null) || mtime=
  if [ -n "$mtime" ]; then
    sum=$(printf '%s %s' "$real" "$mtime" | cksum 2>/dev/null) || sum=
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
    *--settings*) known=yes ;;
    *) known=no ;;
  esac
  if [ -n "$entry" ]; then { printf '%s\\n' "$known" >"$entry"; } 2>/dev/null; fi
  [ "$known" = yes ]
}

add_settings=yes
[ -z "\${TMUX:-}" ] && [ -z "\${STY:-}" ] || add_settings=
for arg do
  case $arg in --settings|--settings=*) add_settings= ;; esac
done
[ -f "$settings" ] || add_settings=
if [ -z "$add_settings" ] || ! tracked || ! supports_settings; then
  exec "$real" "$@"
fi

ORCH_AGENT_SHIMMED=1
export ORCH_AGENT_SHIMMED
exec "$real" --settings "$settings" "$@"
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
