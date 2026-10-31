import { HOOK_PROGRAM, shimStart } from './agent-shim-base'
import type { AgentTracker } from './agent-tracker'

/**
 * The most the Codex shim reads, in bytes across all config files and per line.
 * A project's file is untrusted, the shell's trimming is quadratic in a line's
 * length, and all this runs before the agent starts, so anything larger passes through.
 */
const CODEX_CONFIG_LIMIT = 65536
const CODEX_LINE_LIMIT = 4096
/** Asks Codex to ring the bell for an approval and nothing else, since a bell after each turn would read as waiting. */
const CODEX_APPROVAL_FLAGS = [
  'tui.notifications=["approval-requested"]',
  'tui.notification_method="bel"',
  'tui.notification_condition="always"',
]

/**
 * Runs the real Codex with `notify` pointing at the hook, which chains to the
 * user's own `notify`, and with a bell for approvals, on this command line
 * alone. `-c notify=...` replaces the configured value, so the user's array has
 * to be read from their config. There is no TOML parser here, so the reader takes
 * one exact form and anything else that mentions the key passes through: losing
 * tracking is always better than silently losing the user's `notify`.
 */
export const CODEX_SHIM_SCRIPT = `${shimStart('codex', 'codex')}
config=\${CODEX_HOME:-\${HOME:-}/.codex}/config.toml
edge='[][:space:].,={"'"'"'[}]'
user_notify=
add_tui=yes
total=0

trim() {
  trimmed=\${1#"\${1%%[![:space:]]*}"}
  trimmed=\${trimmed%"\${trimmed##*[![:space:]]}"}
}

# Whether a config is a plain file, and small enough with those before it to read before the agent starts.
# It counts by reading no more than the limit, since a proc file reports size 0 and can be endless. A
# pipeline only gives \`wc\`'s status, so \`head\` reports its own on fd 3, and a failed read isn't an empty file.
# Nothing through a link is refused too: \`/proc/self\` files opened before \`exec\` read as empty, then fail \`read\`.
readable() {
  [ -f "$1" ] && [ -r "$1" ] || return 1
  counted=$({ { head -c ${CODEX_CONFIG_LIMIT + 1} <"$1" 2>/dev/null; echo "read=$?" >&3; } | wc -c 2>/dev/null; } 3>&1) || return 1
  case $counted in *read=0*) ;; *) return 1 ;; esac
  trim "\${counted%%read=0*}\${counted#*read=0}"
  [ "$trimmed" -le ${CODEX_CONFIG_LIMIT} ] 2>/dev/null || return 1
  if [ "$trimmed" -eq 0 ] && [ -L "$1" ]; then return 1; fi
  total=$((total + trimmed))
  [ "$total" -le ${CODEX_CONFIG_LIMIT} ]
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
    [ "\${#line}" -le ${CODEX_LINE_LIMIT} ] || return 1
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
      readable "$file" || return 1
      while IFS= read -r line || [ -n "$line" ]; do
        [ "\${#line}" -le ${CODEX_LINE_LIMIT} ] || return 1
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
        arg=\${arg#=}
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
    readable "$config" && read_config "$config" || return 1
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

/**
 * The hook's form treats what follows as opaque: the last argument is Codex's
 * JSON, and anything before it is the user's own `notify`, which gets all of it
 * after the report.
 */
const HOOK_BRANCH = `  codex)
    agent=codex state=idle reason=finished
    shift
    ;;
`

/** How Codex is tracked: `notify` runs once a turn ends, so hooks only ever say that. */
export const codexTracking: AgentTracker = {
  program: 'codex',
  shim: CODEX_SHIM_SCRIPT,
  hookBranch: HOOK_BRANCH,
  turnEndOnly: true,
}
