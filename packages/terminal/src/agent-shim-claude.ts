import type { AgentEvent } from './agent-channel'
import { HOOK_PROGRAM, shimStart } from './agent-shim-base'
import type { AgentTracker } from './agent-tracker'

const CLAUDE_SETTINGS = 'claude-settings.json'
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
 * Runs the real Claude Code, adding the generated settings only when the daemon
 * wants them and nothing can conflict. Every other path ends in the same binary
 * with the user's arguments alone, so a failure here costs tracking, never
 * `claude`. It always leaves through `exec`, so the agent keeps this pid.
 */
export const CLAUDE_SHIM_SCRIPT = `${shimStart('claude', 'claude')}
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

/** The hook's form takes a state and a reason, each checked against the values Claude Code's settings can send. */
const HOOK_BRANCH = `  claude)
    case \${2:-} in working|waiting|idle) ;; *) exit 0 ;; esac
    case \${3:-} in started|prompt|tool|permission|question|finished|exited) ;; *) exit 0 ;; esac
    agent=claude state=$2 reason=$3
    shift $#
    ;;
`

/** How Claude Code is tracked: `--settings` adds hooks for one run, and they report every state. */
export const claudeTracking: AgentTracker = {
  program: 'claude',
  shim: CLAUDE_SHIM_SCRIPT,
  hookBranch: HOOK_BRANCH,
  files: [{ name: CLAUDE_SETTINGS, contents: claudeSettings(), mode: 0o600 }],
}
