/** The name of the hook program, which also marks a `PATH` entry as a shim folder. */
export const HOOK_PROGRAM = 'orch-agent-hook'

/**
 * What every agent shim starts with: finding the real binary past its own
 * folder, handing a nested agent on without the session's variables, and the
 * `tracked` and `supports_flag` checks. `program` is the name on `PATH`, and
 * `kind` the key in the daemon's answer, which can differ.
 */
export const shimStart = (program: string, kind: string) => `#!/bin/sh
self_dir=$(CDPATH= cd -P -- "\${0%/*}" 2>/dev/null && pwd -P) || self_dir=
agent_dir=\${self_dir%/*}

real=
ifs=$IFS
IFS=:
set -f
for dir in $PATH; do
  [ -n "$dir" ] || continue
  [ -f "$dir/${program}" ] && [ -x "$dir/${program}" ] || continue
  [ "$(CDPATH= cd -P -- "$dir" 2>/dev/null && pwd -P)" != "$self_dir" ] || continue
  if [ "$dir/${program}" -ef "$0" ]; then continue; fi
  real=$dir/${program}
  break
done
set +f
IFS=$ifs

if [ -z "$real" ]; then
  printf '%s\\n' '${program}: command not found' >&2
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
  case $answer in *'"${kind}":true'*) return 0 ;; esac
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
