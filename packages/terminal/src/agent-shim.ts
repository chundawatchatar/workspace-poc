import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { HOOK_PROGRAM } from './agent-shim-base'
import { AGENTS, type AgentAdapter } from './agents'

const ZSH_FILES = ['.zshenv', '.zprofile', '.zshrc', '.zlogin']

/**
 * Reports one fixed event and can't affect the agent: it gives up its stdin and
 * output first, sends only values from these lists, and always exits 0. The
 * token goes to `curl` as a config on stdin, because `printf` is a builtin and
 * arguments are visible in the process list. `-q` keeps out the user's `.curlrc`.
 * Each tracked agent adds its own branch of the `case`, which sets `agent`,
 * `state` and `reason`. What it leaves in the arguments, if more than one, is a
 * program to run after the report, without the session's variables.
 */
export function agentHookScript(agents: readonly AgentAdapter[] = AGENTS): string {
  const branches = agents.map((agent) => agent.tracking?.hookBranch ?? '').join('')
  return `#!/bin/sh
exec </dev/null >/dev/null 2>&1
case \${1:-} in
${branches}  *) exit 0 ;;
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
}

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
 * Writes the shim folder under `<runtime>/agent/` from the fixed contents of
 * `agents` and above, readable only by the user, and returns its `bin` folder.
 * Nothing here holds a token or a path from a project. It throws when the folder
 * can't be written.
 */
export function writeAgentShim(runtime: string, agents: readonly AgentAdapter[] = AGENTS): string {
  const root = join(runtime, 'agent')
  const bin = join(root, 'bin')
  const zsh = join(root, 'zsh')
  for (const dir of [root, bin, zsh, join(root, 'cache')]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }
  writeFile(join(bin, HOOK_PROGRAM), agentHookScript(agents), 0o700)
  for (const { tracking } of agents) {
    if (!tracking) continue
    writeFile(join(bin, tracking.program), tracking.shim, 0o700)
    for (const file of tracking.files ?? []) writeFile(join(root, file.name), file.contents, file.mode)
  }
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
