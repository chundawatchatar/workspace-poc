import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { AgentChannel, type AgentTracking, agentEvent } from './agent-channel'
import { writeAgentShim } from './agent-shim'
import { shimStart } from './agent-shim-base'
import { deriveAgentState } from './agent-state'
import { AGENTS, type AgentAdapter } from './agents'

// The program differs from the kind on purpose: the shim searches for one and asks the daemon about the other.
const fake: AgentAdapter = {
  kind: 'fake' as AgentAdapter['kind'],
  exact: false,
  matches: (name) => name === 'fake-agent',
  idFromArgs: () => null,
  findSessionId: () => undefined,
  resumeCommand: () => 'fake-agent',
  tracking: {
    program: 'fake-agent',
    shim: `${shimStart('fake-agent', 'fake')}
if ! tracked || ! supports_flag --fake-flag; then
  exec "$real" "$@"
fi
ORCH_AGENT_SHIMMED=1
export ORCH_AGENT_SHIMMED
exec "$real" --fake-flag "$@"
`,
    hookBranch: `  fake)
    agent=fake state=waiting reason=question
    shift $#
    ;;
`,
  },
}
const agents = [...AGENTS, fake]
const on = { claude: false, codex: false, fake: true } as AgentTracking
const off = { claude: true, codex: false, fake: false } as AgentTracking

let root: string
let log: string
let stubs: string
let stop: () => void

/** A real channel on a Unix socket with the fake in its list, and one session with `tracking`. */
function setup(tracking: AgentTracking) {
  const runtime = join(root, 'run')
  mkdirSync(runtime)
  const bin = writeAgentShim(runtime, agents)
  const socket = join(runtime, 'agent.sock')
  const channel = new AgentChannel(
    () => {},
    () => {},
    Date.now,
    agents,
  )
  channel.open(socket, bin)
  channel.setTracking('s1', tracking)
  const token = channel.issue('s1')?.token ?? ''
  const server = Bun.serve({ unix: socket, development: false, fetch: (request) => channel.handle(request) })
  stop = () => server.stop(true)
  const env = { PATH: `${bin}:${stubs}:/usr/bin:/bin`, ORCH_AGENT_TOKEN: token, ORCH_AGENT_SOCKET: socket }
  return { bin, channel, token, env }
}

async function runFake(bin: string, env: Record<string, string>) {
  const proc = Bun.spawn(['/bin/sh', join(bin, 'fake-agent'), 'mine'], { env, cwd: root, stdin: 'ignore' })
  await proc.exited
  return readFileSync(log, 'utf8').trim().split('\n')
}

beforeEach(() => {
  // Not `tmpdir()`: on macOS its path can be too long for a Unix socket. `realpath`, because the shim resolves its folder.
  root = realpathSync(mkdtempSync('/tmp/orch-track-'))
  log = join(root, 'log')
  stubs = join(root, 'stubs')
  mkdirSync(stubs)
  stop = () => {}
  // The stub stands in for the agent: it advertises the flag, and with the flag it fires the hook as its own hooks would.
  writeFileSync(
    join(stubs, 'fake-agent'),
    `#!/bin/sh
case "$1" in --help) echo '  --fake-flag'; exit 0 ;; esac
echo "$*" >>"${log}"
if [ "$1" = --fake-flag ]; then orch-agent-hook fake; fi
`,
  )
  chmodSync(join(stubs, 'fake-agent'), 0o700)
})

afterEach(() => {
  stop()
  rmSync(root, { recursive: true, force: true })
})

describe('an agent added by one definition', () => {
  test('is shimmed, tracked and reported from that definition alone', async () => {
    const { bin, channel, token, env } = setup(on)
    expect(statSync(join(bin, 'fake-agent')).mode & 0o777).toBe(0o700)

    const session = await channel.handle(
      new Request('http://agent/v1/session', { headers: { authorization: `Bearer ${token}` } }),
    )
    expect(await session.text()).toContain('"fake":true')

    expect(await runFake(bin, env)).toEqual(['--fake-flag mine'])
    const hook = channel.hook('s1')
    expect(hook).toMatchObject({ agent: 'fake', state: 'waiting', reason: 'question' })

    const signals = {
      agent: { kind: fake.kind, sessionId: null, cwd: root },
      alive: true,
      interrupted: null,
      progress: null,
      attention: null,
      agentHook: hook,
    }
    expect(deriveAgentState(signals, null, Date.now(), agents)).toMatchObject({
      state: 'waiting',
      reason: 'question',
      source: 'hooks',
    })
  })

  test('passes through and is refused while it is off, though another agent is on', async () => {
    const { bin, channel, token, env } = setup(off)
    expect(await runFake(bin, env)).toEqual(['mine'])

    const response = await channel.handle(
      new Request('http://agent/v1/state', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent: 'fake', state: 'idle', reason: 'finished' }),
      }),
    )
    expect(response.status).toBe(400)
    expect(channel.hook('s1')).toBeNull()
  })

  test('does not exist for the default list', () => {
    expect(agentEvent.safeParse({ agent: 'fake', state: 'idle', reason: 'finished' }).success).toBe(false)
    const bin = writeAgentShim(root)
    expect(existsSync(join(bin, 'fake-agent'))).toBe(false)
  })
})
