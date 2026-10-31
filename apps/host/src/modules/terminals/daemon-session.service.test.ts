import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import type { AgentRef } from '@orch/shared'
import { type AgentTracking, DAEMON_PROTOCOL, DaemonDecoder, encodeControlFrame } from '@orch/terminal'
import type { DaemonRepository } from './daemon.repository'
import { DaemonSession } from './daemon-session.service'
import { agentTrackingFrom, type SharedDaemon } from './shared-daemon.service'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const status = {
  protocol: DAEMON_PROTOCOL,
  id: 't1',
  instance: 'a'.repeat(32),
  daemonPid: 10,
  pid: 11,
  alive: true,
  title: 'zsh',
  attention: null,
  progress: null,
  cols: 80,
  rows: 24,
}
const agent: AgentRef = { kind: 'claude', sessionId: null, cwd: '/repo' }
const found = (pid: number) => ({
  busy: true,
  cwd: '/repo',
  process: { pid, name: 'claude', command: 'claude', elapsed: 1 },
})

async function until(check: () => boolean) {
  for (let tries = 0; tries < 200 && !check(); tries++) await Bun.sleep(5)
  expect(check()).toBe(true)
}

/** A session attached to a fake daemon, which records every message and sends the statuses the test gives it. */
async function setup(tracking: AgentTracking) {
  const dir = mkdtempSync('/tmp/orch-session-')
  const received: { type: string; tracking?: unknown }[] = []
  let peer: Socket | undefined
  const server: Server = createServer((socket) => {
    peer = socket
    const decoder = new DaemonDecoder()
    socket.on('data', (chunk) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.kind !== 'control') continue
        received.push(frame.value as (typeof received)[number])
        if (received.length === 1) socket.write(encodeControlFrame({ type: 'snapshot', data: '', status }))
      }
    })
  })
  const path = join(dir, 'host.sock')
  await new Promise<void>((done) => server.listen(path, done))
  const repository = {
    socket: path,
    get: (id: string) => ({ id, token: crypto.randomUUID() }),
    update: (id: string) => ({ id, token: crypto.randomUUID() }),
  } as unknown as DaemonRepository
  const shared = { repository, tracking, heard() {}, ensureStarted: async () => {} } as unknown as SharedDaemon
  let changes = 0
  const session = new DaemonSession('t1', '/repo', 80, 24, () => changes++, shared)
  cleanups.push(() => {
    session.shutdown()
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })
  await until(() => session.pid === 11)
  const report = (patch: object) => peer?.write(encodeControlFrame({ type: 'status', status: { ...status, ...patch } }))
  return { session, received, report, changes: () => changes }
}

test('the flag alone turns tracking on, and hello carries it', async () => {
  expect(agentTrackingFrom({ ORCH_AGENT_HOOKS: '1' })).toEqual({ claude: true, codex: true })
  for (const env of [{}, { ORCH_AGENT_HOOKS: '0' }, { ORCH_AGENT_HOOKS: 'true' }]) {
    expect(agentTrackingFrom(env)).toEqual({ claude: false, codex: false })
  }
  const { received } = await setup({ claude: true, codex: true })
  expect(received[0]).toMatchObject({ type: 'hello', tracking: { claude: true, codex: true } })
})

test('the daemon hears agentExited when a known agent leaves or its process changes, and only then', async () => {
  const { session, received } = await setup({ claude: false, codex: false })
  const exits = () => received.filter((message) => message.type === 'agentExited').length
  session.observeAgent(null, false)
  session.observe(found(100) as never)
  session.observeAgent(agent, false)
  session.observeAgent(agent, false)
  await Bun.sleep(10)
  expect(exits()).toBe(0)

  session.observe(found(200) as never)
  session.observeAgent(agent, false)
  await until(() => exits() === 1)

  session.observe({ busy: false, cwd: '/repo' } as never)
  session.observeAgent(null, false)
  await until(() => exits() === 2)
  session.observeAgent(null, false)
  await Bun.sleep(10)
  expect(exits()).toBe(2)
})

test('a working hook turns interrupted once progress has ended and the wait is over, until the next hook event', async () => {
  const { session, report, changes } = await setup({ claude: true, codex: true })
  session.observe(found(100) as never)
  session.observeAgent(agent, false)
  const agentHook = { agent: 'claude', state: 'working', reason: 'tool', at: Date.now() - 10 }
  report({ agentHook, progress: 'busy' })
  await until(() => session.info().progress === 'busy')
  expect(session.info().agentState).toMatchObject({ reason: 'tool', source: 'hooks' })
  expect(Object.keys(session.info())).not.toContain('agentHook')
  const before = Date.now
  try {
    report({ agentHook, progress: null })
    await until(() => session.info().progress === null)
    expect(session.info().agentState).toMatchObject({ state: 'working', source: 'hooks' })
    const seen = changes()
    const later = before() + 3100
    Date.now = () => later
    expect(session.info().agentState).toMatchObject({ state: 'idle', reason: 'interrupted', source: 'signals' })
    Date.now = before
    report({ agentHook: { ...agentHook, at: later }, progress: null })
    await until(() => changes() > seen)
    Date.now = () => later + 1
    expect(session.info().agentState).toMatchObject({ state: 'working', reason: 'tool', source: 'hooks' })
  } finally {
    Date.now = before
  }
})
